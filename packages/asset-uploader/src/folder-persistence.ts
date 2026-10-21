import {
  assetFolders,
  createAssetFolderHierarchy,
  type AssetFolder,
} from "@webstudio-is/sdk";
import {
  and,
  asc,
  assetFolder,
  eq,
  inArray,
  isNull,
  sql,
  type Db,
} from "@webstudio-is/db";
import { applyValidatedMapPatches, diffMaps, type Patch } from "./patch-utils";
import { AssetRepositoryConflictError } from "./asset-repository-errors";

const pendingProjectMutations = new Map<string, Promise<void>>();

const repairAssetFolderCycles = (folders: readonly AssetFolder[]) => {
  const repaired = new Map(folders.map((folder) => [folder.id, folder]));
  const repairedIds: string[] = [];

  while (true) {
    const hierarchy = createAssetFolderHierarchy(repaired);
    let cycleIds: readonly string[] | undefined;
    for (const startId of [...repaired.keys()].sort()) {
      const candidate = hierarchy.getCycleIds(startId);
      if (candidate.length > 0) {
        cycleIds = candidate;
        break;
      }
    }
    if (cycleIds === undefined) {
      break;
    }

    // Concurrent moves do not provide enough information to infer which move
    // the user preferred. Detach the same edge on every process so a persisted
    // cycle cannot make folder reads, asset paths, or publication unavailable.
    const folderId = [...cycleIds].sort().at(-1) as string;
    const folder = repaired.get(folderId) as AssetFolder;
    repaired.set(folderId, { ...folder, parentId: undefined });
    repairedIds.push(folderId);
  }

  return { folders: [...repaired.values()], repairedIds };
};

/**
 * Serializes folder mutations handled by this process so each validation reads
 * the result of the preceding write. Separate application instances cannot
 * share this lock; database constraints remain the final protection for
 * references and sibling uniqueness.
 */
const withAssetFolderMutationLock = async <Result>(
  projectId: string,
  mutate: () => Promise<Result>
): Promise<Result> => {
  const previous = pendingProjectMutations.get(projectId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pendingProjectMutations.set(projectId, current);
  await previous;
  try {
    return await mutate();
  } finally {
    release();
    if (pendingProjectMutations.get(projectId) === current) {
      pendingProjectMutations.delete(projectId);
    }
  }
};

export const createAssetFolderRows = (
  folders: Iterable<AssetFolder>,
  projectId: string
) => {
  const folderList = Array.from(folders);
  const hierarchy = createAssetFolderHierarchy(
    new Map(folderList.map((folder) => [folder.id, folder]))
  );
  return hierarchy.sortByDepth(folderList).map((folder) => ({
    id: folder.id,
    projectId,
    name: folder.name,
    parentId: folder.parentId ?? null,
    createdAt: folder.createdAt,
  }));
};

const loadAssetFoldersByProjectRaw = async (
  projectId: string,
  client: Db
): Promise<AssetFolder[]> => {
  const rows = await client
    .select({
      id: assetFolder.id,
      projectId: assetFolder.projectId,
      name: assetFolder.name,
      parentId: assetFolder.parentId,
      createdAt: assetFolder.createdAt,
    })
    .from(assetFolder)
    .where(eq(assetFolder.projectId, projectId))
    .orderBy(asc(assetFolder.id));

  return rows.map((folder) => ({
    id: folder.id,
    projectId: folder.projectId,
    name: folder.name,
    parentId: folder.parentId ?? undefined,
    createdAt: folder.createdAt,
  }));
};

export const loadAssetFoldersByProjectWithClient = async (
  projectId: string,
  client: Db,
  folderIds?: string[]
): Promise<AssetFolder[]> => {
  if (folderIds?.length === 0) {
    return [];
  }
  // Cycle detection needs the complete graph even when the caller only wants
  // one folder. Repair first, then narrow the returned collection.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const folders = await loadAssetFoldersByProjectRaw(projectId, client);
    const repaired = repairAssetFolderCycles(folders);
    const originalById = new Map(folders.map((folder) => [folder.id, folder]));
    let sourceChanged = false;
    for (const folderId of repaired.repairedIds) {
      const original = originalById.get(folderId);
      if (original?.parentId === undefined) {
        continue;
      }
      const result = await client
        .update(assetFolder)
        .set({ parentId: null })
        .where(
          and(
            eq(assetFolder.id, folderId),
            eq(assetFolder.projectId, projectId),
            eq(assetFolder.parentId, original.parentId)
          )
        )
        .returning({ id: assetFolder.id });
      if (result.some(({ id }) => id === folderId) !== true) {
        sourceChanged = true;
        break;
      }
    }
    if (sourceChanged) {
      continue;
    }
    if (folderIds === undefined) {
      return repaired.folders;
    }
    const selectedIds = new Set(folderIds);
    return repaired.folders.filter(({ id }) => selectedIds.has(id));
  }
  throw new AssetRepositoryConflictError(
    "Asset folders changed repeatedly while repairing a cycle"
  );
};

const getPersistedFolderCycles = async (projectId: string, client: Db) =>
  repairAssetFolderCycles(await loadAssetFoldersByProjectRaw(projectId, client))
    .repairedIds;

const restoreAssetFolder = async ({
  projectId,
  previous,
  persisted,
  client,
}: {
  projectId: string;
  previous: AssetFolder | undefined;
  persisted: AssetFolder;
  client: Db;
}) => {
  const match = and(
    eq(assetFolder.id, persisted.id),
    eq(assetFolder.projectId, projectId),
    eq(assetFolder.name, persisted.name),
    persisted.parentId === undefined
      ? isNull(assetFolder.parentId)
      : eq(assetFolder.parentId, persisted.parentId)
  );
  if (previous === undefined) {
    await client.delete(assetFolder).where(match);
  } else {
    await client
      .update(assetFolder)
      .set({ name: previous.name, parentId: previous.parentId ?? null })
      .where(match);
  }
};

const verifyAndRollbackFolderMutation = async ({
  projectId,
  previousById,
  persisted,
  client,
}: {
  projectId: string;
  previousById: ReadonlyMap<string, AssetFolder>;
  persisted: readonly AssetFolder[];
  client: Db;
}) => {
  if ((await getPersistedFolderCycles(projectId, client)).length === 0) {
    return;
  }
  for (const folder of [...persisted].reverse()) {
    await restoreAssetFolder({
      projectId,
      previous: previousById.get(folder.id),
      persisted: folder,
      client,
    });
  }
  throw new AssetRepositoryConflictError(
    "Folder update conflicted with another move and was reverted"
  );
};

/** Inserts folders, or updates them when they already exist in the project. */
const upsertAssetFolderRows = (
  client: Db,
  rows: ReturnType<typeof createAssetFolderRows>
) =>
  client
    .insert(assetFolder)
    .values(rows)
    .onConflictDoUpdate({
      target: [assetFolder.id, assetFolder.projectId],
      set: {
        name: sql`excluded.name`,
        parentId: sql`excluded."parentId"`,
        createdAt: sql`excluded."createdAt"`,
      },
    });

export const upsertAssetFolderWithClient = async (
  {
    projectId,
    folder,
  }: {
    projectId: string;
    folder: AssetFolder;
  },
  client: Db
): Promise<AssetFolder> =>
  await withAssetFolderMutationLock(projectId, async () => {
    const current = new Map(
      (await loadAssetFoldersByProjectWithClient(projectId, client)).map(
        (item) => [item.id, item]
      )
    );
    const validated = assetFolders.parse(
      new Map(current).set(folder.id, folder)
    );
    const value = validated.get(folder.id);
    if (value === undefined) {
      throw new Error("Asset folder was not validated");
    }
    const [row] = await upsertAssetFolderRows(
      client,
      createAssetFolderRows([value], projectId)
    ).returning({
      id: assetFolder.id,
      projectId: assetFolder.projectId,
      name: assetFolder.name,
      parentId: assetFolder.parentId,
      createdAt: assetFolder.createdAt,
    });
    if (row?.id !== value.id) {
      throw new Error("Asset folder was not persisted");
    }
    const persisted = {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      parentId: row.parentId ?? undefined,
      createdAt: row.createdAt,
    };
    await verifyAndRollbackFolderMutation({
      projectId,
      previousById: current,
      persisted: [persisted],
      client,
    });
    return persisted;
  });

export const patchAssetFoldersWithClient = async (
  { projectId, client }: { projectId: string; client: Db },
  patches: Array<Patch>,
  { deferDeletes = false }: { deferDeletes?: boolean } = {}
): Promise<string[]> =>
  await withAssetFolderMutationLock(projectId, async () => {
    const currentList = await loadAssetFoldersByProjectWithClient(
      projectId,
      client
    );
    const current = new Map(currentList.map((folder) => [folder.id, folder]));
    const validated = applyValidatedMapPatches(current, patches, (value) =>
      assetFolders.parse(value)
    );
    for (const folder of validated.values()) {
      if (folder.projectId !== projectId) {
        throw new Error(`Asset folder ${folder.id} belongs to another project`);
      }
    }

    const { added, updated, deletedKeys } = diffMaps(
      current,
      validated,
      (previous, folder) =>
        previous.name === folder.name && previous.parentId === folder.parentId
    );
    const changed = [...added, ...updated];
    if (changed.length > 0) {
      const rows = await upsertAssetFolderRows(
        client,
        createAssetFolderRows(changed, projectId)
      ).returning({
        id: assetFolder.id,
        name: assetFolder.name,
        parentId: assetFolder.parentId,
      });
      const persisted = new Map(rows.map((row) => [row.id, row]));
      for (const folder of changed) {
        const row = persisted.get(folder.id);
        if (
          row?.name !== folder.name ||
          (row.parentId ?? undefined) !== folder.parentId
        ) {
          throw new Error(
            `Asset folder update was not persisted for ${folder.id}`
          );
        }
      }
      await verifyAndRollbackFolderMutation({
        projectId,
        previousById: current,
        persisted: changed,
        client,
      });
    }

    if (deletedKeys.length > 0 && deferDeletes === false) {
      await deleteAssetFoldersUnlocked({ projectId, ids: deletedKeys }, client);
    }
    return deletedKeys;
  });

const deleteAssetFoldersUnlocked = async (
  { projectId, ids }: { projectId: string; ids: string[] },
  client: Db
) => {
  if (ids.length === 0) {
    return;
  }
  const deleted = await client
    .delete(assetFolder)
    .where(
      and(inArray(assetFolder.id, ids), eq(assetFolder.projectId, projectId))
    )
    .returning({ id: assetFolder.id });
  const deletedIds = new Set(deleted.map(({ id }) => id));
  const missingId = ids.find((id) => deletedIds.has(id) === false);
  if (missingId !== undefined) {
    throw new Error(`Asset folder deletion was not persisted for ${missingId}`);
  }
};

export const deleteAssetFoldersWithClient = async (
  props: { projectId: string; ids: string[] },
  client: Db
) =>
  await withAssetFolderMutationLock(props.projectId, async () => {
    await deleteAssetFoldersUnlocked(props, client);
  });
