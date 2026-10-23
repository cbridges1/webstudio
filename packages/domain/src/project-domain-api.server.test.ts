import { expect, test, vi } from "vitest";
import { and, build, eq, isNotNull } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import {
  getProjectPublishJob,
  listProjectPublishes,
  publishProject,
  publishStaticProject,
  unpublishProjectDomains,
} from "./project-domain-api.server";

const db = setupTestDb();
const context = { db } as unknown as AppContext;

const loadedProject = {
  id: "project-1",
  userId: "user-1",
  title: "Project One",
  domain: "project.wstd.io",
  createdAt: "2024-01-01T00:00:00.000Z",
  isDeleted: false,
  marketplaceApprovalStatus: "UNLISTED" as const,
  previewImageAssetId: null,
  tags: [],
  workspaceId: null,
  previewImageAsset: null,
  latestBuildVirtual: null,
  latestStaticBuild: null,
  domainsVirtual: [
    {
      id: "project-domain-1",
      projectId: "project-1",
      domainId: "domain-1",
      domain: "example.com",
      status: "ACTIVE" as const,
      verified: true,
      domainTxtRecord: null,
      expectedTxtRecord: "webstudio=domain-1",
      cname: "proxy.webstudio.is",
      error: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
      latestBuildVirtual: null,
    },
  ],
};

const devBuildRow = {
  id: "build-dev",
  projectId: "project-1",
  version: 1,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  pages: JSON.stringify({
    meta: {},
    homePage: {
      id: "page-1",
      name: "Home",
      path: "",
      title: '"Home"',
      meta: {},
      rootInstanceId: "body-1",
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

/** project-1, owned by user-1, with a development build. */
const seedProject = async (row: typeof devBuildRow = devBuildRow) => {
  await seed.project(db, {
    id: "project-1",
    userId: "user-1",
    title: "Project One",
    domain: "project.wstd.io",
  });
  await seed.build(db, row);
};

const productionBuilds = async () =>
  await db
    .select()
    .from(build)
    .where(and(eq(build.projectId, "project-1"), isNotNull(build.deployment)));

/** A publish record of project-1. */
const seedPublish = async (
  row: Partial<Omit<typeof devBuildRow, "deployment">> & {
    id: string;
    deployment: string | null;
    createdAt?: string;
    updatedAt?: string;
    publishStatus?: "PENDING" | "PUBLISHED" | "FAILED";
  }
) => {
  await seed.build(db, { ...devBuildRow, ...row });
};

const createPublishContext = (
  publish = vi.fn().mockResolvedValue({ success: true })
) =>
  ({
    db,
    authorization: { type: "user", userId: "user-1" },
    deployment: {
      deployments: {
        publish,
        unpublish: vi.fn().mockResolvedValue({ success: true }),
      },
      env: {
        BUILDER_ORIGIN: "https://apps.webstudio.is",
        GITHUB_REF_NAME: "main",
        GITHUB_SHA: "sha-1",
        PUBLISHER_HOST: "wstd.io",
      },
    },
  }) as unknown as AppContext;

test("publishes saas project through shared domain service", async () => {
  await seedProject();
  const publish = vi.fn().mockResolvedValue({ success: true });

  const result = await publishProject(
    {
      project: loadedProject,
      domains: ["project.wstd.io", "example.com"],
      target: "production",
    },
    createPublishContext(publish)
  );
  expect(result).toMatchObject({ deploymentNotImplemented: false });

  const [production] = await productionBuilds();
  expect(result.build.id).toBe(production.id);
  expect(JSON.parse(production.deployment ?? "")).toEqual({
    destination: "saas",
    target: "production",
    domains: ["project.wstd.io", "example.com"],
    assetsDomain: "project.wstd.io",
    excludeWstdDomainFromSearch: true,
  });
  expect(publish).toHaveBeenCalledWith({
    projectId: "project-1",
    buildId: production.id,
    label: "Project One - project-1",
  });
});

test("reports a deployer's refusal", async () => {
  await seedProject();

  await expect(
    publishProject(
      {
        project: loadedProject,
        domains: ["project.wstd.io"],
        target: "staging",
      },
      createPublishContext(
        vi.fn().mockResolvedValue({
          success: false,
          error: "This project has no deploy target",
        })
      )
    )
  ).rejects.toThrow("This project has no deploy target");
});

test("refuses static downloads without creating a build", async () => {
  await seedProject();
  const publish = vi.fn().mockResolvedValue({ success: true });

  const result = await publishStaticProject(
    {
      projectId: "project-1",
      name: "project.zip",
      templates: [],
    },
    createPublishContext(publish)
  );
  expect(result).toMatchObject({ success: false });
  expect(await productionBuilds()).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
});

test("rejects publishing when dev build has orphan resource references", async () => {
  await seedProject({
    ...devBuildRow,
    dataSources: JSON.stringify([
      {
        type: "resource",
        id: "dataSourceId",
        name: "pinnedAnnouncementData_1",
        resourceId: "missingResourceId",
      },
    ]),
  });
  const publish = vi.fn().mockResolvedValue({ success: true });

  await expect(
    publishProject(
      {
        project: loadedProject,
        domains: ["project.wstd.io"],
        target: "staging",
      },
      createPublishContext(publish)
    )
  ).rejects.toThrow(
    `Cannot publish: resource variable "pinnedAnnouncementData_1" (dataSourceId) references missing resource "missingResourceId".`
  );

  expect(await productionBuilds()).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
});

test("clears publish records even when deployment unpublish fails", async () => {
  await seedProject();
  await seedPublish({
    id: "build-prod",
    deployment: JSON.stringify({ destination: "saas", domains: ["example"] }),
  });
  const failingContext = {
    db,
    authorization: { type: "user", userId: "user-1" },
    deployment: {
      deployments: {
        unpublish: vi
          .fn()
          .mockResolvedValue({ success: false, error: "Cloudflare failed" }),
      },
      env: { PUBLISHER_HOST: "wstd.io" },
    },
  } as unknown as AppContext;

  await expect(
    unpublishProjectDomains(
      {
        projectId: "project-1",
        domains: ["example.wstd.io"],
      },
      failingContext
    )
  ).rejects.toThrow("Failed to unpublish example.wstd.io: Cloudflare failed");

  expect(await productionBuilds()).toEqual([]);
});

test("lists non-static project publishes", async () => {
  await seedProject();
  await seedPublish({
    id: "build-prod",
    version: 3,
    createdAt: "2024-01-03T00:00:00.000Z",
    deployment: JSON.stringify({
      destination: "saas",
      domains: ["example.com", "www.example.com"],
    }),
  });
  await seedPublish({
    id: "build-static",
    version: 2,
    createdAt: "2024-01-02T00:00:00.000Z",
    deployment: JSON.stringify({
      destination: "static",
      name: "project.zip",
    }),
  });

  await expect(listProjectPublishes("project-1", context)).resolves.toEqual({
    publishes: [
      {
        id: "build-prod",
        jobId: "build-prod",
        version: 3,
        target: "production",
        domains: ["example.com", "www.example.com"],
        createdAt: "2024-01-03T00:00:00.000Z",
      },
    ],
  });
});

test("infers targets for publish records created before targets were stored", async () => {
  await seedProject();
  await seedPublish({
    id: "build-production",
    version: 2,
    createdAt: "2024-01-02T00:00:00.000Z",
    deployment: JSON.stringify({
      destination: "saas",
      domains: ["example.com"],
      assetsDomain: "project.wstd.io",
    }),
  });
  await seedPublish({
    id: "build-staging",
    version: 1,
    createdAt: "2024-01-01T00:00:00.000Z",
    deployment: JSON.stringify({
      destination: "saas",
      domains: ["project.wstd.io"],
      assetsDomain: "project.wstd.io",
    }),
  });

  const result = await listProjectPublishes("project-1", context);

  expect(result.publishes.map(({ id, target }) => ({ id, target }))).toEqual([
    { id: "build-production", target: "production" },
    { id: "build-staging", target: "staging" },
  ]);
});

test("preserves a production target with one explicit custom domain", async () => {
  await seedProject();

  const published = await publishProject(
    {
      project: loadedProject,
      target: "production",
      domains: ["example.com"],
    },
    createPublishContext()
  );
  const buildId = published.build.id;

  const { publishes } = await listProjectPublishes("project-1", context);
  expect(publishes).toEqual([
    {
      id: buildId,
      jobId: buildId,
      version: 1,
      target: "production",
      domains: ["example.com"],
      createdAt: expect.any(String),
    },
  ]);

  await expect(
    getProjectPublishJob({ projectId: "project-1", jobId: buildId }, context)
  ).resolves.toMatchObject({
    id: buildId,
    target: "production",
    domains: ["example.com"],
  });
});

test("returns publish job status from deployment record", async () => {
  await seedProject();
  await seedPublish({
    id: "build-prod",
    version: 3,
    createdAt: "2024-01-03T00:00:00.000Z",
    updatedAt: "2024-01-03T00:01:00.000Z",
    publishStatus: "PUBLISHED",
    deployment: JSON.stringify({
      destination: "saas",
      target: "production",
      domains: ["example.com"],
    }),
  });

  await expect(
    getProjectPublishJob(
      { projectId: "project-1", jobId: "build-prod" },
      context
    )
  ).resolves.toEqual({
    id: "build-prod",
    version: 3,
    status: "success",
    target: "production",
    domains: ["example.com"],
    createdAt: "2024-01-03T00:00:00.000Z",
    completedAt: "2024-01-03T00:01:00.000Z",
  });
});

test.each([
  ["PENDING", "pending", undefined],
  ["FAILED", "failed", "2024-01-03T00:01:00.000Z"],
] as const)(
  "maps %s publisher state without claiming success",
  async (publishStatus, status, completedAt) => {
    await seedProject();
    await seedPublish({
      id: "build-prod",
      version: 3,
      createdAt: "2024-01-03T00:00:00.000Z",
      updatedAt: "2024-01-03T00:01:00.000Z",
      publishStatus,
      deployment: JSON.stringify({
        destination: "saas",
        domains: ["example.com"],
      }),
    });

    await expect(
      getProjectPublishJob(
        { projectId: "project-1", jobId: "build-prod" },
        context
      )
    ).resolves.toMatchObject({ status, completedAt });
  }
);

test("returns undefined when publish job is missing", async () => {
  await expect(
    getProjectPublishJob({ projectId: "project-1", jobId: "missing" }, context)
  ).resolves.toBeUndefined();
});
