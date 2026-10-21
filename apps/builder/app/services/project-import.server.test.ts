import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createImageAssetFixture,
  createPageFixture,
  createPublishedProjectBundleFixture,
} from "@webstudio-is/protocol/fixtures";
import { type PublishedProjectBundle } from "@webstudio-is/protocol";
import { createAssetRows } from "@webstudio-is/asset-uploader/server";
import {
  ContentCollectionError,
  createDefaultCollectionConfig,
} from "@webstudio-is/content-engine";
import { asset, assetFolder, build, eq, file, project } from "@webstudio-is/db";
import { seed, setupTestDb, withQueryHook } from "@webstudio-is/db/testing";
import {
  __testing__,
  importPublishedProjectBundle,
} from "./project-import.server";

const db = setupTestDb();

const {
  assertBundleVersion,
  normalizeImportedAssetFolderData,
  assertImportedAssetNames,
  assertProjectBuildPermit,
  createBuildImportUpdate,
  getImportedPreviewImageAssetId,
  loadImportedAssetFiles,
} = __testing__;

const createFileRow = ({
  name,
  format,
  size,
  meta = {},
}: {
  name: string;
  format: string;
  size: number;
  meta?: Record<string, unknown>;
}) => ({
  name,
  format,
  description: null,
  size,
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
  meta: JSON.stringify(meta),
});

const createData = (
  overrides: Partial<PublishedProjectBundle> = {}
): PublishedProjectBundle => {
  const page = createPageFixture({ meta: { socialImageAssetId: "asset-1" } });
  return createPublishedProjectBundleFixture({
    assets: [
      createImageAssetFixture({
        id: "asset-1",
        filename: "Image",
        description: "Hero image",
      }),
    ],
    build: {
      version: 3,
      breakpoints: [["base", { id: "base", label: "Base" }]],
      styleSources: [["source-1", { id: "source-1", type: "local" }]],
      styleSourceSelections: [
        ["root", { instanceId: "root", values: ["source-1"] }],
      ],
      props: [
        [
          "prop-1",
          {
            id: "prop-1",
            instanceId: "root",
            name: "id",
            type: "string",
            value: "hero",
          },
        ],
      ],
      instances: [
        [
          "root",
          {
            type: "instance",
            id: "root",
            component: "Body",
            children: [],
          },
        ],
      ],
    },
    buildPages: {
      meta: {},
      pages: [page],
      folders: [
        {
          id: "root-folder",
          name: "Root",
          slug: "",
          children: ["home"],
        },
      ],
    },
    page,
    ...overrides,
  });
};

/**
 * target-project with its development build (version 3) and the given uploaded
 * files, as an upload to it would have left them.
 */
const seedImportTarget = async (
  files: ReturnType<typeof createFileRow>[] = [],
  { buildVersion = 3 }: { buildVersion?: number } = {}
) => {
  await seed.project(db, { id: "target-project", userId: "user-1" });
  await seed.build(db, {
    id: "target-build",
    projectId: "target-project",
    version: buildVersion,
  });
  for (const row of files) {
    await seed.file(db, { ...row, uploaderProjectId: "target-project" });
  }
};

const imageFile = (name = "image.png") =>
  createFileRow({
    name,
    format: "png",
    size: 1,
    meta: { width: 1, height: 1 },
  });

/** An import context whose queries are recorded in `calls`, in order. */
const createImportContext = (calls: string[]) => {
  let projectUpdates = 0;
  return {
    db: withQueryHook(db, ({ kind, table }) => {
      if (kind === "select" && table === file) {
        calls.push("files-select");
      } else if (kind === "update" && table === file) {
        calls.push("files-restore");
      } else if (kind === "update" && table === build) {
        calls.push("build-update");
      } else if (kind === "update" && table === project) {
        projectUpdates += 1;
        calls.push(
          projectUpdates === 1
            ? "project-preview-reset"
            : "project-preview-update"
        );
      } else if (kind === "delete" && table === asset) {
        calls.push("assets-delete");
      } else if (kind === "insert" && table === asset) {
        calls.push("assets-insert");
      } else if (kind === "delete" && table === assetFolder) {
        calls.push("asset-folders-delete");
      } else if (kind === "insert" && table === assetFolder) {
        calls.push("asset-folders-insert");
      }
    }),
  } as never;
};

describe("build import helpers", () => {
  const hasProjectPermit = vi.fn();
  const loadDevBuildByProjectId = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    hasProjectPermit.mockResolvedValue(true);
    loadDevBuildByProjectId.mockResolvedValue({
      id: "target-build",
      projectId: "target-project",
      version: 3,
    });
  });

  test("rejects missing synced data version with compatibility message", () => {
    expect(() =>
      assertBundleVersion({} as Pick<PublishedProjectBundle, "bundleVersion">)
    ).toThrow("Sync with a compatible API/CLI version");
  });

  test("rejects missing build permission", async () => {
    hasProjectPermit.mockResolvedValue(false);

    await expect(
      assertProjectBuildPermit({
        ctx: {} as never,
        hasProjectPermit,
        projectId: "target-project",
      })
    ).rejects.toThrow("You don't have permission to build this project.");
    expect(hasProjectPermit).toHaveBeenCalledWith(
      { projectId: "target-project", permit: "build" },
      {}
    );
  });

  test("serializes imported build data into compact build columns", () => {
    const update = createBuildImportUpdate({
      data: createData(),
      lastTransactionId: "import-tx",
      updatedAt: "2024-02-01T00:00:00.000Z",
      version: 4,
    });

    expect(update).toMatchObject({
      version: 4,
      lastTransactionId: "import-tx",
      updatedAt: "2024-02-01T00:00:00.000Z",
    });
    expect(JSON.parse(update.breakpoints)).toEqual([
      { id: "base", label: "Base" },
    ]);
    expect(JSON.parse(update.styleSources)).toEqual([
      { id: "source-1", type: "local" },
    ]);
    expect(JSON.parse(update.styleSourceSelections)).toEqual([
      { instanceId: "root", values: ["source-1"] },
    ]);
    expect(JSON.parse(update.props)).toEqual([
      {
        id: "prop-1",
        instanceId: "root",
        name: "id",
        type: "string",
        value: "hero",
      },
    ]);
  });

  test("uses imported home social image only when corresponding asset exists", () => {
    expect(getImportedPreviewImageAssetId(createData())).toBe("asset-1");

    expect(
      getImportedPreviewImageAssetId(createData({ assets: [] }))
    ).toBeNull();
  });

  test("remaps imported asset rows to destination project", () => {
    expect(
      createAssetRows(
        [
          createData().assets[0],
          {
            ...createData().assets[0],
            id: "asset-2",
            filename: undefined,
            description: undefined,
          },
        ],
        "destination-project"
      )
    ).toEqual([
      {
        id: "asset-1",
        projectId: "destination-project",
        name: "image.png",
        filename: "Image",
        description: "Hero image",
        folderId: null,
      },
      {
        id: "asset-2",
        projectId: "destination-project",
        name: "image.png",
        filename: null,
        description: null,
        folderId: null,
      },
    ]);
  });

  test("validates folder hierarchy and moves orphaned assets to root", () => {
    const parent = {
      id: "parent",
      projectId: "source-project",
      name: "Parent",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const child = { ...parent, id: "child", name: "Child", parentId: "parent" };

    expect(() =>
      normalizeImportedAssetFolderData(
        [child, parent],
        [{ ...createData().assets[0], folderId: "child" }]
      )
    ).not.toThrow();
    expect(() =>
      normalizeImportedAssetFolderData(
        [parent],
        [{ ...createData().assets[0], folderId: "missing" }]
      )
    ).not.toThrow();
    expect(
      normalizeImportedAssetFolderData(
        [parent],
        [{ ...createData().assets[0], folderId: "missing" }]
      ).assets[0]
    ).not.toHaveProperty("folderId");
  });

  test("normalizes imported asset folder names", () => {
    const normalized = normalizeImportedAssetFolderData(
      [
        {
          id: "folder",
          projectId: "source-project",
          name: "  Media  ",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      []
    );

    expect(normalized.folders[0]?.name).toBe("Media");
  });

  test("updates the build before replacing asset rows", async () => {
    const calls: string[] = [];

    await seedImportTarget([imageFile()]);

    await importPublishedProjectBundle(
      {
        ctx: createImportContext(calls),
        data: createData(),
        projectId: "target-project",
      },
      {
        hasProjectPermit,
        loadDevBuildByProjectId,
      }
    );

    expect(calls).toEqual([
      "files-select",
      "build-update",
      "project-preview-reset",
      "assets-delete",
      "asset-folders-delete",
      "assets-insert",
      "files-restore",
      "project-preview-update",
    ]);
    expect(
      await db.select({ id: asset.id, projectId: asset.projectId }).from(asset)
    ).toEqual([{ id: "asset-1", projectId: "target-project" }]);
    expect(
      (
        await db
          .select({ previewImageAssetId: project.previewImageAssetId })
          .from(project)
          .where(eq(project.id, "target-project"))
      )[0]
    ).toEqual({ previewImageAssetId: "asset-1" });
    expect(
      (await db.select().from(build).where(eq(build.id, "target-build")))[0]
    ).toMatchObject({ version: 4 });
  });

  test("does not restore imported files when the build version changed", async () => {
    const calls: string[] = [];

    // The build was saved again since the import read it.
    await seedImportTarget([imageFile()], { buildVersion: 5 });

    await expect(
      importPublishedProjectBundle(
        {
          ctx: createImportContext(calls),
          data: createData(),
          projectId: "target-project",
        },
        { hasProjectPermit, loadDevBuildByProjectId }
      )
    ).rejects.toThrow("build changed");

    expect(calls).toEqual(["files-select", "build-update"]);
  });

  test("rejects an invalid imported collection before changing the project", async () => {
    const calls: string[] = [];
    const configSource = createDefaultCollectionConfig();
    const configAsset = {
      id: "config",
      projectId: "source-project",
      name: "config-storage.json",
      filename: "collection",
      folderId: "posts",
      type: "file" as const,
      format: "json",
      size: configSource.length,
      description: null,
      createdAt: "2026-09-03T00:00:00.000Z",
      meta: {},
    };

    await seedImportTarget([
      createFileRow({
        name: configAsset.name,
        format: "json",
        size: configSource.length,
      }),
    ]);

    await expect(
      importPublishedProjectBundle(
        {
          ctx: createImportContext(calls),
          data: createData({
            assets: [configAsset],
            assetFolders: [
              {
                id: "posts",
                projectId: "source-project",
                name: "Posts",
                createdAt: "2026-09-03T00:00:00.000Z",
              },
            ],
          }),
          projectId: "target-project",
        },
        {
          hasProjectPermit,
          loadDevBuildByProjectId,
          assetStore: {
            readFile: async () => ({
              data: new Blob([configSource]).stream(),
              contentLength: configSource.length,
            }),
          },
        }
      )
    ).rejects.toThrow('Collection template "template.mdx" not found');

    expect(calls).toEqual(["files-select"]);
  });

  test("validates imported collections against destination file metadata", async () => {
    const calls: string[] = [];
    const configSource = createDefaultCollectionConfig();
    const templateSource = "---\ndraft: true\n---\n\nStart writing.\n";
    const configAsset = {
      id: "config",
      projectId: "source-project",
      name: "config-storage.json",
      filename: "collection",
      folderId: "posts",
      type: "file" as const,
      format: "json",
      size: configSource.length,
      description: null,
      createdAt: "2026-09-03T00:00:00.000Z",
      meta: {},
    };
    const templateAsset = {
      ...configAsset,
      id: "template",
      name: "template-storage.mdx",
      filename: "template",
      format: "mdx",
      size: templateSource.length,
    };

    await seedImportTarget([
      createFileRow({
        name: configAsset.name,
        format: "json",
        size: configSource.length,
      }),
      createFileRow({
        name: templateAsset.name,
        format: "txt",
        size: templateSource.length,
      }),
    ]);

    await expect(
      importPublishedProjectBundle(
        {
          ctx: createImportContext(calls),
          data: createData({
            assets: [configAsset, templateAsset],
            assetFolders: [
              {
                id: "posts",
                projectId: "source-project",
                name: "Posts",
                createdAt: "2026-09-03T00:00:00.000Z",
              },
            ],
          }),
          projectId: "target-project",
        },
        {
          hasProjectPermit,
          loadDevBuildByProjectId,
          assetStore: {
            readFile: async (name) => {
              const source =
                name === configAsset.name ? configSource : templateSource;
              return {
                data: new Blob([source]).stream(),
                contentLength: source.length,
              };
            },
          },
        }
      )
    ).rejects.toBeInstanceOf(ContentCollectionError);

    expect(calls).toEqual(["files-select"]);
  });

  test("inserts the complete folder hierarchy in one request", async () => {
    const calls: string[] = [];
    await seedImportTarget();
    const parent = {
      id: "parent",
      projectId: "source-project",
      name: "Parent",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const child = { ...parent, id: "child", name: "Child", parentId: "parent" };

    await importPublishedProjectBundle(
      {
        ctx: createImportContext(calls),
        data: createData({ assets: [], assetFolders: [child, parent] }),
        projectId: "target-project",
      },
      { hasProjectPermit, loadDevBuildByProjectId }
    );

    expect(calls.filter((call) => call === "asset-folders-insert")).toEqual([
      "asset-folders-insert",
    ]);
    expect(
      await db
        .select()
        .from(assetFolder)
        .where(eq(assetFolder.projectId, "target-project"))
    ).toEqual(
      expect.arrayContaining([
        { ...parent, projectId: "target-project", parentId: null },
        { ...child, projectId: "target-project" },
      ])
    );
  });

  test("allows importing data without version when check is explicitly ignored", async () => {
    const calls: string[] = [];
    await seedImportTarget();

    await importPublishedProjectBundle(
      {
        ctx: createImportContext(calls),
        data: createData({ assets: [], bundleVersion: undefined }),
        ignoreVersionCheck: true,
        projectId: "target-project",
      },
      {
        hasProjectPermit,
        loadDevBuildByProjectId,
      }
    );

    expect(calls).toContain("build-update");
  });

  test("rejects import with assets when uploaded file rows are missing", async () => {
    await seedImportTarget();

    await expect(
      importPublishedProjectBundle(
        {
          ctx: createImportContext([]),
          data: createData(),
          projectId: "target-project",
        },
        {
          hasProjectPermit,
          loadDevBuildByProjectId,
        }
      )
    ).rejects.toThrow('Imported asset files are missing: ["image.png"]');
  });

  test("requires uploaded destination file rows for imported assets", async () => {
    const calls: string[] = [];
    await seedImportTarget([imageFile()]);

    await expect(
      loadImportedAssetFiles({
        assets: createData().assets,
        ctx: createImportContext(calls),
        projectId: "target-project",
      })
    ).resolves.toMatchObject({ fileNames: new Set(["image.png"]) });
    expect(calls).toEqual(["files-select"]);

    // Files still uploading, or uploaded to another project, don't count.
    await db
      .update(file)
      .set({ status: "UPLOADING" })
      .where(eq(file.name, "image.png"));
    await expect(
      loadImportedAssetFiles({
        assets: createData().assets,
        ctx: createImportContext([]),
        projectId: "target-project",
      })
    ).rejects.toThrow("Imported asset files are missing");
    await seed.project(db, { id: "other-project", userId: "user-1" });
    await db
      .update(file)
      .set({ status: "UPLOADED", uploaderProjectId: "other-project" })
      .where(eq(file.name, "image.png"));
    await expect(
      loadImportedAssetFiles({
        assets: createData().assets,
        ctx: createImportContext([]),
        projectId: "target-project",
      })
    ).rejects.toThrow("Imported asset files are missing");
  });

  test("makes imported file rows visible", async () => {
    const calls: string[] = [];
    await seedImportTarget([{ ...imageFile(), isDeleted: true } as never]);

    await importPublishedProjectBundle(
      {
        ctx: createImportContext(calls),
        data: createData(),
        projectId: "target-project",
      },
      {
        hasProjectPermit,
        loadDevBuildByProjectId,
      }
    );

    expect(calls).toContain("files-restore");
    expect(
      (await db.select().from(file).where(eq(file.name, "image.png")))[0]
        .isDeleted
    ).toBe(false);
  });

  test("chunks imported file lookups and restores by bounded filter size", async () => {
    const fileNames = Array.from(
      { length: 12 },
      (_, index) => `${String(index).padStart(2, "0")}-${"a".repeat(490)}.png`
    );
    const assets = fileNames.map((name, index) => ({
      ...createData().assets[0],
      id: `asset-${index}`,
      name,
    }));
    const calls: string[] = [];
    await seedImportTarget(fileNames.map((name) => imageFile(name)));

    await importPublishedProjectBundle(
      {
        ctx: createImportContext(calls),
        data: createData({ assets }),
        projectId: "target-project",
      },
      {
        hasProjectPermit,
        loadDevBuildByProjectId,
      }
    );

    expect(
      calls.filter((call) => call === "files-select").length
    ).toBeGreaterThan(1);
    expect(
      calls.filter((call) => call === "files-restore").length
    ).toBeGreaterThan(1);
    expect(await db.select().from(asset)).toHaveLength(fileNames.length);
  });

  test("rejects imported asset names with path separators", () => {
    expect(() =>
      assertImportedAssetNames([
        { ...createData().assets[0], name: "../image.png" },
      ])
    ).toThrow("Imported asset name is invalid: ../image.png");
  });

  test("allows imported assets to share one storage file", () => {
    expect(() =>
      assertImportedAssetNames([
        createData().assets[0],
        { ...createData().assets[0], id: "asset-2" },
      ])
    ).not.toThrow();
  });

  test("rejects duplicated imported asset ids", () => {
    expect(() =>
      assertImportedAssetNames([
        createData().assets[0],
        { ...createData().assets[0], name: "other.png" },
      ])
    ).toThrow("Imported asset id is duplicated: asset-1");
  });

  test("rejects empty imported asset ids", () => {
    expect(() =>
      assertImportedAssetNames([{ ...createData().assets[0], id: "" }])
    ).toThrow("Imported asset id is invalid.");
  });
});
