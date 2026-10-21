import { describe, test, expect, vi } from "vitest";
import { and, build, eq, isNotNull, isNull, type Db } from "@webstudio-is/db";
import { seed, setupTestDb, withQueryHook } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { AuthorizationError } from "@webstudio-is/trpc-interface/index.server";
import {
  loadRawBuildById,
  loadBuildById,
  loadDevBuildContentEngineDataByProjectId,
  loadDevBuildByProjectId,
  createBuild,
  createProductionBuild,
  unpublishBuild,
  __testing__,
} from "./build";

const db = setupTestDb();
const { canTokenPublishDeployment } = __testing__;

const uid = () => `proj-${Math.random().toString(36).slice(2)}`;

const createContext = (userId = "user-1", contextDb: Db = db): AppContext =>
  ({
    db: contextDb,
    authorization: { type: "user", userId },
    getOwnerPlanFeatures: async () => ({}),
  }) as unknown as AppContext;

/** Minimal Build row that satisfies parseCompactBuild */
const buildRow = {
  id: "build-1",
  projectId: "proj-1",
  version: 0,
  pages: JSON.stringify({
    meta: {},
    homePage: {
      id: "page-1",
      name: "Home",
      path: "/",
      title: '"Home"',
      meta: {},
      rootInstanceId: "body-1",
      systemDataSourceId: undefined,
    },
    pages: [],
  }),
  breakpoints: JSON.stringify([]),
  styles: JSON.stringify([]),
  styleSources: JSON.stringify([]),
  styleSourceSelections: JSON.stringify([]),
  props: JSON.stringify([]),
  dataSources: JSON.stringify([]),
  resources: JSON.stringify([]),
  instances: JSON.stringify([
    { id: "body-1", type: "instance", component: "Body", children: [] },
  ]),
  deployment: null,
  marketplaceProduct: JSON.stringify({}),
  projectSettings: JSON.stringify({ meta: {}, compiler: {} }),
};

/** A project owned by `userId` with a development build. */
const seedProjectWithBuild = async ({
  projectId = "proj-1",
  userId = "user-1",
  domain = "project-domain",
  build: overrides = {},
}: {
  projectId?: string;
  userId?: string;
  domain?: string;
  build?: Partial<typeof buildRow>;
} = {}) => {
  await seed.project(db, { id: projectId, userId, domain });
  await seed.build(db, { ...buildRow, projectId, ...overrides });
};

const productionBuilds = async (projectId = "proj-1") =>
  await db
    .select()
    .from(build)
    .where(and(eq(build.projectId, projectId), isNotNull(build.deployment)));

// ---------------------------------------------------------------------------
// loadRawBuildById
// ---------------------------------------------------------------------------

describe("loadRawBuildById", () => {
  test("returns raw build row", async () => {
    await seedProjectWithBuild();
    const result = await loadRawBuildById(createContext(), "build-1");
    expect(result.id).toBe("build-1");
  });

  test("throws when build not found", async () => {
    await expect(loadRawBuildById(createContext(), "missing")).rejects.toThrow(
      "0 row(s)"
    );
  });
});

// ---------------------------------------------------------------------------
// loadBuildById (delegates to loadRawBuildById + parseCompactBuild)
// ---------------------------------------------------------------------------

describe("loadBuildById", () => {
  test("returns parsed build with id and projectId", async () => {
    await seedProjectWithBuild();
    const result = await loadBuildById(createContext(), "build-1");
    expect(result.id).toBe("build-1");
    expect(result.projectId).toBe("proj-1");
    expect(result.marketplaceProduct).toBeUndefined();
  });

  test("drops persisted response-header rules with a null value", async () => {
    await seedProjectWithBuild({
      build: {
        projectSettings: JSON.stringify({
          meta: {
            customHeaders: [
              { name: "X-Frame-Options", value: null },
              { name: "Referrer-Policy", value: "no-referrer" },
            ],
          },
          compiler: {},
        }),
      },
    });

    const result = await loadBuildById(createContext(), "build-1");
    expect(result.projectSettings.meta.customHeaders).toEqual([
      { name: "Referrer-Policy", value: "no-referrer" },
    ]);
  });

  test("rejects invalid persisted data sources", async () => {
    await seedProjectWithBuild({
      build: {
        dataSources: JSON.stringify([
          {
            id: "tags-variable",
            type: "variable",
            name: "tags",
            value: { type: "string[]", value: ["news"] },
          },
        ]),
      },
    });

    await expect(loadBuildById(createContext(), "build-1")).rejects.toThrow();
  });

  test("normalizes persisted Assets resources before publishing or syncing", async () => {
    await seedProjectWithBuild({
      build: {
        resources: JSON.stringify([
          {
            id: "assets",
            name: "Assets",
            control: "system",
            method: "get",
            url: '"/$resources/assets"',
            searchParams: [],
            headers: [],
          },
        ]),
      },
    });

    const result = await loadBuildById(createContext(), "build-1");

    expect(result.resources).toMatchObject([
      {
        id: "assets",
        method: "post",
        headers: [
          {
            name: "Content-Type",
            value: '"application/json"',
          },
        ],
      },
    ]);
    expect(result.resources[0].body).toContain("limit: 1000");
  });
});

// ---------------------------------------------------------------------------
// loadDevBuildByProjectId
// ---------------------------------------------------------------------------

describe("loadDevBuildByProjectId", () => {
  test("returns the dev build (no deployment)", async () => {
    await seedProjectWithBuild();
    await seed.build(db, {
      ...buildRow,
      id: "build-prod",
      deployment: JSON.stringify({ destination: "saas", domains: ["x"] }),
    });
    const result = await loadDevBuildByProjectId(createContext(), "proj-1");
    expect(result.id).toBe("build-1");
  });

  test("throws when no dev build found", async () => {
    await expect(
      loadDevBuildByProjectId(createContext(), "proj-1")
    ).rejects.toThrow("No dev build found");
  });

  test("stops with the caller signal", async () => {
    await seedProjectWithBuild();
    const controller = new AbortController();
    controller.abort();

    await expect(
      loadDevBuildByProjectId(createContext(), "proj-1", controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("loadDevBuildContentEngineDataByProjectId", () => {
  test("returns the content engine fields of the dev build", async () => {
    await seedProjectWithBuild();

    const result = await loadDevBuildContentEngineDataByProjectId(
      createContext(),
      "proj-1"
    );

    expect(result).toEqual({ props: [], dataSources: [], resources: [] });
  });

  test("parses the selected fields identically to the full dev Build loader", async () => {
    await seedProjectWithBuild({
      build: {
        props: JSON.stringify([
          {
            id: "title-prop",
            instanceId: "body-1",
            name: "title",
            type: "string",
            value: "Blog",
          },
        ]),
        dataSources: JSON.stringify([
          {
            type: "resource",
            id: "posts-data-source",
            name: "posts",
            resourceId: "assets",
          },
        ]),
        resources: JSON.stringify([
          {
            id: "assets",
            name: "Assets",
            control: "system",
            method: "get",
            url: '"/$resources/assets"',
            searchParams: [],
            headers: [],
          },
        ]),
      },
    });

    const contentEngineData = await loadDevBuildContentEngineDataByProjectId(
      createContext(),
      "proj-1"
    );
    const fullBuild = await loadDevBuildByProjectId(createContext(), "proj-1");

    expect(contentEngineData).toEqual({
      props: fullBuild.props,
      dataSources: fullBuild.dataSources,
      resources: fullBuild.resources,
    });
  });

  test("stops with the caller signal", async () => {
    await seedProjectWithBuild();
    const controller = new AbortController();
    controller.abort();

    await expect(
      loadDevBuildContentEngineDataByProjectId(
        createContext(),
        "proj-1",
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ---------------------------------------------------------------------------
// createBuild
// ---------------------------------------------------------------------------

describe("createBuild", () => {
  test("inserts a new build row", async () => {
    await seed.project(db, { id: "proj-1", userId: "user-1" });

    await createBuild({ projectId: "proj-1" }, createContext());
    expect(
      await db
        .select({ projectId: build.projectId, deployment: build.deployment })
        .from(build)
    ).toEqual([{ projectId: "proj-1", deployment: null }]);
  });

  test("throws when insert fails", async () => {
    // No such project.
    await expect(
      createBuild({ projectId: "proj-1" }, createContext())
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createProductionBuild
// ---------------------------------------------------------------------------

const headerSettings = (headers: unknown[]) =>
  JSON.stringify({ meta: { customHeaders: headers }, compiler: {} });

describe("createProductionBuild", () => {
  test("copies the development build into a production build", async () => {
    await seedProjectWithBuild({
      build: { props: JSON.stringify([]), version: 7 },
    });
    const deployment = {
      destination: "saas" as const,
      domains: ["project-domain"],
    };

    const { id } = await createProductionBuild(
      { projectId: "proj-1", deployment },
      createContext()
    );

    const [production] = await productionBuilds();
    expect(production).toMatchObject({
      id,
      projectId: "proj-1",
      version: 7,
      pages: buildRow.pages,
      deployment: JSON.stringify(deployment),
    });
    // The development build stays.
    expect(
      await db
        .select({ id: build.id })
        .from(build)
        .where(isNull(build.deployment))
    ).toEqual([{ id: "build-1" }]);
  });

  test.each([
    {
      label: "Free owner, custom domain",
      allowed: false,
      domains: ["example.com"],
      headers: [{ name: "X-Frame-Options", value: "DENY" }],
      denied: true,
      checkPlan: true,
    },
    {
      label: "Free owner, route rule",
      allowed: false,
      domains: ["example.com"],
      headers: [
        {
          route: "/private/*",
          name: "Referrer-Policy",
          value: "no-referrer",
        },
      ],
      denied: true,
      checkPlan: true,
    },
    {
      label: "Free owner, mixed domains",
      allowed: false,
      domains: ["project-domain", "example.com"],
      headers: [{ name: "X-Frame-Options", value: "DENY" }],
      denied: true,
      checkPlan: true,
    },
    {
      label: "Free owner, staging",
      allowed: false,
      domains: ["project-domain"],
      headers: [{ name: "X-Frame-Options", value: "DENY" }],
      denied: false,
      checkPlan: false,
    },
    {
      label: "Pro owner, custom domain",
      allowed: true,
      domains: ["example.com"],
      headers: [{ name: "X-Frame-Options", value: "DENY" }],
      denied: false,
      checkPlan: true,
    },
    {
      label: "Free owner, deleted headers",
      allowed: false,
      domains: ["example.com"],
      headers: [],
      denied: false,
      checkPlan: false,
    },
    {
      label: "Free owner, legacy null header value",
      allowed: false,
      domains: ["example.com"],
      headers: [{ name: "X-Frame-Options", value: null }],
      denied: false,
      checkPlan: false,
    },
    {
      label: "Free owner, explicit defaults",
      allowed: false,
      domains: ["example.com"],
      headers: [
        { name: "content-security-policy", value: "frame-ancestors 'self'" },
        { name: "X-Frame-Options", value: "SAMEORIGIN" },
      ],
      denied: false,
      checkPlan: false,
    },
  ])(
    "enforces custom header publishing for $label",
    async ({ allowed, domains, headers, denied, checkPlan }) => {
      await seedProjectWithBuild({
        userId: "project-owner",
        build: { projectSettings: headerSettings(headers) },
      });
      const context = createContext("project-owner");
      // The caller's own plan must not determine the project's entitlement.
      context.planFeatures = {
        ...context.planFeatures,
        allowDynamicData: !allowed,
      };
      const getOwnerPlanFeatures = vi.fn(async () => ({
        ...context.planFeatures,
        allowDynamicData: allowed,
      }));
      context.getOwnerPlanFeatures = getOwnerPlanFeatures;
      const result = createProductionBuild(
        {
          projectId: "proj-1",
          deployment: {
            destination: "saas",
            domains,
            // Deliberately misleading caller-supplied metadata must not bypass the gate.
            target: "staging",
            assetsDomain: domains[0],
          },
        },
        context
      );
      if (denied) {
        await expect(result).rejects.toThrow(
          "Custom headers are a Pro feature"
        );
        expect(await productionBuilds()).toEqual([]);
      } else {
        await expect(result).resolves.toEqual({ id: expect.any(String) });
        expect(await productionBuilds()).toHaveLength(1);
      }
      if (checkPlan) {
        expect(getOwnerPlanFeatures).toHaveBeenCalledExactlyOnceWith(
          "project-owner"
        );
      } else {
        expect(getOwnerPlanFeatures).not.toHaveBeenCalled();
      }
    }
  );

  test.each([
    { label: "custom value", value: "DENY", allowed: false, staging: false },
    { label: "Pro owner", value: "DENY", allowed: true, staging: false },
    { label: "staging", value: "DENY", allowed: false, staging: true },
    {
      label: "default value",
      value: "SAMEORIGIN",
      allowed: false,
      staging: false,
    },
  ])(
    "checks the published snapshot after a concurrent edit: $label",
    async ({ value, allowed, staging }) => {
      await seedProjectWithBuild({ userId: "project-owner" });
      // The development build changes right after the publish read it, before
      // the production snapshot is taken.
      let edited = false;
      const editingDb = withQueryHook(db, async ({ kind, table }) => {
        if (kind === "select" && table === build && edited === false) {
          edited = true;
          await db
            .update(build)
            .set({
              projectSettings: headerSettings([
                { name: "X-Frame-Options", value },
              ]),
            })
            .where(eq(build.id, "build-1"));
        }
      });
      const context = createContext("project-owner", editingDb);
      context.getOwnerPlanFeatures = vi.fn(async () => ({
        ...context.planFeatures,
        allowDynamicData: allowed,
      }));
      const result = createProductionBuild(
        {
          projectId: "proj-1",
          deployment: {
            destination: "saas",
            domains: [staging ? "project-domain" : "example.com"],
          },
        },
        context
      );
      if (!allowed && !staging && value !== "SAMEORIGIN") {
        await expect(result).rejects.toThrow(
          "Custom headers are a Pro feature"
        );
        expect(await productionBuilds()).toEqual([]);
      } else {
        await expect(result).resolves.toEqual({ id: expect.any(String) });
        expect(await productionBuilds()).toHaveLength(1);
      }
      expect(edited).toBe(true);
    }
  );

  test("fails closed and removes the unpublished build when its settings cannot be verified", async () => {
    await seedProjectWithBuild();
    // The new build disappears before its settings are read back.
    const losingDb = withQueryHook(db, async ({ kind, table, rows }) => {
      if (kind === "insert" && table === build) {
        const [created] = rows as Array<{ id: string }>;
        await db.delete(build).where(eq(build.id, created.id));
      }
    });
    await expect(
      createProductionBuild(
        {
          projectId: "proj-1",
          deployment: { destination: "saas", domains: ["example.com"] },
        },
        createContext("user-1", losingDb)
      )
    ).rejects.toThrow("Cannot verify published response headers");
    expect(await productionBuilds()).toEqual([]);
  });

  test("throws when the project has no development build", async () => {
    await seed.project(db, { id: "proj-1", userId: "user-1" });
    await expect(
      createProductionBuild(
        {
          projectId: "proj-1",
          deployment: { destination: "saas", domains: ["project-domain"] },
        },
        createContext()
      )
    ).rejects.toThrow("No dev build found");
  });

  test("throws when dev build has orphan resource references", async () => {
    await seedProjectWithBuild({
      build: {
        dataSources: JSON.stringify([
          {
            type: "resource",
            id: "dataSourceId",
            name: "pinnedAnnouncementData_1",
            resourceId: "missingResourceId",
          },
        ]),
      },
    });

    await expect(
      createProductionBuild(
        {
          projectId: "proj-1",
          deployment: {
            destination: "saas",
            domains: ["project-domain"],
            assetsDomain: "project-domain",
            excludeWstdDomainFromSearch: false,
          },
        },
        createContext()
      )
    ).rejects.toThrow(
      `Cannot publish: resource variable "pinnedAnnouncementData_1" (dataSourceId) references missing resource "missingResourceId".`
    );
    expect(await productionBuilds()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// canTokenPublishDeployment
// ---------------------------------------------------------------------------

describe("canTokenPublishDeployment", () => {
  const token = {
    token: "token-1",
    projectId: "proj-1",
    name: "Share link",
    createdAt: new Date().toISOString(),
    canClone: true,
    canCopy: true,
    canPublish: false,
    canUseApi: false,
  };

  test("allows builder tokens to publish to the staging domain", () => {
    expect(
      canTokenPublishDeployment(
        { ...token, relation: "builders" },
        {
          destination: "saas",
          domains: ["project-domain"],
          assetsDomain: "project-domain",
          excludeWstdDomainFromSearch: false,
        }
      )
    ).toBe(true);
  });

  test("rejects builder tokens publishing to custom domains", () => {
    expect(
      canTokenPublishDeployment(
        { ...token, relation: "builders" },
        {
          destination: "saas",
          domains: ["project-domain", "example.com"],
          assetsDomain: "project-domain",
          excludeWstdDomainFromSearch: true,
        }
      )
    ).toBe(false);
  });

  test("rejects builder tokens publishing static builds", () => {
    expect(
      canTokenPublishDeployment(
        { ...token, relation: "builders" },
        {
          destination: "static",
          name: "build.zip",
          assetsDomain: "project-domain",
          templates: [],
        }
      )
    ).toBe(false);
  });

  test("allows tokens with full publish permission", () => {
    expect(
      canTokenPublishDeployment(
        { ...token, relation: "editors", canPublish: true },
        {
          destination: "saas",
          domains: ["example.com"],
          assetsDomain: "project-domain",
          excludeWstdDomainFromSearch: true,
        }
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// unpublishBuild
// ---------------------------------------------------------------------------

describe("unpublishBuild", () => {
  test("throws AuthorizationError when caller lacks edit access", async () => {
    const projectId = uid();
    await seed.project(db, { id: projectId, userId: "owner-1" });

    await expect(
      unpublishBuild({ projectId, domain: "example.com" }, createContext())
    ).rejects.toThrow(AuthorizationError);
  });

  test("throws when domain is not published", async () => {
    const projectId = uid();
    await seedProjectWithBuild({ projectId, build: { id: uid() } });

    await expect(
      unpublishBuild({ projectId, domain: "example.com" }, createContext())
    ).rejects.toThrow("is not published");
  });

  test("deletes build when it has only the one domain", async () => {
    const projectId = uid();
    await seedProjectWithBuild({ projectId, build: { id: uid() } });
    await seed.build(db, {
      ...buildRow,
      id: "build-prod",
      projectId,
      deployment: JSON.stringify({
        destination: "saas",
        domains: ["example.com"],
      }),
    });

    await unpublishBuild({ projectId, domain: "example.com" }, createContext());
    expect(await productionBuilds(projectId)).toEqual([]);
  });

  test("updates build deployment when it has multiple domains", async () => {
    const projectId = uid();
    await seedProjectWithBuild({ projectId, build: { id: uid() } });
    await seed.build(db, {
      ...buildRow,
      id: "build-prod",
      projectId,
      deployment: JSON.stringify({
        destination: "saas",
        domains: ["example.com", "other.com"],
      }),
    });

    await unpublishBuild({ projectId, domain: "example.com" }, createContext());

    const [production] = await productionBuilds(projectId);
    expect(JSON.parse(production.deployment ?? "")).toEqual({
      destination: "saas",
      domains: ["other.com"],
    });
  });
});
