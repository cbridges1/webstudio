import { asset as assetSchema, type Asset, assets } from "@webstudio-is/sdk";
import { assetResourceLimits } from "@webstudio-is/sdk/asset-resource-limits";
import {
  and,
  asc,
  asset as assetTable,
  eq,
  file as fileTable,
  inArray,
  isNull,
  project as projectTable,
  type Database,
  type Db,
} from "@webstudio-is/db";
import { mapBounded } from "@webstudio-is/content-engine/compiler";
import { formatAsset, formatAssetForRead } from "./utils/format-asset";
import { applyValidatedMapPatches, diffMaps, type Patch } from "./patch-utils";
import {
  AssetRevisionConflictError,
  swapAssetFileWithClient,
} from "./revision";
import type { AssetMetadataUpdate } from "./asset-mutation-types";
import { AssetRepositoryNotFoundError } from "./asset-repository-errors";

const serializeAssetMeta = (meta: Asset["meta"]) => JSON.stringify(meta);

type FileRow = Database["public"]["Tables"]["File"]["Row"];

const getCanonicalAssetsForValidation = async ({
  current,
  next,
  client,
}: {
  current: ReadonlyMap<Asset["id"], Asset>;
  next: ReadonlyMap<Asset["id"], Asset>;
  client: Db;
}) => {
  const canonical = new Map<Asset["id"], Asset>();
  const filesByName = new Map<string, FileRow>();
  const assetsWithChangedFiles: Asset[] = [];
  for (const [assetId, asset] of next) {
    const previous = current.get(assetId);
    if (previous?.name === asset.name) {
      canonical.set(
        assetId,
        assetSchema.parse({
          ...previous,
          filename: asset.filename,
          description: asset.description,
          folderId: asset.folderId,
          meta: asset.meta,
        })
      );
      continue;
    }
    assetsWithChangedFiles.push(asset);
  }
  if (assetsWithChangedFiles.length === 0) {
    return { assets: canonical, filesByName };
  }

  const files = await loadUploadedFilesByNames({
    names: assetsWithChangedFiles.map((asset) => asset.name),
    client,
  });
  for (const file of files) {
    filesByName.set(file.name, file);
  }
  for (const asset of assetsWithChangedFiles) {
    const file = filesByName.get(asset.name);
    if (file === undefined) {
      throw new AssetRepositoryNotFoundError(
        `Asset file not found for ${asset.id}`
      );
    }
    canonical.set(
      asset.id,
      assetSchema.parse({
        ...formatAsset({
          assetId: asset.id,
          projectId: asset.projectId,
          filename: asset.filename ?? null,
          description: asset.description ?? null,
          folderId: asset.folderId,
          file,
        }),
        meta: asset.meta,
      })
    );
  }
  return { assets: canonical, filesByName };
};

// Batch long `IN (...)` lists so each query stays small. Persisted Asset ids are
// PostgreSQL UUIDs (36 characters); a batch of 100 keeps the list around 4 KiB.
const maxAssetIdsPerPostgrestMetadataRequest = 100;

// Metadata loading supports content reads, so cap its fan-out at half of the
// content engine's shared remote-read ceiling instead of defining an unrelated
// concurrency budget.
const maxConcurrentAssetMetadataPostgrestRequests = Math.ceil(
  assetResourceLimits.concurrentContentReads / 2
);

// Keep `IN (...)` lists around 4 KiB. File storage names can be much longer
// than Asset ids, so a fixed item count cannot provide the same bound.
const maxPostgrestInFilterCharacters = 4 * 1024;

export const chunkPostgrestFileNames = (values: Iterable<string>) => {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  for (const value of new Set(values)) {
    const candidate = [...chunk, value];
    const encodedFilter = new URLSearchParams({
      name: `in.(${candidate.join(",")})`,
    }).toString();
    if (
      chunk.length > 0 &&
      encodedFilter.length > maxPostgrestInFilterCharacters
    ) {
      chunks.push(chunk);
      chunk = [value];
      continue;
    }
    chunk = candidate;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
};

// File.uploaderProjectId records physical-file provenance, not every project
// allowed to reference it. clone_project intentionally shares File rows while
// copying their logical Asset rows, so filtering these lookups by that field
// would prevent cloned projects from restoring their shared files during Undo.
const loadUploadedFilesByNames = async ({
  names,
  client,
}: {
  names: Iterable<string>;
  client: Db;
}) => {
  const chunks = chunkPostgrestFileNames(names);
  return (
    await mapBounded(
      chunks,
      maxConcurrentAssetMetadataPostgrestRequests,
      async (chunk) => {
        return await client
          .select()
          .from(fileTable)
          .where(
            and(
              inArray(fileTable.name, chunk),
              eq(fileTable.status, "UPLOADED")
            )
          );
      }
    )
  ).flat();
};

const restoreUploadedFilesByNames = async ({
  names,
  client,
}: {
  names: Iterable<string>;
  client: Db;
}) => {
  await mapBounded(
    chunkPostgrestFileNames(names),
    maxConcurrentAssetMetadataPostgrestRequests,
    async (chunk) => {
      await client
        .update(fileTable)
        .set({ isDeleted: false })
        .where(
          and(inArray(fileTable.name, chunk), eq(fileTable.status, "UPLOADED"))
        );
    }
  );
};

const restoreSharedAssetFileWithClient = async (
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
  // clone_project shares existing File revision rows with the source project.
  // Restore the shared target before the compare-and-set so an Asset never
  // points at a deleted file if either request fails.
  const [restoredFile] = await client
    .update(fileTable)
    .set({ isDeleted: false })
    .where(
      and(eq(fileTable.name, replacementName), eq(fileTable.status, "UPLOADED"))
    )
    .returning({ name: fileTable.name });
  if (restoredFile?.name !== replacementName) {
    throw new AssetRepositoryNotFoundError("Asset revision is not available");
  }

  const [updatedAsset] = await client
    .update(assetTable)
    .set({ name: replacementName })
    .where(
      and(
        eq(assetTable.id, assetId),
        eq(assetTable.projectId, projectId),
        eq(assetTable.name, expectedName)
      )
    )
    .returning({ id: assetTable.id });
  if (updatedAsset?.id !== assetId) {
    throw new AssetRevisionConflictError(
      "This file changed since it was opened. Reload it before saving again."
    );
  }
  // Retain the prior File revision here. A separate read-then-delete cleanup
  // could mark it deleted after another project or Undo restores a reference.
  // Owned revisions use swapAssetFileWithClient's transactional cleanup instead.
};

export const createAssetRows = (assets: Iterable<Asset>, projectId: string) =>
  Array.from(assets, (asset) => ({
    id: asset.id,
    projectId,
    name: asset.name,
    filename: asset.filename ?? null,
    description: asset.description ?? null,
    folderId: asset.folderId ?? null,
  }));

export type AssetUploadReservation = Pick<
  Asset,
  "id" | "name" | "filename" | "folderId" | "createdAt"
> & {
  status?: "UPLOADING" | "UPLOADED";
};

const uploadReservationFreshnessMs = 30 * 60 * 1000;

export const loadAssetUploadReservationsByProjectWithClient = async (
  projectId: string,
  client: Db,
  now = new Date()
): Promise<AssetUploadReservation[]> => {
  const rows = await client
    .select({
      id: assetTable.id,
      filename: assetTable.filename,
      folderId: assetTable.folderId,
      file: {
        name: fileTable.name,
        status: fileTable.status,
        isDeleted: fileTable.isDeleted,
        createdAt: fileTable.createdAt,
        updatedAt: fileTable.updatedAt,
      },
    })
    .from(assetTable)
    .innerJoin(fileTable, eq(fileTable.name, assetTable.name))
    .where(eq(assetTable.projectId, projectId))
    .orderBy(asc(assetTable.id));
  const activeAfter = now.getTime() - uploadReservationFreshnessMs;
  return rows.flatMap(({ id, filename, folderId, file }) => {
    if (
      file.status !== "UPLOADED" &&
      (file.status !== "UPLOADING" ||
        file.isDeleted ||
        new Date(file.updatedAt).getTime() <= activeAfter)
    ) {
      return [];
    }
    return [
      {
        id,
        name: file.name,
        filename: filename ?? undefined,
        folderId: folderId ?? undefined,
        createdAt: file.createdAt,
        status: file.status,
      },
    ];
  });
};

export const deleteAssetUploadReservationWithClient = async (
  {
    projectId,
    assetId,
    name,
  }: { projectId: string; assetId: string; name: string },
  client: Db
) => {
  const [deletedAsset] = await client
    .delete(assetTable)
    .where(
      and(
        eq(assetTable.id, assetId),
        eq(assetTable.projectId, projectId),
        eq(assetTable.name, name)
      )
    )
    .returning({ id: assetTable.id });
  if (deletedAsset?.id !== assetId) {
    return;
  }
  await client
    .delete(fileTable)
    .where(
      and(
        eq(fileTable.name, name),
        eq(fileTable.uploaderProjectId, projectId),
        eq(fileTable.status, "UPLOADING")
      )
    );
};

export const loadAssetsByProjectWithClient = async (
  projectId: string,
  client: Db,
  assetIds?: string[]
): Promise<Asset[]> => {
  if (assetIds?.length === 0) {
    return [];
  }

  const load = async (requestedAssetIds: string[] | undefined) => {
    const rows = await client
      .select({
        assetId: assetTable.id,
        projectId: assetTable.projectId,
        filename: assetTable.filename,
        description: assetTable.description,
        folderId: assetTable.folderId,
        file: fileTable,
      })
      .from(assetTable)
      // inner join filters out assets whose file isn't uploaded
      .innerJoin(fileTable, eq(fileTable.name, assetTable.name))
      .where(
        and(
          eq(assetTable.projectId, projectId),
          eq(fileTable.status, "UPLOADED"),
          requestedAssetIds === undefined
            ? undefined
            : inArray(assetTable.id, requestedAssetIds)
        )
      )
      // always sort by primary key to get stable list
      // required to not break fixtures
      .orderBy(asc(assetTable.id));

    const result: Asset[] = [];
    const invalidFontMetadata: Array<{
      assetId: string;
      format: string;
      issues: Array<{ code: string; path: string[] }>;
    }> = [];
    for (const {
      assetId,
      projectId,
      filename,
      description,
      folderId,
      file,
    } of rows) {
      if (file) {
        const formatted = formatAssetForRead({
          assetId,
          projectId,
          filename,
          description,
          folderId,
          file,
        });
        result.push(formatted.asset);
        if (formatted.fontMetaIssues !== undefined) {
          invalidFontMetadata.push({
            assetId,
            format: file.format,
            issues: formatted.fontMetaIssues,
          });
        }
      }
    }
    if (invalidFontMetadata.length > 0) {
      console.error(
        "Invalid stored font metadata; loading affected assets as files",
        {
          projectId,
          assets: invalidFontMetadata,
        }
      );
    }
    return result;
  };

  if (assetIds === undefined) {
    return await load(undefined);
  }

  const uniqueAssetIds = [...new Set(assetIds)].sort();
  const chunks: string[][] = [];
  for (
    let offset = 0;
    offset < uniqueAssetIds.length;
    offset += maxAssetIdsPerPostgrestMetadataRequest
  ) {
    chunks.push(
      uniqueAssetIds.slice(
        offset,
        offset + maxAssetIdsPerPostgrestMetadataRequest
      )
    );
  }

  return (
    await mapBounded(chunks, maxConcurrentAssetMetadataPostgrestRequests, load)
  ).flat();
};

export const deleteAssetsWithClient = async (
  props: {
    ids: Array<Asset["id"]>;
    projectId: string;
  },
  client: Db
): Promise<void> => {
  const projectAssets = and(
    inArray(assetTable.id, props.ids),
    eq(assetTable.projectId, props.projectId)
  );
  const assets = await client
    .select({ id: assetTable.id, name: assetTable.name })
    .from(assetTable)
    .innerJoin(fileTable, eq(fileTable.name, assetTable.name))
    .where(projectAssets);

  if (assets.length === 0) {
    throw new AssetRepositoryNotFoundError("Assets not found");
  }

  await client
    .update(projectTable)
    .set({ previewImageAssetId: null })
    .where(
      and(
        eq(projectTable.id, props.projectId),
        inArray(projectTable.previewImageAssetId, props.ids)
      )
    );

  await client.delete(assetTable).where(projectAssets);

  const unusedFileNames = new Set(assets.map((asset) => asset.name));
  const assetsByStillUsedFileName = await client
    .select({ name: assetTable.name })
    .from(assetTable)
    .where(inArray(assetTable.name, Array.from(unusedFileNames)));
  for (const asset of assetsByStillUsedFileName) {
    unusedFileNames.delete(asset.name);
  }

  if (unusedFileNames.size > 0) {
    await client
      .update(fileTable)
      .set({ isDeleted: true })
      .where(inArray(fileTable.name, Array.from(unusedFileNames)));
  }
};

export const updateAssetMetadataWithClient = async (
  {
    projectId,
    assetId,
    values,
  }: {
    projectId: string;
    assetId: Asset["id"];
    values: AssetMetadataUpdate;
  },
  client: Db
): Promise<Asset> => {
  await persistAssetMetadataWithClient({ projectId, assetId, values }, client);

  const [asset] = await loadAssetsByProjectWithClient(projectId, client, [
    assetId,
  ]);
  if (asset === undefined) {
    throw new AssetRepositoryNotFoundError("Asset not found");
  }
  return asset;
};

export const updateAssetFilenameIfCurrentWithClient = async (
  {
    projectId,
    assetId,
    expectedFilename,
    filename,
  }: {
    projectId: string;
    assetId: Asset["id"];
    expectedFilename: string | undefined;
    filename: string | undefined;
  },
  client: Db
): Promise<Asset | undefined> => {
  const [result] = await client
    .update(assetTable)
    .set({ filename: filename ?? null })
    .where(
      and(
        eq(assetTable.id, assetId),
        eq(assetTable.projectId, projectId),
        expectedFilename === undefined
          ? isNull(assetTable.filename)
          : eq(assetTable.filename, expectedFilename)
      )
    )
    .returning({ id: assetTable.id });
  if (result?.id !== assetId) {
    return;
  }
  const [asset] = await loadAssetsByProjectWithClient(projectId, client, [
    assetId,
  ]);
  if (asset === undefined) {
    throw new AssetRepositoryNotFoundError("Asset not found");
  }
  return asset;
};

const persistAssetMetadataWithClient = async (
  {
    projectId,
    assetId,
    values,
  }: {
    projectId: string;
    assetId: Asset["id"];
    values: AssetMetadataUpdate;
  },
  client: Db
) => {
  const update: {
    filename?: string | null;
    description?: string | null;
    folderId?: string | null;
  } = {};
  if (Object.hasOwn(values, "filename")) {
    update.filename = values.filename ?? null;
  }
  if (Object.hasOwn(values, "description")) {
    update.description = values.description ?? null;
  }
  if (Object.hasOwn(values, "folderId")) {
    update.folderId = values.folderId ?? null;
  }
  const filter = and(
    eq(assetTable.id, assetId),
    eq(assetTable.projectId, projectId)
  );
  // An empty update still has to confirm the asset exists.
  const [result] =
    Object.keys(update).length === 0
      ? await client
          .select({ id: assetTable.id })
          .from(assetTable)
          .where(filter)
      : await client
          .update(assetTable)
          .set(update)
          .where(filter)
          .returning({ id: assetTable.id });
  if (result?.id !== assetId) {
    throw new AssetRepositoryNotFoundError("Asset not found");
  }
};

/**
 * Persists asset additions, deletions, metadata updates, and file revisions.
 */
export const patchAssetsWithClient = async (
  {
    projectId,
    client,
  }: {
    projectId: string;
    client: Db;
  },
  patches: Array<Patch>,
  {
    validate,
    allowSharedFileRestore = false,
  }: {
    validate?: (input: {
      current: ReadonlyMap<Asset["id"], Asset>;
      next: ReadonlyMap<Asset["id"], Asset>;
    }) => Promise<void>;
    /**
     * Allows the authorized sync endpoint to restore File rows shared by a
     * cloned project. Direct revision writes remain restricted to owned rows.
     */
    allowSharedFileRestore?: boolean;
  } = {}
): Promise<void> => {
  const assetsList = await loadAssetsByProjectWithClient(projectId, client);
  const assetsMap = new Map<Asset["id"], Asset>();
  for (const asset of assetsList) {
    assetsMap.set(asset.id, asset);
  }
  const patchedAssets = applyValidatedMapPatches(assetsMap, patches, (value) =>
    assets.parse(value)
  );
  for (const [assetId, asset] of patchedAssets) {
    if (asset.id !== assetId) {
      throw new Error(
        `Asset ${asset.id} does not match its map key ${assetId}`
      );
    }
    if (asset.projectId !== projectId) {
      throw new Error(`Asset ${asset.id} belongs to another project`);
    }
  }
  let replacementFilesByName = new Map<string, FileRow>();
  if (validate !== undefined || allowSharedFileRestore) {
    const canonical = await getCanonicalAssetsForValidation({
      current: assetsMap,
      next: patchedAssets,
      client,
    });
    replacementFilesByName = canonical.filesByName;
    await validate?.({ current: assetsMap, next: canonical.assets });
  }
  const {
    added,
    updated,
    deletedKeys: deletedAssetIds,
  } = diffMaps(
    assetsMap,
    patchedAssets,
    (previous, asset) =>
      previous.name === asset.name &&
      previous.filename === asset.filename &&
      previous.description === asset.description &&
      previous.folderId === asset.folderId &&
      serializeAssetMeta(previous.meta) === serializeAssetMeta(asset.meta)
  );
  const sharedMetadataAssetIds = new Set<Asset["id"]>();
  if (allowSharedFileRestore) {
    const assetsWithMetadataChanges = updated.filter((asset) => {
      const previous = assetsMap.get(asset.id);
      return (
        previous !== undefined &&
        serializeAssetMeta(previous.meta) !== serializeAssetMeta(asset.meta)
      );
    });
    const missingFileNames = assetsWithMetadataChanges.flatMap((asset) =>
      replacementFilesByName.has(asset.name) ? [] : [asset.name]
    );
    for (const file of await loadUploadedFilesByNames({
      names: missingFileNames,
      client,
    })) {
      replacementFilesByName.set(file.name, file);
    }
    for (const asset of assetsWithMetadataChanges) {
      const file = replacementFilesByName.get(asset.name);
      if (file === undefined) {
        throw new AssetRepositoryNotFoundError(
          `Asset file not found for ${asset.id}`
        );
      }
      // Files uploaded before provenance tracking have a null project id.
      // Preserve their existing metadata edits, but validate replacement files.
      if (
        file.uploaderProjectId === projectId ||
        (file.uploaderProjectId === null &&
          assetsMap.get(asset.id)?.name === asset.name)
      ) {
        continue;
      }
      sharedMetadataAssetIds.add(asset.id);
      const authoritativeMeta = formatAsset({
        assetId: asset.id,
        projectId,
        filename: asset.filename ?? null,
        description: asset.description ?? null,
        folderId: asset.folderId,
        file,
      }).meta;
      if (
        serializeAssetMeta(asset.meta) !== serializeAssetMeta(authoritativeMeta)
      ) {
        throw new Error("Shared asset metadata does not match its file");
      }
    }
  }
  if (deletedAssetIds.length !== 0) {
    await deleteAssetsWithClient({ projectId, ids: deletedAssetIds }, client);
  }

  for (const asset of updated) {
    const previous = assetsMap.get(asset.id);
    if (previous === undefined) {
      throw new Error(`Asset ${asset.id} was not loaded`);
    }
    if (previous.name !== asset.name) {
      const replacementFile = replacementFilesByName.get(asset.name);
      if (allowSharedFileRestore && replacementFile === undefined) {
        throw new AssetRepositoryNotFoundError(
          `Asset file not found for ${asset.id}`
        );
      }
      if (
        allowSharedFileRestore &&
        replacementFile !== undefined &&
        replacementFile.uploaderProjectId !== projectId
      ) {
        await restoreSharedAssetFileWithClient(
          {
            projectId,
            assetId: asset.id,
            expectedName: previous.name,
            replacementName: asset.name,
          },
          client
        );
      } else {
        await swapAssetFileWithClient(
          {
            projectId,
            assetId: asset.id,
            expectedName: previous.name,
            replacementName: asset.name,
          },
          client
        );
      }
    }
    if (
      previous.filename !== asset.filename ||
      previous.description !== asset.description ||
      previous.folderId !== asset.folderId
    ) {
      const { filename, description, folderId } = asset;
      await persistAssetMetadataWithClient(
        {
          projectId,
          assetId: asset.id,
          values: { filename, description, folderId },
        },
        client
      );
    }
    if (
      sharedMetadataAssetIds.has(asset.id) === false &&
      serializeAssetMeta(previous.meta) !== serializeAssetMeta(asset.meta)
    ) {
      const meta = serializeAssetMeta(asset.meta);
      const [updatedFile] = await client
        .update(fileTable)
        .set({ meta })
        .where(eq(fileTable.name, asset.name))
        .returning({ meta: fileTable.meta });
      if (updatedFile?.meta !== meta) {
        throw new Error(
          `Asset metadata update was not persisted for ${asset.id}`
        );
      }
    }
  }
  const addedAssets: Asset[] = added;
  if (addedAssets.length !== 0) {
    const files = await loadUploadedFilesByNames({
      names: addedAssets.map((asset) => asset.name),
      client,
    });
    const fileNames = new Set(files.map((file) => file.name));
    const missingFile = addedAssets.find(
      (asset) => fileNames.has(asset.name) === false
    );
    if (missingFile !== undefined) {
      throw new AssetRepositoryNotFoundError(
        `Asset file not found for ${missingFile.id}`
      );
    }

    // restore file when undo is triggered
    await restoreUploadedFilesByNames({ names: fileNames, client });

    await client
      .insert(assetTable)
      .values(createAssetRows(addedAssets, projectId));
  }
};
