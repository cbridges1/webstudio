import { describe, test, expect } from "vitest";
import {
  and,
  asset as assetTable,
  assetFolder,
  asc,
  eq,
  file as fileTable,
  project as projectTable,
  type Db,
} from "@webstudio-is/db";
import { seed, setupTestDb, withQueryHook } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { createDefaultCollectionConfig } from "@webstudio-is/content-engine";
import {
  deleteAssetUploadReservationWithClient,
  deleteAssetsWithClient,
  loadAssetUploadReservationsByProjectWithClient,
  loadAssetsByProjectWithClient,
  patchAssetsWithClient,
  updateAssetFilenameIfCurrentWithClient,
  updateAssetMetadataWithClient,
} from "./asset-patch-core";
import { AssetRepositoryNotFoundError } from "./asset-repository-errors";
import {
  deleteAssetFoldersWithClient,
  loadAssetFoldersByProjectWithClient,
  patchAssetFoldersWithClient,
  upsertAssetFolderWithClient,
} from "./folder-persistence";
import { patchAssets } from "./patch";
import type { AssetObjectReader } from "./client";
import type { Patch } from "immer";

const db = setupTestDb();

const uid = () => `proj-${Math.random().toString(36).slice(2)}`;

const createContext = (contextDb: Db = db): AppContext =>
  ({
    db: contextDb,
    authorization: { type: "user", userId: "user-1" },
    getOwnerPlanFeatures: async () => ({}),
  }) as unknown as AppContext;

const unusedAssetStore: AssetObjectReader = {
  readFile: async () => {
    throw new Error("Unexpected asset content read");
  },
};

const createSourceAssetStore = (
  sources: Readonly<Record<string, string>>
): AssetObjectReader => ({
  readFile: async (name, range) => {
    const source = sources[name];
    if (source === undefined) {
      throw new Error(`Unexpected asset content read: ${name}`);
    }
    const offset = range?.offset ?? 0;
    const data =
      range?.length === undefined
        ? source.slice(offset)
        : source.slice(offset, offset + range.length);
    return {
      data: new Blob([data]).stream(),
      contentLength: data.length,
    };
  },
});

/** A project owned by user-1, so every permit check passes. */
const seedOwnProject = async (projectId: string) => {
  await seed.project(db, { id: projectId, userId: "user-1" });
};

/** A project owned by owner-1 in which user-1 is an editor (no build access). */
const seedEditorProject = async (projectId: string) => {
  const workspaceId = crypto.randomUUID();
  await seed.workspace(db, { id: workspaceId, userId: "owner-1" });
  await seed.project(db, { id: projectId, userId: "owner-1", workspaceId });
  await seed.workspaceMember(db, {
    workspaceId,
    userId: "user-1",
    relation: "editors",
  });
};

const createdAt = "2026-01-01T00:00:00.000Z";

type SeededAsset = {
  id: string;
  projectId: string;
  filename?: string | null;
  description?: string | null;
  folderId?: string | null;
  file: {
    name: string;
    format?: string;
    size?: number;
    meta?: string;
    status?: "UPLOADING" | "UPLOADED";
    isDeleted?: boolean;
    uploaderProjectId?: string | null;
    contentHash?: string | null;
    createdAt?: string;
    updatedAt?: string;
  };
};

const photoFile = {
  name: "photo.jpg",
  format: "jpg",
  size: 1000,
  createdAt: "2024-01-01T00:00:00.000Z",
  meta: JSON.stringify({ width: 100, height: 100 }),
};

/** An asset and its file. Files belong to the asset's project unless told otherwise. */
const seedAsset = async ({ file, ...row }: SeededAsset) => {
  await seed.asset(
    db,
    { ...row, name: file.name },
    { uploaderProjectId: row.projectId, ...file }
  );
};

const seedFolders = async (
  projectId: string,
  folders: Array<{ id: string; name: string; parentId?: string }>
) => {
  for (const folder of folders) {
    await seed.assetFolder(db, { ...folder, projectId, createdAt });
  }
};

const readFolders = async (projectId: string) =>
  await db
    .select({
      id: assetFolder.id,
      name: assetFolder.name,
      parentId: assetFolder.parentId,
    })
    .from(assetFolder)
    .where(eq(assetFolder.projectId, projectId))
    .orderBy(asc(assetFolder.id));

const readAssets = async (projectId: string) =>
  await db
    .select()
    .from(assetTable)
    .where(eq(assetTable.projectId, projectId))
    .orderBy(asc(assetTable.id));

const readFile = async (name: string) =>
  (await db.select().from(fileTable).where(eq(fileTable.name, name)))[0];

/** A database whose `kind` queries on `table` fail once they've run. */
const failingOn = (kind: "update" | "delete" | "insert", table: unknown) =>
  withQueryHook(db, ({ kind: queryKind, table: queryTable }) => {
    if (queryKind === kind && queryTable === table) {
      throw new Error("db error");
    }
  });

/** Counts queries of one kind on one table. */
const countingQueries = (
  kind: "select" | "update" | "insert",
  table: unknown
) => {
  const counter = { count: 0 };
  const countingDb = withQueryHook(
    db,
    ({ kind: queryKind, table: queryTable }) => {
      if (queryKind === kind && queryTable === table) {
        counter.count += 1;
      }
    }
  );
  return { counter, countingDb };
};

describe("asset folder persistence", () => {
  test("validates and upserts one REST folder mutation", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    const folder = { id: "blog", projectId, name: "Blog", createdAt };

    await expect(
      upsertAssetFolderWithClient({ projectId, folder }, db)
    ).resolves.toEqual(folder);
    expect(await readFolders(projectId)).toEqual([
      { id: "blog", name: "Blog", parentId: null },
    ]);
  });

  test("rejects a REST folder with a missing parent before persistence", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);

    await expect(
      upsertAssetFolderWithClient(
        {
          projectId,
          folder: {
            id: "blog",
            projectId,
            name: "Blog",
            parentId: "missing",
            createdAt,
          },
        },
        db
      )
    ).rejects.toThrow("Parent folder must exist");
    expect(await readFolders(projectId)).toEqual([]);
  });

  test("serializes concurrent folder updates before validating cycles", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedFolders(projectId, [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    let readCount = 0;
    let writeCount = 0;
    let startFirstWrite = () => {};
    const firstWriteStarted = new Promise<void>((resolve) => {
      startFirstWrite = resolve;
    });
    let releaseFirstWrite = () => {};
    const firstWriteCanFinish = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const slowDb = withQueryHook(db, async ({ kind, table }) => {
      if (table !== assetFolder) {
        return;
      }
      if (kind === "select") {
        readCount += 1;
      }
      if (kind === "insert") {
        writeCount += 1;
        if (writeCount === 1) {
          startFirstWrite();
          await firstWriteCanFinish;
        }
      }
    });

    const moveA = upsertAssetFolderWithClient(
      {
        projectId,
        folder: { id: "a", projectId, name: "A", parentId: "b", createdAt },
      },
      slowDb
    );
    await firstWriteStarted;
    const moveB = upsertAssetFolderWithClient(
      {
        projectId,
        folder: { id: "b", projectId, name: "B", parentId: "a", createdAt },
      },
      slowDb
    );

    await Promise.resolve();
    expect(readCount).toBe(1);
    releaseFirstWrite();

    await expect(moveA).resolves.toMatchObject({ id: "a", parentId: "b" });
    await expect(moveB).rejects.toThrow("Folders can't contain cycles");
    expect(readCount).toBe(3);
    expect(writeCount).toBe(1);
  });

  /** A persisted cycle: a is in b and b is in a. */
  const seedCycle = async (projectId: string) => {
    await seedFolders(projectId, [
      { id: "a", name: "A" },
      { id: "b", name: "B", parentId: "a" },
    ]);
    await db
      .update(assetFolder)
      .set({ parentId: "b" })
      .where(
        and(eq(assetFolder.projectId, projectId), eq(assetFolder.id, "a"))
      );
  };

  test("repairs persisted cycles when folders are loaded", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedCycle(projectId);

    await expect(
      loadAssetFoldersByProjectWithClient(projectId, db, ["a"])
    ).resolves.toEqual([
      { id: "a", projectId, name: "A", parentId: "b", createdAt },
    ]);
    await expect(
      loadAssetFoldersByProjectWithClient(projectId, db)
    ).resolves.toEqual([
      { id: "a", projectId, name: "A", parentId: "b", createdAt },
      { id: "b", projectId, name: "B", createdAt },
    ]);
    expect(await readFolders(projectId)).toEqual([
      { id: "a", name: "A", parentId: "b" },
      { id: "b", name: "B", parentId: null },
    ]);
  });

  test("reloads a cycle repair that loses a concurrent update", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedCycle(projectId);
    let readCount = 0;
    // Another process repairs the cycle right after this one read the folders.
    const racingDb = withQueryHook(db, async ({ kind, table }) => {
      if (kind === "select" && table === assetFolder) {
        readCount += 1;
        if (readCount === 1) {
          await db
            .update(assetFolder)
            .set({ parentId: null })
            .where(
              and(eq(assetFolder.projectId, projectId), eq(assetFolder.id, "b"))
            );
        }
      }
    });

    await expect(
      loadAssetFoldersByProjectWithClient(projectId, racingDb)
    ).resolves.toEqual([
      { id: "a", projectId, name: "A", parentId: "b", createdAt },
      { id: "b", projectId, name: "B", createdAt },
    ]);
    expect(readCount).toBe(2);
  });

  test("reverts a move when a concurrent server creates a cycle", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedFolders(projectId, [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    // Another server moves b into a while this one moves a into b.
    const racingDb = withQueryHook(db, async ({ kind, table }) => {
      if (kind === "insert" && table === assetFolder) {
        await db
          .update(assetFolder)
          .set({ parentId: "a" })
          .where(
            and(eq(assetFolder.projectId, projectId), eq(assetFolder.id, "b"))
          );
      }
    });

    await expect(
      upsertAssetFolderWithClient(
        {
          projectId,
          folder: { id: "a", projectId, name: "A", parentId: "b", createdAt },
        },
        racingDb
      )
    ).rejects.toThrow("conflicted with another move and was reverted");
    expect(await readFolders(projectId)).toEqual([
      { id: "a", name: "A", parentId: null },
      { id: "b", name: "B", parentId: "a" },
    ]);
  });

  test("inserts parents before children", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    let inserted: Array<{ id: string }> = [];
    const watchedDb = withQueryHook(db, ({ kind, table, rows }) => {
      if (kind === "insert" && table === assetFolder) {
        inserted = rows as Array<{ id: string }>;
      }
    });

    await patchAssetFoldersWithClient({ projectId, client: watchedDb }, [
      {
        op: "add",
        path: ["child"],
        value: {
          id: "child",
          projectId,
          name: "Child",
          parentId: "parent",
          createdAt,
        },
      },
      {
        op: "add",
        path: ["parent"],
        value: { id: "parent", projectId, name: "Parent", createdAt },
      },
    ]);

    expect(inserted.map(({ id }) => id)).toEqual(["parent", "child"]);
    expect(await readFolders(projectId)).toEqual([
      { id: "child", name: "Child", parentId: "parent" },
      { id: "parent", name: "Parent", parentId: null },
    ]);
  });

  test("can defer folder deletion until assets are moved", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedFolders(projectId, [{ id: "folder", name: "Folder" }]);

    const ids = await patchAssetFoldersWithClient(
      { projectId, client: db },
      [{ op: "remove", path: ["folder"] }],
      { deferDeletes: true }
    );
    expect(ids).toEqual(["folder"]);
    expect(await readFolders(projectId)).toHaveLength(1);

    await deleteAssetFoldersWithClient({ projectId, ids }, db);
    expect(await readFolders(projectId)).toEqual([]);
  });

  test("persists moving a nested folder to root as null", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedFolders(projectId, [
      { id: "parent", name: "Parent" },
      { id: "child", name: "Child", parentId: "parent" },
    ]);

    await patchAssetFoldersWithClient({ projectId, client: db }, [
      { op: "remove", path: ["child", "parentId"] },
    ]);
    expect(await readFolders(projectId)).toEqual([
      { id: "child", name: "Child", parentId: null },
      { id: "parent", name: "Parent", parentId: null },
    ]);
  });

  test("rejects folders that claim another project", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);

    await expect(
      patchAssetFoldersWithClient({ projectId, client: db }, [
        {
          op: "add",
          path: ["folder"],
          value: {
            id: "folder",
            projectId: "another-project",
            name: "Folder",
            createdAt,
          },
        },
      ])
    ).rejects.toThrow("belongs to another project");
  });

  test("persists the normalized folder name returned by validation", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);

    await patchAssetFoldersWithClient({ projectId, client: db }, [
      {
        op: "add",
        path: ["folder"],
        value: { id: "folder", projectId, name: "  Media  ", createdAt },
      },
    ]);

    expect(await readFolders(projectId)).toEqual([
      { id: "folder", name: "Media", parentId: null },
    ]);
  });
});

describe("asset patch persistence", () => {
  test("sync saves an existing entry revision while a required field still needs repair", async () => {
    const projectId = uid();
    const sources = {
      "config.json": createDefaultCollectionConfig(),
      "template.mdx": "---\ndraft: true\n---\n",
      "old.mdx": "---\nslug: post\n---\nOld body.\n",
      "new.mdx": "---\nslug: post\n---\nRepaired body.\n",
    };
    await seedOwnProject(projectId);
    await seedFolders(projectId, [{ id: "posts", name: "posts" }]);
    const seedEntry = async (
      id: string,
      filename: string,
      name: keyof typeof sources
    ) =>
      await seedAsset({
        id,
        projectId,
        filename,
        folderId: "posts",
        file: {
          ...photoFile,
          name,
          format: name.endsWith("json") ? "json" : "mdx",
          meta: "{}",
          size: sources[name].length,
        },
      });
    await seedEntry("config", "collection", "config.json");
    await seedEntry("template", "template", "template.mdx");
    await seedEntry("entry", "post", "old.mdx");
    // The revision was uploaded before files recorded their project.
    await seed.file(db, {
      ...photoFile,
      name: "new.mdx",
      format: "mdx",
      meta: "{}",
      size: sources["new.mdx"].length,
      uploaderProjectId: null,
    });

    await expect(
      patchAssets(
        { projectId, assetStore: createSourceAssetStore(sources) },
        [{ op: "replace", path: ["entry", "name"], value: "new.mdx" }],
        createContext()
      )
    ).resolves.toBeUndefined();
    expect(
      (await readAssets(projectId)).find((asset) => asset.id === "entry")?.name
    ).toBe("new.mdx");
  });

  test("loads only requested assets", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedAsset({ id: "asset-1", projectId, file: photoFile });
    await seedAsset({
      id: "asset-2",
      projectId,
      file: { ...photoFile, name: "other.jpg" },
    });

    await expect(
      loadAssetsByProjectWithClient(projectId, db, ["asset-1"])
    ).resolves.toEqual([expect.objectContaining({ id: "asset-1" })]);
  });

  test("does not query when no asset ids are requested", async () => {
    const projectId = uid();
    const { counter, countingDb } = countingQueries("select", assetTable);

    await expect(
      loadAssetsByProjectWithClient(projectId, countingDb, [])
    ).resolves.toEqual([]);
    expect(counter.count).toBe(0);
  });

  test("loads incomplete upload reservations for conflict checks", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedFolders(projectId, [{ id: "posts", name: "posts" }]);
    await seedAsset({
      id: "uploading-entry",
      projectId,
      filename: "hello-world",
      folderId: "posts",
      file: {
        name: "uploading-entry.mdx",
        status: "UPLOADING",
        createdAt: "2026-09-03T12:00:00.000Z",
        updatedAt: "2026-09-03T12:00:00.000Z",
      },
    });
    await seedAsset({
      id: "stale-entry",
      projectId,
      filename: "hello-world",
      folderId: "posts",
      file: {
        name: "stale-entry.mdx",
        status: "UPLOADING",
        createdAt: "2026-09-03T10:00:00.000Z",
        updatedAt: "2026-09-03T10:00:00.000Z",
      },
    });

    await expect(
      loadAssetUploadReservationsByProjectWithClient(
        projectId,
        db,
        new Date("2026-09-03T12:15:00.000Z")
      )
    ).resolves.toEqual([
      {
        id: "uploading-entry",
        name: "uploading-entry.mdx",
        filename: "hello-world",
        folderId: "posts",
        createdAt: "2026-09-03T12:00:00.000Z",
        status: "UPLOADING",
      },
    ]);
  });

  test("does not delete a file when the exact upload reservation is missing", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedAsset({
      id: "reserved",
      projectId,
      file: { name: "reservation.mdx", status: "UPLOADING" },
    });

    await deleteAssetUploadReservationWithClient(
      { projectId, assetId: "missing", name: "reservation.mdx" },
      db
    );

    expect(await readFile("reservation.mdx")).toBeDefined();
    expect(await readAssets(projectId)).toHaveLength(1);
  });

  test("chunks large requested asset id filters", async () => {
    const projectId = uid();
    const { counter, countingDb } = countingQueries("select", assetTable);
    const assetIds = Array.from(
      { length: 201 },
      (_, index) => `asset-${String(index).padStart(3, "0")}`
    );

    await expect(
      loadAssetsByProjectWithClient(projectId, countingDb, assetIds)
    ).resolves.toEqual([]);

    expect(counter.count).toBe(3);
  });

  test("rejects assets that are patched into another project", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedAsset({ id: "asset-1", projectId, file: photoFile });

    await expect(
      patchAssetsWithClient({ projectId, client: db }, [
        {
          op: "replace",
          path: ["asset-1", "projectId"],
          value: "another-project",
        },
      ])
    ).rejects.toThrow("belongs to another project");
  });

  const fontFile = {
    ...photoFile,
    name: "font.woff2",
    format: "woff2",
    meta: JSON.stringify({ family: "Inter", style: "normal", weight: 400 }),
  };

  test("preserves mutable file metadata in the validation snapshot", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedAsset({ id: "asset-1", projectId, file: fontFile });
    const nextMeta = {
      family: "Inter",
      style: "normal" as const,
      weight: 600,
    };
    let validatedMeta: unknown;

    await patchAssetsWithClient(
      { projectId, client: db },
      [{ op: "replace", path: ["asset-1", "meta"], value: nextMeta }],
      {
        validate: async ({ next }) => {
          validatedMeta = next.get("asset-1")?.meta;
        },
      }
    );

    expect(validatedMeta).toEqual(nextMeta);
    expect((await readFile("font.woff2")).meta).toBe(JSON.stringify(nextMeta));
  });

  test("rejects invalid font metadata before persisting a raw asset patch", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedAsset({ id: "asset-1", projectId, file: fontFile });

    await expect(
      patchAssetsWithClient({ projectId, client: db }, [
        {
          op: "replace",
          path: ["asset-1", "meta"],
          value: { family: "Inter", style: "normal" },
        },
      ])
    ).rejects.toThrow();
    expect((await readFile("font.woff2")).meta).toBe(fontFile.meta);
  });

  test("updates only supplied metadata and reloads only that asset", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedAsset({
      id: "asset-1",
      projectId,
      filename: "photo.jpg",
      description: "Old",
      file: photoFile,
    });

    await expect(
      updateAssetMetadataWithClient(
        { projectId, assetId: "asset-1", values: { description: null } },
        db
      )
    ).resolves.toEqual(
      expect.objectContaining({ id: "asset-1", description: undefined })
    );
    expect(await readAssets(projectId)).toEqual([
      expect.objectContaining({ filename: "photo.jpg", description: null }),
    ]);
  });

  test("updates an asset filename only when the expected value is current", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedAsset({
      id: "asset-1",
      projectId,
      filename: "template",
      file: photoFile,
    });

    await expect(
      updateAssetFilenameIfCurrentWithClient(
        {
          projectId,
          assetId: "asset-1",
          expectedFilename: "template",
          filename: "post-template",
        },
        db
      )
    ).resolves.toEqual(
      expect.objectContaining({ id: "asset-1", filename: "post-template" })
    );
  });

  test("reports when a conditional filename update loses a race", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    // Someone else already set a filename.
    await seedAsset({
      id: "asset-1",
      projectId,
      filename: "taken",
      file: photoFile,
    });
    const { counter, countingDb } = countingQueries("select", assetTable);

    await expect(
      updateAssetFilenameIfCurrentWithClient(
        {
          projectId,
          assetId: "asset-1",
          expectedFilename: undefined,
          filename: "post-template",
        },
        countingDb
      )
    ).resolves.toBeUndefined();
    expect(counter.count).toBe(0);
    expect((await readAssets(projectId))[0].filename).toBe("taken");
  });

  test("reports a missing metadata update as a repository not-found error", async () => {
    const projectId = uid();

    await expect(
      updateAssetMetadataWithClient(
        { projectId, assetId: "missing", values: { description: "Missing" } },
        db
      )
    ).rejects.toBeInstanceOf(AssetRepositoryNotFoundError);
  });

  test("reports a missing deletion as a repository not-found error", async () => {
    const projectId = uid();

    await expect(
      deleteAssetsWithClient({ projectId, ids: ["missing"] }, db)
    ).rejects.toBeInstanceOf(AssetRepositoryNotFoundError);
  });
});

const configSource = createDefaultCollectionConfig();
const templateSource = "---\ndraft: true\n---\n\nStart writing.\n";
const entrySource =
  "---\ntitle: Hello world\nslug: hello-world\ndraft: true\n---\n\nBody.\n";

/** A "posts" collection: its folder, config and template. */
const seedCollection = async (
  projectId: string,
  { config = configSource }: { config?: string } = {}
) => {
  await seedFolders(projectId, [{ id: "posts", name: "posts" }]);
  await seedAsset({
    id: "config",
    projectId,
    filename: "collection",
    folderId: "posts",
    file: {
      ...photoFile,
      name: "config-storage.json",
      format: "json",
      size: config.length,
      meta: "{}",
    },
  });
  await seedAsset({
    id: "template",
    projectId,
    filename: "template",
    folderId: "posts",
    file: {
      ...photoFile,
      name: "template-storage.mdx",
      format: "mdx",
      size: templateSource.length,
      meta: "{}",
    },
  });
};

const collectionSources = (config = configSource) => ({
  "config-storage.json": config,
  "template-storage.mdx": templateSource,
});

describe("patchAssets", () => {
  test("throws when caller lacks edit access", async () => {
    const projectId = uid();
    await seed.project(db, { id: projectId, userId: "owner-1" });

    await expect(
      patchAssets(
        { projectId, assetStore: unusedAssetStore },
        [],
        createContext()
      )
    ).rejects.toThrow("You don't have edit access");
  });

  test("no-op when patches are empty and no assets exist", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);

    // Should complete without throwing
    await patchAssets(
      { projectId, assetStore: unusedAssetStore },
      [],
      createContext()
    );
  });

  test("updates asset description via patch", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedAsset({ id: "asset-1", projectId, file: photoFile });

    await patchAssets(
      { projectId, assetStore: unusedAssetStore },
      [
        {
          op: "replace",
          path: ["asset-1", "description"],
          value: "New description",
        },
      ],
      createContext()
    );
    expect((await readAssets(projectId))[0].description).toBe(
      "New description"
    );
  });

  test("requires build access to patch collection configuration assets", async () => {
    const projectId = uid();
    await seedEditorProject(projectId);
    await seedCollection(projectId);

    await expect(
      patchAssets(
        {
          projectId,
          assetStore: createSourceAssetStore(collectionSources()),
        },
        [
          {
            op: "replace",
            path: ["template", "description"],
            value: "Reserved",
          },
        ],
        createContext()
      )
    ).rejects.toThrow("permission to configure");
    expect(
      (await readAssets(projectId)).find((asset) => asset.id === "template")
        ?.description
    ).toBeNull();
  });

  test("rejects mismatched asset map keys before collection authorization", async () => {
    const projectId = uid();
    await seedEditorProject(projectId);
    await seedFolders(projectId, [{ id: "posts", name: "posts" }]);
    await seedAsset({
      id: "template",
      projectId,
      filename: "template",
      folderId: "posts",
      file: {
        ...photoFile,
        name: "template-storage.mdx",
        format: "mdx",
        size: templateSource.length,
        meta: "{}",
      },
    });
    await seed.file(db, {
      ...photoFile,
      name: "config-storage.json",
      format: "json",
      size: configSource.length,
      meta: "{}",
      updatedAt: "2026-09-03T00:00:00.000Z",
      isDeleted: true,
      uploaderProjectId: projectId,
    });

    await expect(
      patchAssets(
        {
          projectId,
          assetStore: createSourceAssetStore(collectionSources()),
        },
        [
          {
            op: "add",
            path: ["forged-map-key"],
            value: {
              id: "config",
              projectId,
              name: "config-storage.json",
              filename: "collection",
              folderId: "posts",
              type: "file",
              format: "json",
              size: configSource.length,
              description: null,
              createdAt: photoFile.createdAt,
              meta: {},
            },
          },
        ],
        createContext()
      )
    ).rejects.toThrow("does not match its map key");
    expect(await readAssets(projectId)).toHaveLength(1);
  });

  test("validates collection moves with authoritative file metadata", async () => {
    const projectId = uid();
    const schema = JSON.parse(createDefaultCollectionConfig());
    schema["x-webstudio"].entries = ["*"];
    const config = JSON.stringify(schema);
    await seedOwnProject(projectId);
    await seedCollection(projectId, { config });
    await seedAsset({
      id: "entry",
      projectId,
      filename: "hello-world",
      file: {
        ...photoFile,
        name: "entry-storage.txt",
        format: "txt",
        size: entrySource.length,
        meta: "{}",
      },
    });

    await expect(
      patchAssets(
        {
          projectId,
          assetStore: createSourceAssetStore({
            ...collectionSources(config),
            "entry-storage.txt": entrySource,
          }),
        },
        [
          { op: "replace", path: ["entry", "format"], value: "mdx" },
          { op: "add", path: ["entry", "folderId"], value: "posts" },
        ],
        createContext()
      )
    ).rejects.toThrow('Collection entry "hello-world.txt" must be an MDX file');
    expect(
      (await readAssets(projectId)).find((asset) => asset.id === "entry")
        ?.folderId
    ).toBeNull();
  });

  test("restores a valid collection entry through a sync patch", async () => {
    const projectId = uid();
    await seedEditorProject(projectId);
    await seedCollection(projectId);
    for (const name of ["entry-storage.mdx", "invalid-entry-storage.mdx"]) {
      await seed.file(db, {
        ...photoFile,
        name,
        format: "mdx",
        size: entrySource.length,
        meta: "{}",
        updatedAt: "2026-09-03T00:00:00.000Z",
        uploaderProjectId: projectId,
      });
    }
    const entryValue = (id: string, name: string, filename: string) => ({
      id,
      projectId,
      name,
      filename,
      folderId: "posts",
      type: "file",
      format: "mdx",
      size: entrySource.length,
      description: null,
      createdAt: "2026-09-03T00:00:00.000Z",
      meta: {},
    });

    await expect(
      patchAssets(
        {
          projectId,
          assetStore: createSourceAssetStore({
            ...collectionSources(),
            "entry-storage.mdx": entrySource,
            "invalid-entry-storage.mdx": entrySource,
          }),
        },
        [
          {
            op: "add",
            path: ["invalid-entry"],
            value: entryValue(
              "invalid-entry",
              "invalid-entry-storage.mdx",
              "different-slug"
            ),
          },
        ],
        createContext()
      )
    ).rejects.toThrow("slug must match the entry filename");
    expect(await readAssets(projectId)).toHaveLength(2);

    await expect(
      patchAssets(
        {
          projectId,
          assetStore: createSourceAssetStore({
            ...collectionSources(),
            "entry-storage.mdx": entrySource,
          }),
        },
        [
          {
            op: "add",
            path: ["entry"],
            value: entryValue("entry", "entry-storage.mdx", "hello-world"),
          },
        ],
        createContext()
      )
    ).resolves.toBeUndefined();
    expect((await readAssets(projectId)).map((asset) => asset.id)).toContain(
      "entry"
    );
  });

  test("moves a valid entry back into its collection through a sync patch", async () => {
    const projectId = uid();
    await seedEditorProject(projectId);
    await seedCollection(projectId);
    await seedAsset({
      id: "entry",
      projectId,
      filename: "hello-world",
      file: {
        ...photoFile,
        name: "entry-storage.mdx",
        format: "mdx",
        size: entrySource.length,
        meta: "{}",
      },
    });

    await expect(
      patchAssets(
        {
          projectId,
          assetStore: createSourceAssetStore({
            ...collectionSources(),
            "entry-storage.mdx": entrySource,
          }),
        },
        [{ op: "add", path: ["entry", "folderId"], value: "posts" }],
        createContext()
      )
    ).resolves.toBeUndefined();
    expect(
      (await readAssets(projectId)).find((asset) => asset.id === "entry")
        ?.folderId
    ).toBe("posts");
  });

  test("allows invalid collection entries to be repaired one at a time", async () => {
    const projectId = uid();
    const invalidEntrySource = "---\nslug: missing-title\ndraft: true\n---\n";
    await seedOwnProject(projectId);
    await seedCollection(projectId);
    for (const [id, filename] of [
      ["first-entry", "missing-title"],
      ["second-entry", "also-missing-title"],
    ]) {
      await seedAsset({
        id,
        projectId,
        filename,
        folderId: "posts",
        file: {
          ...photoFile,
          name: `${id}-storage.mdx`,
          format: "mdx",
          size: invalidEntrySource.length,
          meta: "{}",
        },
      });
    }

    await expect(
      patchAssets(
        {
          projectId,
          assetStore: createSourceAssetStore({
            ...collectionSources(),
            "first-entry-storage.mdx": invalidEntrySource,
            "second-entry-storage.mdx": invalidEntrySource,
          }),
        },
        [{ op: "remove", path: ["first-entry", "folderId"] }],
        createContext()
      )
    ).resolves.toBeUndefined();
    expect(
      (await readAssets(projectId)).find((asset) => asset.id === "first-entry")
        ?.folderId
    ).toBeNull();
  });

  test("renames supporting assets without validating unchanged entry content", async () => {
    const projectId = uid();
    const templateOnly = "---\ndraft: true\n---\n";
    await seedOwnProject(projectId);
    await seedFolders(projectId, [{ id: "posts", name: "posts" }]);
    for (const [id, filename, format, source] of [
      ["config", "collection", "json", configSource],
      ["template", "template", "mdx", templateOnly],
      ["invalid", "invalid", "mdx", "missing frontmatter"],
      ["notes", "notes", "txt", "notes"],
    ]) {
      await seedAsset({
        id,
        projectId,
        filename,
        folderId: "posts",
        file: {
          ...photoFile,
          name: `${id}.${format}`,
          format,
          size: source.length,
          meta: "{}",
        },
      });
    }
    const assetStore = createSourceAssetStore({
      "config.json": configSource,
      "template.mdx": templateOnly,
      // Neither ordinary content nor unchanged entries should be read.
    });

    await patchAssets(
      { projectId, assetStore },
      [{ op: "replace", path: ["notes", "filename"], value: "renamed" }],
      createContext()
    );
    expect(
      (await readAssets(projectId)).find((asset) => asset.id === "notes")
        ?.filename
    ).toBe("renamed");
    await expect(
      patchAssets(
        { projectId, assetStore },
        [
          {
            op: "replace",
            path: ["invalid", "filename"],
            value: "changed-entry",
          },
        ],
        createContext()
      )
    ).rejects.toThrow();
  });

  test("validates collection rules before persisting an asset patch", async () => {
    const projectId = uid();
    const schema = JSON.parse(createDefaultCollectionConfig());
    schema["x-webstudio"].entries = ["*"];
    const config = JSON.stringify(schema);
    await seedOwnProject(projectId);
    await seedFolders(projectId, [{ id: "posts", name: "posts" }]);
    for (const [name, format, size] of [
      ["config-storage.json", "json", config.length],
      ["template-storage.mdx", "mdx", templateSource.length],
      ["notes.txt", "txt", 5],
    ] as const) {
      await seed.file(db, {
        ...photoFile,
        name,
        format,
        size,
        meta: "{}",
        updatedAt: "2026-09-03T00:00:00.000Z",
        uploaderProjectId: projectId,
      });
    }
    const added = (
      id: string,
      name: string,
      filename: string,
      format: string,
      size: number
    ) => ({
      op: "add" as const,
      path: [id],
      value: {
        id,
        projectId,
        name,
        filename,
        folderId: "posts",
        type: "file",
        format,
        size,
        description: null,
        createdAt: "2026-09-03T00:00:00.000Z",
        meta: {},
      },
    });

    await expect(
      patchAssets(
        {
          projectId,
          assetStore: createSourceAssetStore(collectionSources(config)),
        },
        [
          added(
            "config",
            "config-storage.json",
            "collection",
            "json",
            config.length
          ),
          added(
            "template",
            "template-storage.mdx",
            "template",
            "mdx",
            templateSource.length
          ),
          added("notes", "notes.txt", "notes", "txt", 5),
        ],
        createContext()
      )
    ).rejects.toThrow('Collection entry "notes.txt" must be an MDX file');
    expect(await readAssets(projectId)).toEqual([]);
  });

  test("persists legacy null-provenance asset metadata via patch", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedAsset({
      id: "asset-1",
      projectId,
      file: {
        ...photoFile,
        name: "font.woff2",
        format: "woff2",
        meta: JSON.stringify({
          family: "Rajdhani",
          style: "normal",
          weight: 400,
        }),
        uploaderProjectId: null,
      },
    });

    await patchAssets(
      { projectId, assetStore: unusedAssetStore },
      [
        {
          op: "replace",
          path: ["asset-1", "meta"],
          value: { family: "Rajdhani", style: "normal", weight: 600 },
        },
      ],
      createContext()
    );

    await expect(loadAssetsByProjectWithClient(projectId, db)).resolves.toEqual(
      [
        expect.objectContaining({
          id: "asset-1",
          meta: { family: "Rajdhani", style: "normal", weight: 600 },
        }),
      ]
    );
  });

  test("updates asset filename via patch", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedAsset({
      id: "asset-1",
      projectId,
      filename: "photo.jpg",
      file: photoFile,
    });

    await patchAssets(
      { projectId, assetStore: unusedAssetStore },
      [
        {
          op: "replace",
          path: ["asset-1", "filename"],
          value: "renamed-photo.jpg",
        },
      ],
      createContext()
    );
    await expect(loadAssetsByProjectWithClient(projectId, db)).resolves.toEqual(
      [
        expect.objectContaining({
          id: "asset-1",
          filename: "renamed-photo.jpg",
        }),
      ]
    );
  });

  test("atomically swaps an asset file while preserving its id", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedAsset({ id: "asset-1", projectId, file: photoFile });
    await seed.file(db, {
      ...photoFile,
      name: "photo_revision.jpg",
      uploaderProjectId: projectId,
    });

    await patchAssetsWithClient({ projectId, client: db }, [
      {
        op: "replace",
        path: ["asset-1", "name"],
        value: "photo_revision.jpg",
      },
    ]);

    expect(await readAssets(projectId)).toEqual([
      expect.objectContaining({ id: "asset-1", name: "photo_revision.jpg" }),
    ]);
    // The replaced revision is no longer referenced.
    expect((await readFile("photo.jpg")).isDeleted).toBe(true);
  });

  test("restores a shared clone file without requiring an owned revision", async () => {
    const projectId = uid();
    const sourceProjectId = uid();
    const authoritativeMeta = { width: 1200, height: 800 };
    const forgedMeta = { width: 9999, height: 9999 };
    const staleMeta = { width: 320, height: 200 };
    await seedOwnProject(projectId);
    await seedOwnProject(sourceProjectId);
    const sharedFile = {
      ...photoFile,
      name: "original_shared.jpg",
      size: 2000,
      meta: JSON.stringify(authoritativeMeta),
      uploaderProjectId: sourceProjectId,
      contentHash: "a".repeat(64),
      updatedAt: "2026-09-06T00:00:00.000Z",
    };
    await seed.file(db, sharedFile);
    await seedAsset({
      id: "entry",
      projectId,
      filename: "post",
      file: {
        ...sharedFile,
        name: "current_clone.jpg",
        size: 1000,
        meta: JSON.stringify(staleMeta),
        uploaderProjectId: projectId,
        contentHash: "f".repeat(64),
      },
    });
    const patches: Patch[] = [
      { op: "replace", path: ["entry", "name"], value: sharedFile.name },
      { op: "replace", path: ["entry", "meta"], value: authoritativeMeta },
    ];

    await expect(
      patchAssets(
        { projectId, assetStore: unusedAssetStore },
        [
          patches[0]!,
          { op: "replace", path: ["entry", "meta"], value: forgedMeta },
        ],
        createContext()
      )
    ).rejects.toThrow("Shared asset metadata does not match its file");
    expect((await readAssets(projectId))[0].name).toBe("current_clone.jpg");
    expect((await readFile(sharedFile.name)).meta).toBe(sharedFile.meta);

    await patchAssets(
      { projectId, assetStore: unusedAssetStore },
      patches,
      createContext()
    );
    await patchAssets(
      { projectId, assetStore: unusedAssetStore },
      patches,
      createContext()
    );

    expect((await readAssets(projectId))[0].name).toBe(sharedFile.name);
    expect(await readFile(sharedFile.name)).toMatchObject({
      meta: sharedFile.meta,
      isDeleted: false,
      uploaderProjectId: sourceProjectId,
    });
  });

  test("persists moving an asset to root as null", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedFolders(projectId, [{ id: "folder", name: "folder" }]);
    await seedAsset({
      id: "asset-1",
      projectId,
      filename: "post",
      folderId: "folder",
      file: {
        ...photoFile,
        name: "stored.md",
        format: "md",
        size: 100,
        meta: "{}",
      },
    });

    await patchAssets(
      { projectId, assetStore: unusedAssetStore },
      [{ op: "remove", path: ["asset-1", "folderId"] }],
      createContext()
    );
    expect((await readAssets(projectId))[0].folderId).toBeNull();
  });

  test("does not update metadata when adding an existing asset", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedAsset({ id: "asset-1", projectId, file: photoFile });
    const { counter, countingDb } = countingQueries("update", assetTable);

    const [asset] = await loadAssetsByProjectWithClient(projectId, db);
    await patchAssets(
      { projectId, assetStore: unusedAssetStore },
      [{ op: "add", path: [asset.id], value: asset }],
      createContext(countingDb)
    );

    expect(counter.count).toBe(0);
  });

  test("throws when an asset metadata update matches no database row", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seedAsset({ id: "asset-1", projectId, file: photoFile });
    // The asset is deleted after the patch loaded it.
    let deleted = false;
    const racingDb = withQueryHook(db, async ({ kind, table }) => {
      if (kind === "select" && table === assetTable && deleted === false) {
        deleted = true;
        await db.delete(assetTable).where(eq(assetTable.id, "asset-1"));
      }
    });

    await expect(
      patchAssets(
        { projectId, assetStore: unusedAssetStore },
        [
          {
            op: "replace",
            path: ["asset-1", "filename"],
            value: "renamed-photo.jpg",
          },
        ],
        createContext(racingDb)
      )
    ).rejects.toThrow();
  });

  const newAssetPatch = (projectId: string): Patch[] => [
    {
      op: "add",
      path: ["asset-new"],
      value: {
        id: "asset-new",
        name: "new.jpg",
        type: "image",
        projectId,
        format: "jpg",
        size: 500,
        description: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        path: "",
        meta: { width: 50, height: 50 },
      },
    },
  ];

  const newFile = (projectId: string) => ({
    ...photoFile,
    name: "new.jpg",
    size: 500,
    meta: JSON.stringify({ width: 50, height: 50 }),
    updatedAt: "2024-01-01T00:00:00.000Z",
    uploaderProjectId: projectId,
    // Deleted by the change that is being undone.
    isDeleted: true,
  });

  test("adds new asset when patch inserts an entry", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seed.file(db, newFile(projectId));

    await patchAssets(
      { projectId, assetStore: unusedAssetStore },
      newAssetPatch(projectId),
      createContext()
    );
    expect(await readAssets(projectId)).toEqual([
      expect.objectContaining({ id: "asset-new", name: "new.jpg" }),
    ]);
    expect((await readFile("new.jpg")).isDeleted).toBe(false);
  });

  const missingAssetValue = (projectId: string, name: string, size = 1) => ({
    id: name.replace(/\.jpg$/, ""),
    name,
    type: "image" as const,
    projectId,
    format: "jpg",
    size,
    description: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    meta: { width: size, height: size },
  });

  test("rejects an added asset whose file is unavailable", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);

    await expect(
      patchAssetsWithClient({ projectId, client: db }, [
        {
          op: "add",
          path: ["missing"],
          value: missingAssetValue(projectId, "missing.jpg"),
        },
      ])
    ).rejects.toThrow("Asset file not found for missing");
    expect(await readAssets(projectId)).toEqual([]);
  });

  test("rejects an added asset whose file is not fully uploaded", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seed.file(db, {
      ...photoFile,
      name: "uploading.jpg",
      status: "UPLOADING",
      isDeleted: true,
      uploaderProjectId: projectId,
    });

    await expect(
      patchAssets(
        { projectId, assetStore: unusedAssetStore },
        [
          {
            op: "add",
            path: ["uploading"],
            value: missingAssetValue(projectId, "uploading.jpg", 100),
          },
        ],
        createContext()
      )
    ).rejects.toThrow("Asset file not found");
    expect(await readAssets(projectId)).toEqual([]);
    expect((await readFile("uploading.jpg")).isDeleted).toBe(true);
  });

  test("chunks uploaded file lookups and restores by bounded filter size", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    const fileNames = Array.from(
      { length: 12 },
      (_, index) => `${String(index).padStart(2, "0")}-${"a".repeat(490)}.jpg`
    );
    for (const name of fileNames) {
      await seed.file(db, {
        ...photoFile,
        name,
        isDeleted: true,
        uploaderProjectId: projectId,
      });
    }
    const assetFileNames = [...fileNames, fileNames[0]!];
    let reads = 0;
    let restores = 0;
    const watchedDb = withQueryHook(db, ({ kind, table }) => {
      if (table !== fileTable) {
        return;
      }
      if (kind === "select") {
        reads += 1;
      }
      if (kind === "update") {
        restores += 1;
      }
    });

    await patchAssets(
      { projectId, assetStore: unusedAssetStore },
      assetFileNames.map((name, index) => ({
        op: "add" as const,
        path: [`asset-${index}`],
        value: {
          id: `asset-${index}`,
          name,
          type: "image" as const,
          projectId,
          format: "jpg",
          size: 1000,
          description: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          meta: { width: 100, height: 100 },
        },
      })),
      createContext(watchedDb)
    );

    expect(reads).toBeGreaterThan(2);
    expect(restores).toBeGreaterThan(1);
    expect(await readAssets(projectId)).toHaveLength(assetFileNames.length);
    for (const name of fileNames) {
      expect((await readFile(name)).isDeleted).toBe(false);
    }
  });

  /** asset-1 (photo.jpg), also the project's preview image. */
  const seedPreviewAsset = async (projectId: string) => {
    await seedOwnProject(projectId);
    await seedAsset({ id: "asset-1", projectId, file: photoFile });
    await db
      .update(projectTable)
      .set({ previewImageAssetId: "asset-1" })
      .where(eq(projectTable.id, projectId));
  };

  const removeAsset: Patch[] = [{ op: "remove", path: ["asset-1"] }];

  test("core helper deletes assets and marks unused files as deleted", async () => {
    const projectId = uid();
    await seedPreviewAsset(projectId);

    await patchAssetsWithClient({ projectId, client: db }, removeAsset);

    const [projectRow] = await db
      .select()
      .from(projectTable)
      .where(eq(projectTable.id, projectId));
    expect(projectRow.previewImageAssetId).toBeNull();
    expect(await readAssets(projectId)).toEqual([]);
    expect((await readFile("photo.jpg")).isDeleted).toBe(true);
  });

  test("core helper stops asset deletion when preview reset fails", async () => {
    const projectId = uid();
    await seedPreviewAsset(projectId);

    await expect(
      patchAssetsWithClient(
        { projectId, client: failingOn("update", projectTable) },
        removeAsset
      )
    ).rejects.toThrow();

    expect(await readAssets(projectId)).toHaveLength(1);
  });

  test("core helper stops file cleanup when asset delete fails", async () => {
    const projectId = uid();
    await seedPreviewAsset(projectId);

    await expect(
      patchAssetsWithClient(
        { projectId, client: failingOn("delete", assetTable) },
        removeAsset
      )
    ).rejects.toThrow();

    expect((await readFile("photo.jpg")).isDeleted).toBe(false);
  });

  test("core helper stops asset insert when file restore fails", async () => {
    const projectId = uid();
    await seedOwnProject(projectId);
    await seed.file(db, newFile(projectId));

    await expect(
      patchAssetsWithClient(
        { projectId, client: failingOn("update", fileTable) },
        newAssetPatch(projectId)
      )
    ).rejects.toThrow();

    expect(await readAssets(projectId)).toEqual([]);
  });
});
