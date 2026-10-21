import { describe, expect, test } from "vitest";
import { asset, assetFolder, build, eq, file, type Db } from "@webstudio-is/db";
import { seed, setupTestDb, withQueryHook } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import {
  patchBuild,
  patchLoadedBuild,
  type BuildPatchTransaction,
} from "./build-patch";
import {
  createBuildPatchUpdate,
  singlePlayerVersionMismatchResult,
} from "./build-patch-core";

const db = setupTestDb();

const createContext = (contextDb: Db = db): AppContext =>
  ({
    db: contextDb,
    authorization: { type: "user", userId: "user-1" },
    getOwnerPlanFeatures: async () => ({}),
  }) as unknown as AppContext;

const buildRow = {
  id: "build-1",
  projectId: "project-1",
  version: 3,
  lastTransactionId: "previous-tx",
  isCleaned: null,
  publishStatus: "PUBLISHED" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  pages: JSON.stringify({
    meta: {},
    homePage: {
      id: "page-1",
      name: "Home",
      path: "",
      title: "Home",
      meta: {},
      rootInstanceId: "body-1",
    },
    pages: [],
    folders: [{ id: "root", name: "Root", slug: "", children: [] }],
  }),
  breakpoints: JSON.stringify([]),
  styles: JSON.stringify([]),
  styleSources: JSON.stringify([]),
  styleSourceSelections: JSON.stringify([]),
  props: JSON.stringify([
    {
      id: "prop-1",
      instanceId: "body-1",
      name: "title",
      type: "string",
      value: "Old title",
    },
  ]),
  dataSources: JSON.stringify([]),
  resources: JSON.stringify([]),
  instances: JSON.stringify([
    { id: "body-1", type: "instance", component: "Body", children: [] },
  ]),
  deployment: null,
  marketplaceProduct: JSON.stringify({}),
  projectSettings: JSON.stringify({ meta: {}, compiler: {} }),
};

/** project-1, owned by user-1, with `buildRow` (plus overrides) as its build. */
const seedBuild = async (overrides: Partial<typeof buildRow> = {}) => {
  await seed.project(db, { id: "project-1", userId: "user-1" });
  await seed.build(db, { ...buildRow, ...overrides });
};

const readBuild = async () =>
  (await db.select().from(build).where(eq(build.id, "build-1")))[0];

const transaction = (
  overrides: Partial<BuildPatchTransaction> = {}
): BuildPatchTransaction => ({
  id: "tx-1",
  payload: [
    {
      namespace: "props",
      patches: [
        { op: "replace", path: ["prop-1", "value"], value: "New title" },
      ],
    },
  ],
  ...overrides,
});

describe("patchBuild", () => {
  test("patches an already loaded build and returns the updated build row", async () => {
    await seedBuild();
    let didLoadBuild = false;
    const watchedDb = withQueryHook(db, ({ kind, table }) => {
      if (kind === "select" && table === build) {
        didLoadBuild = true;
      }
    });

    const result = await patchLoadedBuild(
      {
        build: buildRow,
        buildId: "build-1",
        projectId: "project-1",
        clientVersion: 3,
        transactions: [transaction()],
      },
      createContext(watchedDb)
    );

    expect(result.status).toBe("ok");
    expect((await readBuild()).version).toBe(4);
    if (result.status === "ok") {
      expect(result.version).toBe(4);
      expect(result.build.version).toBe(4);
      expect(JSON.parse(result.build.props)).toEqual([
        {
          id: "prop-1",
          instanceId: "body-1",
          name: "title",
          type: "string",
          value: "New title",
        },
      ]);
    }
    expect(didLoadBuild).toBe(false);
  });

  test("persists asset-folder namespace changes before accepting the build transaction", async () => {
    await seedBuild();

    const result = await patchLoadedBuild(
      {
        build: buildRow,
        buildId: "build-1",
        projectId: "project-1",
        clientVersion: 3,
        transactions: [
          transaction({
            payload: [
              {
                namespace: "assetFolders",
                patches: [
                  {
                    op: "add",
                    path: ["folder-1"],
                    value: {
                      id: "folder-1",
                      projectId: "project-1",
                      name: "Images",
                      createdAt: "2026-01-01T00:00:00.000Z",
                    },
                  },
                ],
              },
            ],
          }),
        ],
      },
      createContext()
    );

    expect(result.status).toBe("ok");
    expect(await db.select().from(assetFolder)).toEqual([
      {
        id: "folder-1",
        projectId: "project-1",
        name: "Images",
        parentId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  test("deletes folder assets before deleting the folder", async () => {
    await seedBuild();
    await db.insert(assetFolder).values({
      id: "folder-1",
      projectId: "project-1",
      name: "Folder",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await db.insert(file).values({
      name: "asset.pdf",
      format: "pdf",
      size: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      meta: "{}",
      status: "UPLOADED",
      uploaderProjectId: "project-1",
    });
    await db.insert(asset).values({
      id: "asset-1",
      projectId: "project-1",
      name: "asset.pdf",
      folderId: "folder-1",
    });
    const calls: string[] = [];
    const watchedDb = withQueryHook(db, ({ kind, table }) => {
      if (kind === "delete" && table === asset) {
        calls.push("asset-delete");
      }
      if (kind === "delete" && table === assetFolder) {
        calls.push("folder-delete");
      }
      if (kind === "update" && table === build) {
        calls.push("build-update");
      }
    });

    const result = await patchLoadedBuild(
      {
        build: buildRow,
        buildId: "build-1",
        projectId: "project-1",
        clientVersion: 3,
        assetStore: {
          readFile: async () => {
            throw new Error("Unexpected asset content read");
          },
        },
        transactions: [
          transaction({
            payload: [
              {
                namespace: "assetFolders",
                patches: [{ op: "remove", path: ["folder-1"] }],
              },
              {
                namespace: "assets",
                patches: [{ op: "remove", path: ["asset-1"] }],
              },
            ],
          }),
        ],
      },
      createContext(watchedDb)
    );

    expect(result.status).toBe("ok");
    expect(calls).toEqual(["asset-delete", "folder-delete", "build-update"]);
    expect(await db.select().from(assetFolder)).toEqual([]);
  });

  test("applies transactions, validates data, and updates build with optimistic version guard", async () => {
    await seedBuild();

    const result = await patchBuild(
      {
        buildId: "build-1",
        projectId: "project-1",
        clientVersion: 3,
        transactions: [transaction()],
      },
      createContext()
    );

    expect(result).toEqual({ status: "ok", version: 4 });
    const updatedBuild = await readBuild();
    expect(updatedBuild).toMatchObject({
      version: 4,
      lastTransactionId: "tx-1",
    });
    expect(JSON.parse(updatedBuild.props)).toEqual([
      {
        id: "prop-1",
        instanceId: "body-1",
        name: "title",
        type: "string",
        value: "New title",
      },
    ]);
  });

  test("applies page path changes from normalized page id patches", async () => {
    await seedBuild({
      pages: JSON.stringify({
        meta: {},
        homePageId: "page-1",
        rootFolderId: "root",
        pages: [
          {
            id: "page-1",
            name: "Home",
            path: "",
            title: "Home",
            meta: {},
            rootInstanceId: "body-1",
          },
          {
            id: "page-2",
            name: "About",
            path: "/about",
            title: "About",
            meta: {},
            rootInstanceId: "body-1",
          },
        ],
        folders: [
          {
            id: "root",
            name: "Root",
            slug: "",
            children: ["page-1", "page-2"],
          },
        ],
      }),
    });

    const result = await patchBuild(
      {
        buildId: "build-1",
        projectId: "project-1",
        clientVersion: 3,
        transactions: [
          transaction({
            payload: [
              {
                namespace: "pages",
                patches: [
                  {
                    op: "replace",
                    path: ["pages", "page-2", "path"],
                    value: "/company",
                  },
                ],
              },
            ],
          }),
        ],
      },
      createContext()
    );

    expect(result).toEqual({ status: "ok", version: 4 });
    expect(
      JSON.parse((await readBuild()).pages).pages.find(
        (page: { id: string }) => page.id === "page-2"
      )?.path
    ).toBe("/company");
  });

  test("persists folder index paths for page updates and duplicates", async () => {
    const buildWithFolder = {
      ...buildRow,
      pages: JSON.stringify({
        meta: {},
        homePage: {
          id: "page-1",
          name: "Home",
          path: "",
          title: "Home",
          meta: {},
          rootInstanceId: "body-1",
        },
        pages: [
          {
            id: "page-2",
            name: "Landing",
            path: "/landing",
            title: "Landing",
            meta: {},
            rootInstanceId: "body-2",
          },
        ],
        folders: [
          {
            id: "root",
            name: "Root",
            slug: "",
            children: ["page-1", "folder-1"],
          },
          {
            id: "folder-1",
            name: "Folder",
            slug: "folder",
            children: ["page-2"],
          },
        ],
      }),
    };

    const updated = await createBuildPatchUpdate({
      build: buildWithFolder,
      clientVersion: 3,
      transactions: [
        transaction({
          payload: [
            {
              namespace: "pages",
              patches: [
                {
                  op: "replace",
                  path: ["pages", "page-2", "path"],
                  value: "",
                },
              ],
            },
          ],
        }),
      ],
    });
    expect(updated.status).toBe("ok");

    const duplicated = await createBuildPatchUpdate({
      build: buildWithFolder,
      clientVersion: 3,
      transactions: [
        transaction({
          payload: [
            {
              namespace: "pages",
              patches: [
                {
                  op: "add",
                  path: ["pages", "page-copy"],
                  value: {
                    id: "page-copy",
                    name: "Copy",
                    path: "",
                    title: "Copy",
                    meta: {},
                    rootInstanceId: "body-copy",
                  },
                },
                {
                  op: "add",
                  path: ["folders", "folder-1", "children", 1],
                  value: "page-copy",
                },
              ],
            },
          ],
        }),
      ],
    });
    expect(duplicated.status).toBe("ok");
  });

  test("applies data source variable additions", async () => {
    const result = await createBuildPatchUpdate({
      build: buildRow,
      clientVersion: 3,
      transactions: [
        transaction({
          payload: [
            {
              namespace: "dataSources",
              patches: [
                {
                  op: "add",
                  path: ["variable-1"],
                  value: {
                    id: "variable-1",
                    scopeInstanceId: "body-1",
                    name: "title",
                    type: "variable",
                    value: { type: "string", value: "" },
                  },
                },
              ],
            },
          ],
        }),
      ],
    });

    expect(result).toMatchObject({
      status: "ok",
      nextVersion: 4,
      update: {
        lastTransactionId: "tx-1",
        version: 4,
      },
    });
    if (result.status === "ok") {
      expect(JSON.parse(result.update?.dataSources ?? "")).toEqual([
        {
          id: "variable-1",
          scopeInstanceId: "body-1",
          name: "title",
          type: "variable",
          value: { type: "string", value: "" },
        },
      ]);
    }
  });

  test("persists project settings without modifying pages storage", async () => {
    const result = await createBuildPatchUpdate({
      build: buildRow,
      clientVersion: 3,
      transactions: [
        transaction({
          payload: [
            {
              namespace: "projectSettings",
              patches: [
                {
                  op: "add",
                  path: ["meta", "agentInstructions"],
                  value: "Use existing components.",
                },
              ],
            },
          ],
        }),
      ],
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.update).toBeDefined();
      if (result.update === undefined) {
        throw new Error("Expected project settings update");
      }
      expect(result.update.pages).toBeUndefined();
      expect(
        JSON.parse(result.update.projectSettings as string).meta
      ).toMatchObject({
        agentInstructions: "Use existing components.",
      });
    }
  });

  test("persists an explicitly cleared marketplace product", async () => {
    const result = await createBuildPatchUpdate({
      build: {
        ...buildRow,
        marketplaceProduct: JSON.stringify({
          category: "sectionTemplates",
          name: "Example section",
          thumbnailAssetId: "thumbnail",
          author: "Webstudio",
          email: "hello@example.com",
          website: "",
          issues: "",
          description: "Example marketplace product",
        }),
      },
      clientVersion: 3,
      transactions: [
        transaction({
          payload: [
            {
              namespace: "marketplaceProduct",
              patches: [{ op: "replace", path: [], value: undefined }],
            },
          ],
        }),
      ],
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(JSON.parse(result.update?.marketplaceProduct ?? "null")).toEqual(
        {}
      );
    }
  });

  test("validates only touched props while preserving untouched props", async () => {
    const buildWithInvalidUntouchedProp = {
      ...buildRow,
      props: JSON.stringify([
        {
          id: "prop-1",
          instanceId: "body-1",
          name: "title",
          type: "string",
          value: "Old title",
        },
        {
          id: "prop-invalid",
          instanceId: "body-1",
          name: "count",
          type: "number",
          value: "invalid number",
        },
      ]),
    };

    const result = await createBuildPatchUpdate({
      build: buildWithInvalidUntouchedProp,
      clientVersion: 3,
      transactions: [transaction()],
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(JSON.parse(result.update?.props ?? "")).toEqual([
        {
          id: "prop-1",
          instanceId: "body-1",
          name: "title",
          type: "string",
          value: "New title",
        },
        {
          id: "prop-invalid",
          instanceId: "body-1",
          name: "count",
          type: "number",
          value: "invalid number",
        },
      ]);
    }
  });

  test("rejects invalid touched props", async () => {
    await expect(
      createBuildPatchUpdate({
        build: buildRow,
        clientVersion: 3,
        transactions: [
          transaction({
            payload: [
              {
                namespace: "props",
                patches: [
                  {
                    op: "replace",
                    path: ["prop-1", "value"],
                    value: 123,
                  },
                ],
              },
            ],
          }),
        ],
      })
    ).rejects.toThrow();
  });

  test("rejects touched props set to undefined", async () => {
    await expect(
      createBuildPatchUpdate({
        build: buildRow,
        clientVersion: 3,
        transactions: [
          transaction({
            payload: [
              {
                namespace: "props",
                patches: [
                  {
                    op: "replace",
                    path: ["prop-1"],
                    value: undefined,
                  },
                ],
              },
            ],
          }),
        ],
      })
    ).rejects.toThrow();
  });

  test("validates all props when patch replaces the props map", async () => {
    await expect(
      createBuildPatchUpdate({
        build: buildRow,
        clientVersion: 3,
        transactions: [
          transaction({
            payload: [
              {
                namespace: "props",
                patches: [
                  {
                    op: "replace",
                    path: [],
                    value: new Map([
                      [
                        "prop-invalid",
                        {
                          id: "prop-invalid",
                          instanceId: "body-1",
                          name: "count",
                          type: "number",
                          value: "invalid number",
                        },
                      ],
                    ]),
                  },
                ],
              },
            ],
          }),
        ],
      })
    ).rejects.toThrow();
  });

  test("rejects touched styles set to undefined", async () => {
    const style = {
      styleSourceId: "style-source-1",
      breakpointId: "breakpoint-1",
      property: "width",
      value: { type: "unit", value: 10, unit: "px" },
    };
    const buildWithStyle = {
      ...buildRow,
      styles: JSON.stringify([style]),
    };
    const styleKey = "style-source-1:breakpoint-1:width:";

    await expect(
      createBuildPatchUpdate({
        build: buildWithStyle,
        clientVersion: 3,
        transactions: [
          transaction({
            payload: [
              {
                namespace: "styles",
                patches: [
                  {
                    op: "replace",
                    path: [styleKey],
                    value: undefined,
                  },
                ],
              },
            ],
          }),
        ],
      })
    ).rejects.toThrow();
  });

  test("validates only touched instances while preserving untouched instances", async () => {
    const buildWithInvalidUntouchedInstance = {
      ...buildRow,
      instances: JSON.stringify([
        {
          id: "body-1",
          type: "instance",
          component: "Body",
          children: [],
        },
        {
          id: "instance-invalid",
          type: "instance",
          children: [],
        },
      ]),
    };

    const result = await createBuildPatchUpdate({
      build: buildWithInvalidUntouchedInstance,
      clientVersion: 3,
      transactions: [
        transaction({
          payload: [
            {
              namespace: "instances",
              patches: [
                {
                  op: "add",
                  path: ["body-1", "label"],
                  value: "Body label",
                },
              ],
            },
          ],
        }),
      ],
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(JSON.parse(result.update?.instances ?? "")).toEqual([
        {
          id: "body-1",
          type: "instance",
          component: "Body",
          label: "Body label",
          children: [],
        },
        {
          id: "instance-invalid",
          type: "instance",
          children: [],
        },
      ]);
    }
  });

  test("rejects invalid touched instances", async () => {
    await expect(
      createBuildPatchUpdate({
        build: buildRow,
        clientVersion: 3,
        transactions: [
          transaction({
            payload: [
              {
                namespace: "instances",
                patches: [
                  {
                    op: "remove",
                    path: ["body-1", "component"],
                  },
                ],
              },
            ],
          }),
        ],
      })
    ).rejects.toThrow();
  });

  test("returns ok when retrying a transaction already saved by the server", async () => {
    await seedBuild({ version: 4, lastTransactionId: "tx-1" });

    const result = await patchBuild(
      {
        buildId: "build-1",
        projectId: "project-1",
        clientVersion: 3,
        transactions: [transaction()],
      },
      createContext()
    );

    expect(result).toEqual({ status: "ok", version: 4 });
    // Nothing is applied twice.
    expect((await readBuild()).props).toBe(buildRow.props);
  });

  test("returns version_mismatched when loaded build version differs", async () => {
    await seedBuild({ version: 4 });

    const result = await patchBuild(
      {
        buildId: "build-1",
        projectId: "project-1",
        clientVersion: 3,
        transactions: [transaction()],
      },
      createContext()
    );

    expect(result).toEqual(singlePlayerVersionMismatchResult);
  });

  test("returns version_mismatched when optimistic update affects no rows", async () => {
    await seedBuild();
    // Another save lands between loading the build and updating it.
    let bumped = false;
    const racingDb = withQueryHook(db, async ({ kind, table }) => {
      if (kind === "select" && table === build && bumped === false) {
        bumped = true;
        await db
          .update(build)
          .set({ version: 4 })
          .where(eq(build.id, "build-1"));
      }
    });

    const result = await patchBuild(
      {
        buildId: "build-1",
        projectId: "project-1",
        clientVersion: 3,
        transactions: [transaction()],
      },
      createContext(racingDb)
    );

    expect(result).toEqual(singlePlayerVersionMismatchResult);
    expect((await readBuild()).props).toBe(buildRow.props);
  });

  test("rejects unknown namespaces", async () => {
    await seedBuild();

    const result = await patchBuild(
      {
        buildId: "build-1",
        projectId: "project-1",
        clientVersion: 3,
        transactions: [
          transaction({
            payload: [
              {
                namespace: "unknown",
                patches: [{ op: "add", path: [], value: null }],
              },
            ],
          }),
        ],
      },
      createContext()
    );

    expect(result).toEqual({
      status: "error",
      errors: 'Unknown namespace "unknown"',
    });
    expect((await readBuild()).version).toBe(3);
  });

  test("core patch helper is decoupled from asset app logic", async () => {
    const assetPatch = { op: "add" as const, path: ["asset-1"], value: {} };
    const result = await createBuildPatchUpdate({
      build: buildRow,
      clientVersion: 3,
      transactions: [
        transaction({
          payload: [
            {
              namespace: "assets",
              patches: [assetPatch],
            },
          ],
        }),
      ],
    });

    expect(result).toMatchObject({
      status: "ok",
      assetPatches: [[assetPatch]],
      nextVersion: 4,
      update: {
        lastTransactionId: "tx-1",
        version: 4,
      },
    });
  });

  test("does not mark build as saved when asset patching fails", async () => {
    await seedBuild();

    await expect(
      patchBuild(
        {
          buildId: "build-1",
          projectId: "project-1",
          clientVersion: 3,
          transactions: [
            transaction({
              payload: [
                {
                  namespace: "assets",
                  patches: [
                    {
                      op: "add",
                      path: ["asset-invalid"],
                      value: {
                        id: "asset-invalid",
                        name: "invalid.jpg",
                      },
                    },
                  ],
                },
              ],
            }),
          ],
        },
        createContext()
      )
    ).rejects.toThrow();

    expect(await readBuild()).toMatchObject({
      version: 3,
      lastTransactionId: "previous-tx",
    });
  });
});
