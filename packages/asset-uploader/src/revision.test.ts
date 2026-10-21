import { describe, expect, test } from "vitest";
import {
  asset as assetTable,
  assetFileMetadata,
  eq,
  file as fileTable,
  type Db,
} from "@webstudio-is/db";
import { seed, setupTestDb, withQueryHook } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import {
  __testing__,
  AssetRevisionConflictError,
  updateAssetContent,
} from "./revision";
import { PostgresAssetRepository } from "./asset-repository";

const { getRevisionFilename } = __testing__;
const db = setupTestDb();

const readEmptyFile = async () => ({
  data: {
    async *[Symbol.asyncIterator]() {},
  },
});

const createContext = (contextDb: Db = db): AppContext =>
  ({
    db: contextDb,
    authorization: { type: "user", userId: "user-1" },
    getOwnerPlanFeatures: async () => ({}),
  }) as unknown as AppContext;

const oldFile = {
  name: "settings_old-revision.json",
  format: "json",
  size: 2,
  uploaderProjectId: "project",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  meta: "{}",
};

/** "project" (owned by user-1) with one asset in folder "data". */
const seedAsset = async (overrides: Partial<typeof oldFile> = {}) => {
  const fileRow = { ...oldFile, ...overrides };
  await seed.project(db, { id: "project", userId: "user-1" });
  await seed.assetFolder(db, { id: "data", projectId: "project" });
  await seed.asset(
    db,
    {
      id: "asset",
      projectId: "project",
      name: fileRow.name,
      description: "Settings",
      folderId: "data",
    },
    fileRow
  );
};

const readAsset = async () =>
  (await db.select().from(assetTable).where(eq(assetTable.id, "asset")))[0];

const readFile = async (name: string) =>
  (await db.select().from(fileTable).where(eq(fileTable.name, name)))[0];

describe("asset content revisions", () => {
  test("keeps the display basename when generating revision keys", () => {
    expect(
      getRevisionFilename({
        name: "settings_old-revision.json",
        filename: null,
      })
    ).toBe("settings.json");
    expect(
      getRevisionFilename({
        name: "settings_old-revision.json",
        filename: "configuration",
      })
    ).toBe("configuration.json");
    expect(
      getRevisionFilename({
        name: "test_nCEugJxJwUd_MJcgPodZr.md",
        filename: null,
      })
    ).toBe("test.md");
    expect(
      getRevisionFilename({
        name: "settings_old-revision.md",
        filename: "configuration",
        extension: "json",
      })
    ).toBe("configuration.json");
  });

  test("uploads an immutable revision and keeps the asset id", async () => {
    await seedAsset();
    let revisionName = "";

    const asset = await updateAssetContent(
      {
        assetId: "asset",
        projectId: "project",
        expectedName: oldFile.name,
        data: new Blob(['{"a":1}']).stream(),
      },
      {
        uploadFile: async (name, type, data) => {
          revisionName = name;
          expect(name).toMatch(/^settings_.+\.json$/);
          expect(type).toBe("file");
          expect(await new Response(data as ReadableStream).text()).toBe(
            '{"a":1}'
          );
          return { format: "json", size: 7, meta: {} };
        },
        readFile: readEmptyFile,
      },
      createContext()
    );

    expect(asset).toMatchObject({
      id: "asset",
      projectId: "project",
      name: revisionName,
      description: "Settings",
      folderId: "data",
      format: "json",
      createdAt: oldFile.createdAt,
    });
    expect(await readAsset()).toMatchObject({ name: revisionName });
    expect(await readFile(revisionName)).toMatchObject({
      status: "UPLOADED",
      size: 7,
      uploaderProjectId: "project",
      createdAt: oldFile.createdAt,
      isDeleted: false,
    });
    // The previous revision is no longer used.
    expect((await readFile(oldFile.name)).isDeleted).toBe(true);
  });

  test("reindexes replaced Markdown content only at a query synchronization boundary", async () => {
    const source = "---\ntitle: Updated post\n---\n\nUpdated body";
    const sourceBytes = new TextEncoder().encode(source);
    await seed.project(db, { id: "project", userId: "user-1" });
    await seed.assetFolder(db, { id: "data", projectId: "project" });
    await seed.asset(
      db,
      {
        id: "asset",
        projectId: "project",
        name: "post_old-revision.md",
        filename: "post",
        description: "Settings",
        folderId: "data",
      },
      { ...oldFile, name: "post_old-revision.md", format: "md", size: 3 }
    );
    let revisionName = "";

    const repository = new PostgresAssetRepository({
      projectId: "project",
      context: createContext(),
      assetStore: {
        uploadFile: async (name) => {
          revisionName = name;
          return { format: "md", size: sourceBytes.byteLength, meta: {} };
        },
        readFile: async (name) => {
          expect(name).toBe(revisionName);
          return { data: new Blob([source]).stream() };
        },
      },
    });
    await repository.updateContent({
      assetId: "asset",
      expectedName: "post_old-revision.md",
      data: new Blob([source]).stream(),
    });

    expect(await db.select().from(assetFileMetadata)).toEqual([]);
    await repository.synchronize();
    const [stored] = await db.select().from(assetFileMetadata);
    expect(stored?.document).toMatchObject({
      _id: "asset",
      name: "post.md",
      contentRef: revisionName,
      properties: { title: "Updated post" },
      excerpt: "Updated body",
    });
  });

  test("rejects a stale revision before uploading", async () => {
    await seedAsset({ name: "settings_newer.json" });

    await expect(
      updateAssetContent(
        {
          assetId: "asset",
          projectId: "project",
          expectedName: oldFile.name,
          data: new Blob(["stale"]).stream(),
        },
        {
          uploadFile: async () => {
            throw new Error("upload should not run");
          },
          readFile: readEmptyFile,
        },
        createContext()
      )
    ).rejects.toBeInstanceOf(AssetRevisionConflictError);
  });

  test("discards an uploaded revision when the atomic swap conflicts", async () => {
    await seedAsset();
    await seed.file(db, {
      name: "settings_concurrent.json",
      uploaderProjectId: "project",
    });
    let revisionName = "";
    // Another save replaces the file while this upload is finishing.
    const racingDb = withQueryHook(db, async ({ kind, table }) => {
      if (kind === "update" && table === fileTable && revisionName !== "") {
        await db
          .update(assetTable)
          .set({ name: "settings_concurrent.json" })
          .where(eq(assetTable.id, "asset"));
      }
    });

    await expect(
      new PostgresAssetRepository({
        projectId: "project",
        context: createContext(racingDb),
        assetStore: {
          uploadFile: async (name) => {
            revisionName = name;
            return { format: "json", size: 7, meta: {} };
          },
          readFile: readEmptyFile,
        },
      }).updateContent({
        assetId: "asset",
        expectedName: oldFile.name,
        data: new Blob(["updated"]).stream(),
      })
    ).rejects.toBeInstanceOf(AssetRevisionConflictError);
    expect((await readFile(revisionName)).isDeleted).toBe(true);
    expect((await readAsset()).name).toBe("settings_concurrent.json");
  });

  test("accepts a committed revision when the swap response fails", async () => {
    await seedAsset();
    // The swap commits, but its response is lost.
    const flakyDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return async (...args: Parameters<Db["transaction"]>) => {
            await target.transaction(...args);
            throw new Error("Connection lost");
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(
      updateAssetContent(
        {
          assetId: "asset",
          projectId: "project",
          expectedName: oldFile.name,
          data: new Blob(["updated"]).stream(),
        },
        {
          uploadFile: async () => ({ format: "json", size: 7, meta: {} }),
          readFile: readEmptyFile,
        },
        createContext(flakyDb)
      )
    ).resolves.toMatchObject({
      id: "asset",
      name: expect.stringMatching(/^settings_.+\.json$/),
      format: "json",
    });
  });
});
