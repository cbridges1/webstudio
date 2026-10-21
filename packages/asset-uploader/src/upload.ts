import {
  type AppContext,
  authorizeProject,
  AuthorizationError,
  getProjectPlanFeatures,
} from "@webstudio-is/trpc-interface/index.server";
import { createHash } from "node:crypto";
import {
  createId as createSdkId,
  getFileExtension,
  getFileNameParts,
  type Asset,
} from "@webstudio-is/sdk";
import {
  and,
  asc,
  asset as assetTable,
  eq,
  file as fileTable,
  gt,
  isNull,
  isUniqueViolation,
  maybeOne,
  sql,
  unwrapDbError,
  type Database,
} from "@webstudio-is/db";
import type { AssetInfoFallback, AssetObjectWriter } from "./client";
import type { AssetDataOverride } from "./utils/get-asset-data";
import { createUniqueAssetFilename } from "./utils/get-unique-filename";
import { sanitizeS3Key } from "./utils/sanitize-s3-key";
import { formatAsset, formatAssetForRead } from "./utils/format-asset";
import type { UploadTicket } from "./types";

export type CreateUploadTicketInput = {
  projectId: string;
  type: string;
  filename: string;
  displayFilename?: string;
  description?: string;
  folderId?: string;
  contentHash?: string;
};

export class AssetUploadCountLimitError extends Error {
  constructor(maxAssetsPerProject: number) {
    super(
      `The maximum number of assets per project is ${maxAssetsPerProject}.`
    );
  }
}

const UPLOADING_STALE_TIMEOUT = 1000 * 60 * 30; // 30 minutes
const maxCreateUploadTicketAttempts = 3;
const contentHashUploadPollInterval = 100;
const contentHashUploadPollAttempts = 50;

type AssetIdentity = {
  filename: string;
  description: string | null;
  folderId: string | null;
};

const getDeduplicatedAssetId = (
  projectId: string,
  name: string,
  identity: AssetIdentity
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        projectId,
        name,
        identity.filename,
        identity.description,
        identity.folderId,
      ])
    )
    .digest("base64url")
    .slice(0, 21);

/** The database's message for a failed query, without the SQL. */
const toDbError = (error: unknown) => {
  const cause = unwrapDbError(error);
  return new Error(cause instanceof Error ? cause.message : String(cause));
};

const assertAssetCapacity = async (projectId: string, context: AppContext) => {
  const { maxAssetsPerProject } = await getProjectPlanFeatures(
    projectId,
    context
  );
  const [{ count: assetCount }] = await context.db
    .select({ count: sql<number>`count(*)::int` })
    .from(assetTable)
    .innerJoin(fileTable, eq(fileTable.name, assetTable.name))
    .where(
      and(eq(assetTable.projectId, projectId), eq(fileTable.status, "UPLOADED"))
    );
  const uploadingCount = await context.db.$count(
    fileTable,
    and(
      eq(fileTable.isDeleted, false),
      eq(fileTable.uploaderProjectId, projectId),
      eq(fileTable.status, "UPLOADING"),
      gt(
        fileTable.createdAt,
        new Date(Date.now() - UPLOADING_STALE_TIMEOUT).toISOString()
      )
    )
  );
  const count = assetCount + uploadingCount;
  if (count >= maxAssetsPerProject) {
    throw new AssetUploadCountLimitError(maxAssetsPerProject);
  }
};

const findAsset = async ({
  projectId,
  name,
  identity,
  context,
}: {
  projectId: string;
  name: string;
  identity?: AssetIdentity;
  context: AppContext;
}) => {
  const rows = await context.db
    .select({
      id: assetTable.id,
      projectId: assetTable.projectId,
      filename: assetTable.filename,
      description: assetTable.description,
      folderId: assetTable.folderId,
    })
    .from(assetTable)
    .where(
      and(
        eq(assetTable.projectId, projectId),
        eq(assetTable.name, name),
        ...(identity === undefined
          ? []
          : [
              eq(assetTable.filename, identity.filename),
              identity.description === null
                ? isNull(assetTable.description)
                : eq(assetTable.description, identity.description),
              identity.folderId === null
                ? isNull(assetTable.folderId)
                : eq(assetTable.folderId, identity.folderId),
            ])
      )
    )
    .orderBy(asc(assetTable.id))
    .limit(1)
    .catch((error) => {
      throw toDbError(error);
    });
  return rows[0];
};

const getContentDeduplicationExtension = (filename: string) =>
  getFileExtension(filename)?.toLowerCase() ?? "";

const findFileByContent = async ({
  projectId,
  contentHash,
  filename,
  context,
}: {
  projectId: string;
  contentHash: string;
  filename: string;
  context: AppContext;
}) => {
  const files = await context.db
    .select()
    .from(fileTable)
    .where(
      and(
        eq(fileTable.uploaderProjectId, projectId),
        eq(fileTable.contentHash, contentHash)
      )
    )
    .catch((error) => {
      throw toDbError(error);
    });
  const extension = getContentDeduplicationExtension(filename);
  return files.find(
    (file) => getContentDeduplicationExtension(file.name) === extension
  );
};

const findContentHashUploadTicket = async ({
  data,
  context,
}: {
  data: CreateUploadTicketInput & { contentHash: string };
  context: AppContext;
}): Promise<UploadTicket | undefined> => {
  const {
    projectId,
    contentHash,
    filename,
    displayFilename = getFileNameParts(filename).basename,
    description,
    folderId,
  } = data;
  const assetIdentity: AssetIdentity = {
    filename: displayFilename,
    description: description ?? null,
    folderId: folderId ?? null,
  };
  for (let attempt = 0; attempt < contentHashUploadPollAttempts; attempt += 1) {
    const file = await findFileByContent({
      projectId,
      contentHash,
      filename,
      context,
    });
    if (file === undefined) {
      return;
    }
    if (file.status === "UPLOADED") {
      const existingAsset = await findAsset({
        projectId,
        name: file.name,
        identity: assetIdentity,
        context,
      });
      let asset = existingAsset ?? {
        id: getDeduplicatedAssetId(projectId, file.name, assetIdentity),
        projectId,
        ...assetIdentity,
      };
      const { asset: formattedAsset, fontMetaIssues } = formatAssetForRead({
        assetId: asset.id,
        projectId: asset.projectId,
        filename: asset.filename,
        description: asset.description,
        folderId: asset.folderId,
        file,
      });
      if (fontMetaIssues !== undefined) {
        // Keep existing references, but free the unique content hash so a new
        // upload can parse valid metadata instead of reusing the broken file.
        const excludedFile = maybeOne(
          await context.db
            .update(fileTable)
            .set({ contentHash: null })
            .where(
              and(
                eq(fileTable.name, file.name),
                eq(fileTable.uploaderProjectId, projectId),
                eq(fileTable.contentHash, contentHash),
                eq(fileTable.status, "UPLOADED"),
                eq(fileTable.format, file.format),
                eq(fileTable.meta, file.meta)
              )
            )
            .returning({ name: fileTable.name })
        );
        if (excludedFile === null) {
          // Another request changed the file; reconsider its current metadata.
          continue;
        }
        return;
      }
      if (existingAsset === undefined) {
        await assertAssetCapacity(projectId, context);
        try {
          await context.db
            .insert(assetTable)
            .values({ ...asset, name: file.name });
        } catch (error) {
          if (isUniqueViolation(error) === false) {
            throw error;
          }
          const concurrentAsset = await findAsset({
            projectId,
            name: file.name,
            identity: assetIdentity,
            context,
          });
          if (concurrentAsset === undefined) {
            throw new Error("Concurrent deduplicated asset is missing.");
          }
          asset = concurrentAsset;
        }
      }
      if (file.isDeleted) {
        await context.db
          .update(fileTable)
          .set({ isDeleted: false })
          .where(
            and(
              eq(fileTable.name, file.name),
              eq(fileTable.uploaderProjectId, projectId)
            )
          );
      }
      return {
        assetId: asset.id,
        name: file.name,
        deduplicated: true,
        asset: { ...formattedAsset, id: asset.id },
      };
    }
    if (
      new Date(file.createdAt).getTime() <
      Date.now() - UPLOADING_STALE_TIMEOUT
    ) {
      await context.db
        .delete(assetTable)
        .where(
          and(
            eq(assetTable.projectId, projectId),
            eq(assetTable.name, file.name)
          )
        );
      await context.db.delete(fileTable).where(eq(fileTable.name, file.name));
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, contentHashUploadPollInterval)
    );
  }
  throw new Error(
    "An identical asset upload is still in progress. Retry after it completes."
  );
};

export type UploadErrorCleanup = (
  name: string,
  context: AppContext
) => Promise<void>;

const cleanupUploadError = async (
  name: string,
  context: AppContext,
  onUploadError?: UploadErrorCleanup
) => {
  if (onUploadError) {
    await onUploadError(name, context);
    return;
  }
  await context.db.delete(assetTable).where(eq(assetTable.name, name));
  await context.db.delete(fileTable).where(eq(fileTable.name, name));
};

export const createUploadTicket = async (
  data: CreateUploadTicketInput,
  context: AppContext,
  createId: () => Asset["id"] = () => createSdkId("nano")
): Promise<UploadTicket> => {
  const {
    projectId,
    type,
    filename,
    displayFilename = getFileNameParts(filename).basename,
    description,
    folderId,
    contentHash,
  } = data;
  const sanitizedFilename = sanitizeS3Key(filename);
  const canEdit = await authorizeProject.hasProjectPermit(
    { projectId, permit: "edit" },
    context
  );
  if (canEdit === false) {
    throw new AuthorizationError(
      "You don't have access to create this project assets"
    );
  }

  if (contentHash !== undefined) {
    const existing = await findContentHashUploadTicket({
      data: { ...data, contentHash },
      context,
    });
    if (existing !== undefined) {
      return existing;
    }
  }

  await assertAssetCapacity(projectId, context);

  /**
   * Create a temporary "UPLOADING" asset, so it can be counted in the next query
   * Assumptions:
   * - it's possible to create more assets than maxAssetsPerProject,
   *   but for now we assume that the time since the `count` query above and the `create` query below is negligible,
   *   and some kind of rate limiting exists on API.
   * No row lock is taken for this.
   **/
  for (
    let attempt = 1;
    attempt <= maxCreateUploadTicketAttempts;
    attempt += 1
  ) {
    const assetId = createId();
    const name = createUniqueAssetFilename(sanitizedFilename);

    try {
      await context.db.insert(fileTable).values({
        name,
        status: "UPLOADING",
        // store content type in related field
        format: type,
        size: 0,
        uploaderProjectId: projectId,
        contentHash,
      });
    } catch (error) {
      if (isUniqueViolation(error) && contentHash !== undefined) {
        const existing = await findContentHashUploadTicket({
          data: { ...data, contentHash },
          context,
        });
        if (existing !== undefined) {
          return existing;
        }
      }
      throw toDbError(error);
    }

    try {
      await context.db.insert(assetTable).values({
        id: assetId,
        projectId,
        name,
        filename: displayFilename,
        description,
        folderId,
      });
    } catch (error) {
      await context.db.delete(fileTable).where(eq(fileTable.name, name));
      if (isUniqueViolation(error) && attempt < maxCreateUploadTicketAttempts) {
        continue;
      }
      throw toDbError(error);
    }

    return { assetId, name, deduplicated: false };
  }

  throw new Error("Unable to reserve asset upload.");
};

export const uploadFileData = async (
  name: string,
  data: ReadableStream<Uint8Array>,
  client: AssetObjectWriter,
  context: AppContext,
  assetInfoFallback: AssetInfoFallback | undefined,
  assetDataOverride?: AssetDataOverride,
  onUploadError?: UploadErrorCleanup
): Promise<Database["public"]["Tables"]["File"]["Row"]> => {
  const pending = await context.db
    .select()
    .from(fileTable)
    .where(
      and(
        eq(fileTable.name, name),
        eq(fileTable.status, "UPLOADING"),
        gt(
          fileTable.updatedAt,
          new Date(Date.now() - UPLOADING_STALE_TIMEOUT).toISOString()
        )
      )
    );
  if (pending.length !== 1) {
    throw Error("File already uploaded or url is expired");
  }
  const pendingFile = pending[0];

  try {
    const expectedContentHash = pendingFile.contentHash ?? undefined;
    const contentHasher =
      expectedContentHash === undefined ? undefined : createHash("sha256");
    const uploadData = async function* () {
      for await (const chunk of data as unknown as AsyncIterable<Uint8Array>) {
        contentHasher?.update(chunk);
        yield chunk;
      }
      if (
        expectedContentHash !== undefined &&
        contentHasher?.digest("hex") !== expectedContentHash
      ) {
        throw new Error(
          "Uploaded asset content does not match its upload ticket."
        );
      }
    };
    const assetData = await client.uploadFile(
      name,
      pendingFile.format,
      uploadData(),
      assetInfoFallback,
      assetDataOverride
    );
    const { meta, format, size } = assetData;
    const [uploaded] = await context.db
      .update(fileTable)
      .set({
        size,
        format,
        meta: JSON.stringify(meta),
        status: "UPLOADED",
      })
      .where(eq(fileTable.name, name))
      .returning();
    if (uploaded === undefined) {
      throw Error("File not found");
    }
    return uploaded;
  } catch (error) {
    await cleanupUploadError(name, context, onUploadError);
    throw error;
  }
};

export const getUploadedAsset = async ({
  name,
  projectId,
  context,
  file: providedFile,
}: {
  name: string;
  projectId: string;
  context: AppContext;
  file?: Database["public"]["Tables"]["File"]["Row"];
}): Promise<Asset> => {
  let file = providedFile;
  if (file === undefined) {
    const files = await context.db
      .select()
      .from(fileTable)
      .where(and(eq(fileTable.name, name), eq(fileTable.status, "UPLOADED")));
    if (files.length !== 1) {
      throw new Error("File not found");
    }
    file = files[0];
  }
  const asset = await findAsset({ projectId, name, context });
  if (asset === undefined) {
    throw new Error("Asset not found");
  }
  return formatAsset({
    assetId: asset.id,
    projectId: asset.projectId,
    filename: asset.filename,
    description: asset.description,
    folderId: asset.folderId,
    file,
  });
};

export const uploadFile = async (
  name: string,
  data: ReadableStream<Uint8Array>,
  client: AssetObjectWriter,
  context: AppContext,
  assetInfoFallback: AssetInfoFallback | undefined,
  assetDataOverride?: AssetDataOverride,
  onUploadError?: UploadErrorCleanup
): Promise<Asset> => {
  const file = await uploadFileData(
    name,
    data,
    client,
    context,
    assetInfoFallback,
    assetDataOverride,
    onUploadError
  );
  try {
    const projectId = file.uploaderProjectId;
    if (typeof projectId !== "string") {
      throw Error("File uploader project is missing");
    }
    const asset = await getUploadedAsset({
      name,
      projectId,
      context,
      file,
    });
    return asset;
  } catch (error) {
    await cleanupUploadError(name, context, onUploadError);
    throw error;
  }
};
