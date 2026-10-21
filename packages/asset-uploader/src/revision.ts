import {
  formatAssetName,
  getFileNameParts,
  isTextFileAsset,
  type Asset,
} from "@webstudio-is/sdk";
import {
  authorizeProject,
  AuthorizationError,
  type AppContext,
} from "@webstudio-is/trpc-interface/index.server";
import {
  and,
  asset as assetTable,
  eq,
  file as fileTable,
  notExists,
  one,
  type Db,
} from "@webstudio-is/db";
import type { AssetObjectStore } from "./client";
import { uploadFileData } from "./upload";
import { createUniqueAssetFilename } from "./utils/get-unique-filename";
import { sanitizeS3Key } from "./utils/sanitize-s3-key";
import { formatAsset } from "./utils/format-asset";
import { AssetRevisionConflictError } from "@webstudio-is/content-engine/asset-content-repository";
export { AssetRevisionConflictError } from "@webstudio-is/content-engine/asset-content-repository";

const getRevisionFilename = ({
  name,
  filename,
  extension,
}: {
  name: string;
  filename: string | null;
  extension?: string;
}) => {
  const displayName = formatAssetName({ name, filename });
  if (extension === undefined) {
    return sanitizeS3Key(displayName);
  }
  const { basename } = getFileNameParts(displayName);
  return sanitizeS3Key(`${basename}.${extension}`);
};

export const swapAssetFileWithClient = async (
  {
    projectId,
    assetId,
    expectedName,
    replacementName,
  }: {
    projectId: string;
    assetId: string;
    expectedName: string;
    replacementName: string;
  },
  client: Db
) => {
  const data = await swapAssetFile(
    { projectId, assetId, expectedName, replacementName },
    client
  );
  if (data === "conflict") {
    throw new AssetRevisionConflictError(
      "This file changed since it was opened. Reload it before saving again."
    );
  }
  if (data === "not_found") {
    throw new Error("Asset not found");
  }
  if (data === "invalid_revision") {
    throw new Error("Asset revision is not available");
  }
  if (data !== "updated") {
    throw new Error("Unable to update asset content");
  }
};

/**
 * Points an asset at a new File revision if it still has `expectedName`, restores
 * the revision and marks the old file deleted when nothing else uses it. One
 * transaction, with the asset row locked.
 */
const swapAssetFile = async (
  {
    projectId,
    assetId,
    expectedName,
    replacementName,
  }: {
    projectId: string;
    assetId: string;
    expectedName: string;
    replacementName: string;
  },
  client: Db
): Promise<"not_found" | "conflict" | "invalid_revision" | "updated"> =>
  await client.transaction(async (tx) => {
    const [current] = await tx
      .select({ name: assetTable.name })
      .from(assetTable)
      .where(
        and(eq(assetTable.projectId, projectId), eq(assetTable.id, assetId))
      )
      .for("update");

    if (current === undefined) {
      return "not_found";
    }
    if (current.name !== expectedName) {
      return "conflict";
    }

    const replacement = await tx
      .select({ name: fileTable.name })
      .from(fileTable)
      .where(
        and(
          eq(fileTable.name, replacementName),
          eq(fileTable.status, "UPLOADED"),
          eq(fileTable.uploaderProjectId, projectId)
        )
      );
    if (replacement.length === 0) {
      return "invalid_revision";
    }

    await tx
      .update(fileTable)
      .set({ isDeleted: false })
      .where(eq(fileTable.name, replacementName));

    await tx
      .update(assetTable)
      .set({ name: replacementName })
      .where(
        and(eq(assetTable.projectId, projectId), eq(assetTable.id, assetId))
      );

    await tx
      .update(fileTable)
      .set({ isDeleted: true })
      .where(
        and(
          eq(fileTable.name, expectedName),
          notExists(
            tx
              .select({ name: assetTable.name })
              .from(assetTable)
              .where(eq(assetTable.name, expectedName))
          )
        )
      );

    return "updated";
  });

const loadAsset = async ({
  assetId,
  projectId,
  client,
}: {
  assetId: string;
  projectId: string;
  client: Db;
}) => {
  const rows = await client
    .select({
      id: assetTable.id,
      projectId: assetTable.projectId,
      name: assetTable.name,
      filename: assetTable.filename,
      description: assetTable.description,
      folderId: assetTable.folderId,
      file: fileTable,
    })
    .from(assetTable)
    .innerJoin(fileTable, eq(fileTable.name, assetTable.name))
    .where(
      and(eq(assetTable.id, assetId), eq(assetTable.projectId, projectId))
    );
  if (rows.length !== 1) {
    throw new Error("Asset not found");
  }
  return one(rows);
};

export const updateAssetContent = async (
  {
    assetId,
    projectId,
    expectedName,
    extension,
    data,
    prepareData,
  }: {
    assetId: Asset["id"];
    projectId: string;
    expectedName: string;
    extension?: string;
    data: ReadableStream<Uint8Array>;
    prepareData?: (input: {
      asset: Asset;
      data: ReadableStream<Uint8Array>;
    }) => Promise<ReadableStream<Uint8Array>>;
  },
  assetClient: AssetObjectStore,
  context: AppContext
): Promise<Asset> => {
  const canEdit = await authorizeProject.hasProjectPermit(
    { projectId, permit: "edit" },
    context
  );
  if (canEdit === false) {
    throw new AuthorizationError(
      "You don't have access to edit this project assets"
    );
  }

  const currentAsset = await loadAsset({
    assetId,
    projectId,
    client: context.db,
  });
  if (currentAsset.name !== expectedName) {
    throw new AssetRevisionConflictError(
      "This file changed since it was opened. Reload it before saving again."
    );
  }
  if (isTextFileAsset({ format: currentAsset.file.format }) === false) {
    throw new Error("This asset is not an editable text file");
  }
  if (
    extension !== undefined &&
    isTextFileAsset({ format: extension }) === false
  ) {
    throw new Error("The new extension must be an editable text file format");
  }

  const asset = formatAsset({
    assetId: currentAsset.id,
    projectId: currentAsset.projectId,
    filename: currentAsset.filename,
    description: currentAsset.description,
    folderId: currentAsset.folderId,
    file: currentAsset.file,
  });
  const preparedData =
    prepareData === undefined ? data : await prepareData({ asset, data });

  const revisionName = createUniqueAssetFilename(
    getRevisionFilename({
      name: currentAsset.name,
      filename: currentAsset.filename,
      extension: extension?.toLowerCase(),
    })
  );
  await context.db.insert(fileTable).values({
    name: revisionName,
    status: "UPLOADING",
    format: "file",
    size: 0,
    uploaderProjectId: projectId,
    createdAt: currentAsset.file.createdAt,
  });

  const file = await uploadFileData(
    revisionName,
    preparedData,
    assetClient,
    context,
    undefined,
    undefined,
    async (name, { db }) => {
      await db.delete(fileTable).where(eq(fileTable.name, name));
    }
  );
  const revision = formatAsset({
    assetId: currentAsset.id,
    projectId: currentAsset.projectId,
    filename: currentAsset.filename,
    description: currentAsset.description,
    folderId: currentAsset.folderId,
    file,
  });

  try {
    await swapAssetFileWithClient(
      {
        projectId,
        assetId,
        expectedName,
        replacementName: revisionName,
      },
      context.db
    );
  } catch (error) {
    let swapCommitted = false;
    try {
      const current = await loadAsset({
        assetId,
        projectId,
        client: context.db,
      });
      if (current.name === revisionName) {
        swapCommitted = true;
      } else {
        await context.db
          .update(fileTable)
          .set({ isDeleted: true })
          .where(eq(fileTable.name, revisionName));
      }
    } catch (cleanupError) {
      console.error("Unable to discard an asset revision", cleanupError);
    }
    if (swapCommitted === false) {
      throw error;
    }
  }

  return revision;
};

export const __testing__ = { getRevisionFilename };
