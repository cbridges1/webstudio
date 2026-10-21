import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { buffer } from "node:stream/consumers";
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
  AssetUploadCountLimitError,
  createUploadTicket,
  uploadFile,
} from "./upload";
import { PostgresAssetRepository } from "./asset-repository";
import { applyAssetDataOverride, getAssetData } from "./utils/get-asset-data";
import type { AssetObjectWriter } from "./client";

const db = setupTestDb();

const createContext = ({
  maxAssetsPerProject = 350,
  maxWorkspaces = 20,
  ownerPlanCalls,
  contextDb = db,
}: {
  maxAssetsPerProject?: number;
  maxWorkspaces?: number;
  ownerPlanCalls?: string[];
  contextDb?: Db;
} = {}): AppContext =>
  ({
    db: contextDb,
    authorization: { type: "user", userId: "user-1" },
    planFeatures: { maxAssetsPerProject: 100 },
    getOwnerPlanFeatures: (userId: string) => {
      ownerPlanCalls?.push(userId);
      return Promise.resolve({ maxAssetsPerProject, maxWorkspaces });
    },
  }) as unknown as AppContext;

const uploadedFile = {
  name: "existing.png",
  format: "png",
  size: 4,
  status: "UPLOADED" as const,
  isDeleted: false,
  uploaderProjectId: "project-1",
  contentHash: "hash-1",
  meta: JSON.stringify({ width: 1, height: 1 }),
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

/** A project owned by user-1. */
const seedProject = async (id = "project-1") => {
  await seed.project(db, { id, userId: "user-1" });
};

const seedUploadedFile = async (overrides: Partial<typeof uploadedFile> = {}) =>
  await seed.file(db, { ...uploadedFile, ...overrides });

/** `count` uploaded assets in the project. */
const seedUploadedAssets = async (projectId: string, count: number) => {
  if (count === 0) {
    return;
  }
  const names = Array.from({ length: count }, (_, index) => ({
    id: `existing-${index}`,
    name: `${projectId}-existing-${index}.png`,
  }));
  await db.insert(fileTable).values(
    names.map(({ name }) => ({
      name,
      format: "png",
      size: 1,
      status: "UPLOADED" as const,
      uploaderProjectId: projectId,
    }))
  );
  await db
    .insert(assetTable)
    .values(names.map((asset) => ({ ...asset, projectId })));
};

const projectAssets = async (projectId = "project-1") =>
  await db.select().from(assetTable).where(eq(assetTable.projectId, projectId));

const readFile = async (name: string) =>
  (await db.select().from(fileTable).where(eq(fileTable.name, name)))[0];

/** The asset id a deduplicated upload gives to content it reuses. */
const deduplicatedAssetId = (
  projectId: string,
  name: string,
  identity: {
    filename: string;
    description: string | null;
    folderId: string | null;
  }
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

describe("createUploadTicket", () => {
  test.each([
    { meta: "{}", isDeleted: false },
    { meta: "{}", isDeleted: true },
    { meta: "{invalid json", isDeleted: false },
    { meta: "{invalid json", isDeleted: true },
  ])(
    "re-uploads a malformed font ($meta, deleted: $isDeleted)",
    async ({ meta, isDeleted }) => {
      const require = createRequire(import.meta.url);
      const bytes = readFileSync(
        require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2")
      );
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      await seedProject();
      await seedUploadedFile({
        name: "inter_old.woff2",
        format: "woff2",
        size: bytes.byteLength,
        contentHash,
        meta,
        isDeleted,
      });
      if (isDeleted === false) {
        await db.insert(assetTable).values({
          id: "old-asset",
          projectId: "project-1",
          name: "inter_old.woff2",
          filename: "inter",
        });
      }

      const input = {
        projectId: "project-1",
        type: "font",
        filename: "inter.woff2",
        contentHash,
      };
      const ticket = await createUploadTicket(
        input,
        createContext(),
        () => "new-asset"
      );
      expect(ticket.deduplicated).toBe(false);
      expect(ticket.name).not.toBe("inter_old.woff2");
      // The broken file keeps its references but no longer deduplicates.
      expect(await readFile("inter_old.woff2")).toMatchObject({
        meta,
        isDeleted,
        contentHash: null,
      });
      expect(await projectAssets()).toHaveLength(isDeleted ? 1 : 2);

      const writer: AssetObjectWriter = {
        uploadFile: async (name, _type, data) => {
          const uploaded = await buffer(data);
          expect(uploaded).toEqual(bytes);
          return applyAssetDataOverride(
            await getAssetData({
              type: "font",
              name,
              size: uploaded.byteLength,
              data: uploaded,
            })
          );
        },
      };
      const asset = await uploadFile(
        ticket.name,
        new Blob([new Uint8Array(bytes)]).stream(),
        writer,
        createContext(),
        undefined
      );
      expect(asset).toMatchObject({
        id: "new-asset",
        type: "font",
        format: "woff2",
        meta: { family: "Inter" },
      });
      await expect(
        createUploadTicket(input, createContext())
      ).resolves.toMatchObject({
        deduplicated: true,
        asset,
      });
      expect(await db.select().from(fileTable)).toHaveLength(2);
    }
  );

  test("rechecks a font repaired while excluding its old metadata from deduplication", async () => {
    await seedProject();
    await seedUploadedFile({
      name: "inter.woff2",
      format: "woff2",
      meta: "{}",
    });
    await db.insert(assetTable).values({
      id: "font-1",
      projectId: "project-1",
      name: "inter.woff2",
      filename: "inter",
    });
    const repairedMeta = { family: "Inter", style: "normal", weight: 400 };
    // Another request repairs the metadata after this one read the file.
    let repaired = false;
    const racingDb = withQueryHook(db, async ({ kind, table }) => {
      if (kind === "select" && table === fileTable && repaired === false) {
        repaired = true;
        await db
          .update(fileTable)
          .set({ meta: JSON.stringify(repairedMeta) })
          .where(eq(fileTable.name, "inter.woff2"));
      }
    });

    await expect(
      createUploadTicket(
        {
          projectId: "project-1",
          type: "font",
          filename: "inter.woff2",
          contentHash: "hash-1",
        },
        createContext({ contextDb: racingDb })
      )
    ).resolves.toMatchObject({
      deduplicated: true,
      asset: { id: "font-1", type: "font", meta: repairedMeta },
    });
    expect((await readFile("inter.woff2")).contentHash).toBe("hash-1");
  });

  test("reuses an uploaded asset with the same content and display name", async () => {
    await seedProject();
    await seedUploadedFile();
    await db.insert(assetTable).values({
      id: "existing-asset",
      projectId: "project-1",
      name: "existing.png",
      filename: "existing",
    });

    await expect(
      createUploadTicket(
        {
          projectId: "project-1",
          type: "image/png",
          filename: "existing.png",
          contentHash: "hash-1",
        },
        createContext()
      )
    ).resolves.toMatchObject({
      assetId: "existing-asset",
      name: "existing.png",
      deduplicated: true,
      asset: { id: "existing-asset", name: "existing.png", type: "image" },
    });
    expect(await db.select().from(fileTable)).toHaveLength(1);
    expect(await projectAssets()).toHaveLength(1);
  });

  test("creates a distinct logical asset for a different display name", async () => {
    await seedProject();
    await seedUploadedFile({ name: "first.md", format: "text/markdown" });
    await db.insert(assetTable).values({
      id: "first-asset",
      projectId: "project-1",
      name: "first.md",
      filename: "first",
    });

    const ticket = await createUploadTicket(
      {
        projectId: "project-1",
        type: "text/markdown",
        filename: "second.md",
        contentHash: "hash-1",
      },
      createContext()
    );

    expect(ticket).toMatchObject({
      name: "first.md",
      deduplicated: true,
      asset: { filename: "second" },
    });
    expect(
      (await projectAssets()).find((asset) => asset.id === ticket.assetId)
    ).toMatchObject({
      projectId: "project-1",
      name: "first.md",
      filename: "second",
    });
  });

  test("does not reuse content stored with a different extension", async () => {
    await seedProject();
    await seedUploadedFile({ name: "first.md", format: "text/markdown" });

    const ticket = await createUploadTicket(
      {
        projectId: "project-1",
        type: "text/plain",
        filename: "second.txt",
        contentHash: "hash-1",
      },
      createContext(),
      () => "second-asset"
    );

    expect(ticket).toMatchObject({
      assetId: "second-asset",
      name: expect.stringMatching(/^second_.+\.txt$/),
      deduplicated: false,
    });
    expect(await readFile(ticket.name)).toMatchObject({
      format: "text/plain",
      contentHash: "hash-1",
      status: "UPLOADING",
    });
  });

  test("creates a distinct logical asset for different metadata", async () => {
    await seedProject();
    await seed.assetFolder(db, { id: "campaign", projectId: "project-1" });
    await seedUploadedFile();
    await db.insert(assetTable).values({
      id: "existing-asset",
      projectId: "project-1",
      name: "existing.png",
      filename: "existing",
    });

    const ticket = await createUploadTicket(
      {
        projectId: "project-1",
        type: "image/png",
        filename: "existing.png",
        description: "Campaign photo",
        folderId: "campaign",
        contentHash: "hash-1",
      },
      createContext()
    );

    expect(ticket).toMatchObject({
      name: "existing.png",
      deduplicated: true,
      asset: {
        filename: "existing",
        description: "Campaign photo",
        folderId: "campaign",
      },
    });
    expect(ticket.assetId).not.toBe("existing-asset");
    expect(
      (await projectAssets()).find((asset) => asset.id === ticket.assetId)
    ).toMatchObject({
      name: "existing.png",
      filename: "existing",
      description: "Campaign photo",
      folderId: "campaign",
    });
  });

  test("restores a soft-deleted file with the same content hash", async () => {
    await seedProject();
    await seedUploadedFile({ isDeleted: true });

    const ticket = await createUploadTicket(
      {
        projectId: "project-1",
        type: "image/png",
        filename: "photo.png",
        contentHash: "hash-1",
      },
      createContext(),
      () => "new-asset"
    );

    expect(ticket).toMatchObject({
      assetId: expect.any(String),
      name: "existing.png",
      deduplicated: true,
      asset: { id: expect.any(String), name: "existing.png" },
    });
    if (ticket.deduplicated === false) {
      throw new Error("Expected a deduplicated upload ticket");
    }
    expect(ticket.assetId).toBe(ticket.asset.id);
    expect((await readFile("existing.png")).isDeleted).toBe(false);
    expect(await projectAssets()).toEqual([
      expect.objectContaining({
        id: ticket.assetId,
        name: "existing.png",
        filename: "photo",
      }),
    ]);
  });

  test("reuses an uploaded file without an asset", async () => {
    await seedProject();
    await seedUploadedFile({ name: "orphan.png" });

    const ticket = await createUploadTicket(
      {
        projectId: "project-1",
        type: "image/png",
        filename: "photo.png",
        contentHash: "hash-1",
      },
      createContext(),
      () => "new-asset"
    );
    expect(ticket).toMatchObject({
      assetId: expect.any(String),
      name: "orphan.png",
      deduplicated: true,
    });
    expect(await projectAssets()).toHaveLength(1);
  });

  test("reuses the asset restored by a concurrent deduplicated upload", async () => {
    await seedProject();
    await seedUploadedFile({ isDeleted: true });
    const assetId = deduplicatedAssetId("project-1", "existing.png", {
      filename: "photo",
      description: null,
      folderId: null,
    });
    // A concurrent upload of the same content inserts the asset first.
    let raced = false;
    const racingDb = withQueryHook(db, async ({ kind, table }) => {
      if (kind === "select" && table === assetTable && raced === false) {
        raced = true;
        await db.insert(assetTable).values({
          id: assetId,
          projectId: "project-1",
          name: "existing.png",
          filename: "photo",
        });
      }
    });

    await expect(
      createUploadTicket(
        {
          projectId: "project-1",
          type: "image/png",
          filename: "photo.png",
          contentHash: "hash-1",
        },
        createContext({ contextDb: racingDb })
      )
    ).resolves.toMatchObject({
      assetId,
      name: "existing.png",
      deduplicated: true,
    });
    expect(await projectAssets()).toHaveLength(1);
  });

  test("enforces the asset limit before restoring deduplicated content", async () => {
    await seedProject();
    await seedUploadedAssets("project-1", 3);
    await seedUploadedFile({ isDeleted: true });

    await expect(
      createUploadTicket(
        {
          projectId: "project-1",
          type: "image/png",
          filename: "photo.png",
          contentHash: "hash-1",
        },
        createContext({ maxAssetsPerProject: 3 })
      )
    ).rejects.toBeInstanceOf(AssetUploadCountLimitError);
    expect(await projectAssets()).toHaveLength(3);
    expect((await readFile("existing.png")).isDeleted).toBe(true);
  });

  test("reuses the winning asset after a concurrent content hash insert", async () => {
    await seedProject();
    // A concurrent upload of the same content wins the file reservation.
    let raced = false;
    const racingDb = withQueryHook(db, async ({ kind, table }) => {
      if (kind === "select" && table === fileTable && raced === false) {
        raced = true;
        await seedUploadedFile({ name: "winner.png" });
        await db.insert(assetTable).values({
          id: "winner-asset",
          projectId: "project-1",
          name: "winner.png",
          filename: "photo",
        });
      }
    });

    await expect(
      createUploadTicket(
        {
          projectId: "project-1",
          type: "image/png",
          filename: "photo.png",
          contentHash: "hash-1",
        },
        createContext({ contextDb: racingDb })
      )
    ).resolves.toMatchObject({
      assetId: "winner-asset",
      name: "winner.png",
      deduplicated: true,
      asset: { id: "winner-asset", name: "winner.png" },
    });
    expect(await db.select().from(fileTable)).toHaveLength(1);
  });

  test("counts assets instead of uploaded files for the project limit", async () => {
    await seedProject();
    await seed.assetFolder(db, { id: "campaign", projectId: "project-1" });
    await seedUploadedAssets("project-1", 1);
    // Uploaded files without an asset in this project don't count.
    await seedUploadedFile({ name: "unused-1.png", contentHash: "unused-1" });
    await seedUploadedFile({ name: "unused-2.png", contentHash: "unused-2" });

    const ticket = await createUploadTicket(
      {
        projectId: "project-1",
        type: "image/png",
        filename: "photo.png",
        description: "Campaign photo",
        folderId: "campaign",
      },
      createContext({ maxAssetsPerProject: 2 }),
      () => "asset-1"
    );

    expect(ticket.assetId).toBe("asset-1");
    expect(ticket.name).toMatch(/^photo_.+\.png$/);
    expect(await readFile(ticket.name)).toMatchObject({
      status: "UPLOADING",
      uploaderProjectId: "project-1",
    });
    expect(
      (await projectAssets()).find((asset) => asset.id === "asset-1")
    ).toEqual({
      id: "asset-1",
      projectId: "project-1",
      name: ticket.name,
      filename: "photo",
      description: "Campaign photo",
      folderId: "campaign",
    });
  });

  test("preserves the requested display name while sanitizing storage", async () => {
    await seedProject();

    const ticket = await createUploadTicket(
      {
        projectId: "project-1",
        type: "image/png",
        filename: "Campaign_photo.png",
        displayFilename: "Campaign photo",
      },
      createContext(),
      () => "asset-1"
    );

    expect(ticket.name).toMatch(/^Campaign_photo_.+\.png$/);
    expect(await projectAssets()).toEqual([
      expect.objectContaining({ filename: "Campaign photo" }),
    ]);
  });

  test("throws when uploaded assets and recent uploads reach the limit", async () => {
    await seedProject("project-2");
    await seedUploadedAssets("project-2", 1);
    await seed.file(db, {
      name: "in-progress.png",
      status: "UPLOADING",
      uploaderProjectId: "project-2",
    });

    await expect(
      createUploadTicket(
        {
          projectId: "project-2",
          type: "image/png",
          filename: "photo.png",
        },
        createContext({ maxAssetsPerProject: 2 }),
        () => "asset-2"
      )
    ).rejects.toBeInstanceOf(AssetUploadCountLimitError);
  });

  test("uses project owner's asset limit for shared workspace projects", async () => {
    const ownerPlanCalls: string[] = [];
    const workspaceId = crypto.randomUUID();
    await seed.workspace(db, { id: workspaceId, userId: "team-owner" });
    await seed.project(db, {
      id: "workspace-project",
      userId: "team-owner",
      workspaceId,
    });
    await seed.workspaceMember(db, {
      workspaceId,
      userId: "user-1",
      relation: "editors",
    });
    // At the caller's own limit (100), below the owner's (350).
    await seedUploadedAssets("workspace-project", 100);

    await expect(
      createUploadTicket(
        {
          projectId: "workspace-project",
          type: "image/png",
          filename: "photo.png",
        },
        createContext({ maxAssetsPerProject: 350, ownerPlanCalls }),
        () => "asset-3"
      )
    ).resolves.toMatchObject({
      assetId: "asset-3",
      name: expect.stringMatching(/^photo_.+\.png$/),
    });

    expect(ownerPlanCalls).toEqual(["team-owner"]);
  });

  test("retries when a generated asset id collides", async () => {
    await seedProject("project-4");
    await seed.asset(db, {
      id: "asset-collision",
      projectId: "project-4",
      name: "taken.png",
    });
    const ids = ["asset-collision", "asset-retry"];

    const ticket = await createUploadTicket(
      {
        projectId: "project-4",
        type: "image/png",
        filename: "renamed-photo.png",
      },
      createContext(),
      () => ids.shift() ?? "unexpected"
    );

    expect(ticket.assetId).toBe("asset-retry");
    expect(ticket.name).toMatch(/^renamed-photo_.+\.png$/);
    expect(
      (await projectAssets("project-4")).find(
        (asset) => asset.id === "asset-retry"
      )
    ).toMatchObject({ name: ticket.name, filename: "renamed-photo" });
    // The first reservation's file was removed.
    expect(
      (await db.select().from(fileTable)).map((file) => file.name).sort()
    ).toEqual([ticket.name, "taken.png"].sort());
  });

  test("keeps duplicate asset errors for already uploaded assets", async () => {
    await seedProject("project-5");
    await seed.asset(db, {
      id: "asset-5",
      projectId: "project-5",
      name: "taken.png",
    });

    await expect(
      createUploadTicket(
        {
          projectId: "project-5",
          type: "image/png",
          filename: "photo.png",
        },
        createContext(),
        () => "asset-5"
      )
    ).rejects.toThrow(
      'duplicate key value violates unique constraint "Asset_pkey"'
    );

    // No reservation is left behind and the existing asset is unchanged.
    expect(await db.select().from(fileTable)).toEqual([
      expect.objectContaining({ name: "taken.png" }),
    ]);
  });
});

describe("uploadFile", () => {
  /** An upload reserved by createUploadTicket: an UPLOADING file and its asset. */
  const seedReservation = async ({
    name,
    format = "file",
    contentHash,
    asset = { id: "asset-1" },
    uploaderProjectId = "project-1",
  }: {
    name: string;
    format?: string;
    contentHash?: string;
    asset?: { id: string; filename?: string; description?: string };
    uploaderProjectId?: string | null;
  }) => {
    await seedProject();
    await seed.file(db, {
      name,
      format,
      size: 0,
      status: "UPLOADING",
      uploaderProjectId,
      contentHash,
    });
    await db
      .insert(assetTable)
      .values({ ...asset, projectId: "project-1", name });
  };

  test("does not synchronize canonical metadata while committing an upload", async () => {
    const source = "---\ntitle: New post\n---\nPost body";
    const sourceBytes = new TextEncoder().encode(source);
    await seedReservation({ name: "post.md" });
    const readFile = vi.fn(async () => ({
      data: {
        async *[Symbol.asyncIterator]() {
          yield sourceBytes;
        },
      },
    }));

    const storage = {
      uploadFile: async () => ({
        format: "md",
        size: sourceBytes.byteLength,
        meta: {},
      }),
      readFile,
    };
    await expect(
      new PostgresAssetRepository({
        projectId: "project-1",
        context: createContext(),
        assetStore: storage,
      }).completeUpload({
        name: "post.md",
        data: new Blob([source]).stream(),
        assetInfoFallback: undefined,
      })
    ).resolves.toMatchObject({
      id: "asset-1",
      name: "post.md",
      type: "file",
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(await db.select().from(assetFileMetadata)).toEqual([]);
  });

  test("accepts an upload-only storage client", async () => {
    const source = "Post body";
    await seedReservation({ name: "post.md" });

    await expect(
      uploadFile(
        "post.md",
        new Blob([source]).stream(),
        {
          uploadFile: async () => ({
            format: "md",
            size: source.length,
            meta: {},
          }),
        },
        createContext(),
        undefined
      )
    ).resolves.toMatchObject({ id: "asset-1", name: "post.md" });
    expect(await readFile("post.md")).toMatchObject({
      status: "UPLOADED",
      format: "md",
      size: source.length,
    });
  });

  test("returns uploaded asset with reserved asset row id", async () => {
    await seedReservation({
      name: "existing.png",
      format: "png",
      asset: { id: "asset-1", filename: "photo", description: "Photo" },
    });

    await expect(
      uploadFile(
        "existing.png",
        new Blob(["asset"]).stream(),
        {
          uploadFile: async () => ({
            format: "png",
            size: 5,
            meta: { width: 10, height: 20 },
          }),
        },
        createContext(),
        undefined
      )
    ).resolves.toMatchObject({
      id: "asset-1",
      projectId: "project-1",
      filename: "photo",
      description: "Photo",
      name: "existing.png",
      type: "image",
    });
  });

  test("rejects an upload whose ticket is no longer pending", async () => {
    await seedProject();
    await seedUploadedFile();

    await expect(
      uploadFile(
        "existing.png",
        new Blob(["asset"]).stream(),
        { uploadFile: async () => ({ format: "png", size: 5, meta: {} }) },
        createContext(),
        undefined
      )
    ).rejects.toThrow("File already uploaded or url is expired");
  });

  test("uses custom failed upload cleanup without deleting asset rows", async () => {
    await seedReservation({ name: "existing.png", format: "image" });
    let customCleanupCalled = false;

    await expect(
      uploadFile(
        "existing.png",
        new Blob(["asset"]).stream(),
        {
          uploadFile: async () => {
            throw new Error("Storage upload failed");
          },
        },
        createContext(),
        undefined,
        undefined,
        async () => {
          customCleanupCalled = true;
        }
      )
    ).rejects.toThrow("Storage upload failed");

    expect(customCleanupCalled).toBe(true);
    expect(await projectAssets()).toHaveLength(1);
    expect(await readFile("existing.png")).toBeDefined();
  });

  test("rejects content that does not match the upload ticket hash", async () => {
    await seedReservation({
      name: "existing.png",
      format: "png",
      contentHash: "0".repeat(64),
    });
    let customCleanupCalled = false;
    let storageWriteCompleted = false;

    await expect(
      uploadFile(
        "existing.png",
        new Blob(["asset"]).stream(),
        {
          uploadFile: async (_name, _type, data) => {
            for await (const _chunk of data) {
              // Consume the upload stream as a real storage client would.
            }
            storageWriteCompleted = true;
            return { format: "png", size: 5, meta: {} };
          },
        },
        createContext(),
        undefined,
        undefined,
        async () => {
          customCleanupCalled = true;
        }
      )
    ).rejects.toThrow("does not match its upload ticket");

    expect(customCleanupCalled).toBe(true);
    expect(storageWriteCompleted).toBe(false);
  });

  test("cleans up an uploaded file without an uploader project", async () => {
    await seedReservation({ name: "orphan.txt", uploaderProjectId: null });

    await expect(
      uploadFile(
        "orphan.txt",
        new Blob(["orphan"]).stream(),
        {
          uploadFile: async () => ({ format: "txt", size: 6, meta: {} }),
        },
        createContext(),
        undefined
      )
    ).rejects.toThrow("File uploader project is missing");

    expect(await projectAssets()).toEqual([]);
    expect(await readFile("orphan.txt")).toBeUndefined();
  });
});
