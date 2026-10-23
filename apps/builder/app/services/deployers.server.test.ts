import { afterEach, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_SECRET = "test-auth-secret";
});

import {
  build,
  deployer,
  eq,
  project,
  projectDeployTarget,
} from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import {
  createDeployer,
  createDeploymentClient,
  listDeployers,
  loadProjectDeploySettings,
  recordDeployReport,
  removeDeployer,
  setProjectDeployTarget,
} from "./deployers.server";
import { createPublishToken, verifyPublishToken } from "./publish-token.server";

const db = setupTestDb();

const contextFor = (userId: string) =>
  ({
    db,
    authorization: { type: "user", userId },
  }) as unknown as AppContext;

type Call = { url: string; auth: string | null; body: unknown };

/** Stubs fetch as a deployer that accepts everything and records the calls. */
const stubDeployer = (
  respond: (path: string) => unknown = () => ({ success: true })
) => {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      auth: new Headers(init.headers).get("Authorization"),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return Response.json(respond(new URL(url).pathname));
  });
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const target = {
  host: "directory",
  config: { site: "p1", url: "https://p1.example.com/" },
};

/** Owner, admin member, viewer member, a project in the workspace and a deployer. */
const setup = async () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  await seed.workspace(db, { id: workspaceId, userId: "owner" });
  await seed.workspaceMember(db, {
    workspaceId,
    userId: "admin",
    relation: "administrators",
  });
  await seed.workspaceMember(db, {
    workspaceId,
    userId: "viewer",
    relation: "viewers",
  });
  await seed.project(db, { id: "project-1", userId: "owner", workspaceId });
  const created = await createDeployer(
    {
      workspaceId,
      name: "Main",
      url: "http://deploy.test/",
      apiKey: "secret-api-key-1234",
    },
    contextFor("admin")
  );
  return { workspaceId, deployerId: created.id };
};

describe("workspace deployers", () => {
  test("admins add and list them without seeing the key", async () => {
    const { workspaceId } = await setup();
    expect(await listDeployers({ workspaceId }, contextFor("owner"))).toEqual([
      expect.objectContaining({
        name: "Main",
        url: "http://deploy.test/",
        apiKeyEnding: "1234",
      }),
    ]);
    const [listed] = await listDeployers({ workspaceId }, contextFor("admin"));
    expect(listed).not.toHaveProperty("apiKey");
  });

  test("other members can't manage them", async () => {
    const { workspaceId, deployerId } = await setup();
    await expect(
      listDeployers({ workspaceId }, contextFor("viewer"))
    ).rejects.toThrow("Only the workspace's owner and admins");
    await expect(
      removeDeployer({ deployerId }, contextFor("viewer"))
    ).rejects.toThrow("Only the workspace's owner and admins");
  });
});

describe("project deploy target", () => {
  test("is checked with the deployer before it's saved", async () => {
    const { deployerId } = await setup();
    const calls = stubDeployer(() => ({ success: false, error: "bad site" }));
    expect(
      await setProjectDeployTarget(
        { projectId: "project-1", target: { deployerId, ...target } },
        contextFor("owner")
      )
    ).toEqual({ success: false, error: "bad site" });
    expect(calls).toEqual([
      {
        url: "http://deploy.test/v1/validate",
        auth: "Bearer secret-api-key-1234",
        body: { target },
      },
    ]);
    expect(await db.select().from(projectDeployTarget)).toEqual([]);
  });

  test("is saved and loaded", async () => {
    const { deployerId, workspaceId } = await setup();
    stubDeployer();
    expect(
      await setProjectDeployTarget(
        { projectId: "project-1", target: { deployerId, ...target } },
        contextFor("owner")
      )
    ).toEqual({ success: true });
    expect(
      await loadProjectDeploySettings(
        { projectId: "project-1" },
        contextFor("owner")
      )
    ).toEqual({
      workspaceId,
      canManageDeployers: true,
      deployers: [{ id: deployerId, name: "Main" }],
      target: { deployerId, ...target, credentials: undefined },
    });
  });

  test("goes away with its deployer", async () => {
    const { deployerId } = await setup();
    stubDeployer();
    await setProjectDeployTarget(
      { projectId: "project-1", target: { deployerId, ...target } },
      contextFor("owner")
    );
    await removeDeployer({ deployerId }, contextFor("owner"));
    expect(await db.select().from(projectDeployTarget)).toEqual([]);
  });

  test("can't use another workspace's deployer", async () => {
    const { deployerId } = await setup();
    await seed.project(db, { id: "project-2", userId: "owner" });
    await expect(
      setProjectDeployTarget(
        { projectId: "project-2", target: { deployerId, ...target } },
        contextFor("owner")
      )
    ).rejects.toThrow("That deployer belongs to another workspace");
  });
});

describe("publish", () => {
  const seedBuild = () =>
    seed.build(db, {
      id: "build-1",
      projectId: "project-1",
      deployment: JSON.stringify({ destination: "saas", domains: [] }),
      publishStatus: "PENDING",
    });

  const buildStatus = async () =>
    (
      await db
        .select({ status: build.publishStatus })
        .from(build)
        .where(eq(build.id, "build-1"))
    )[0].status;

  test("sends the build, a scoped token and the target", async () => {
    const { deployerId } = await setup();
    await seedBuild();
    const calls = stubDeployer();
    await setProjectDeployTarget(
      { projectId: "project-1", target: { deployerId, ...target } },
      contextFor("owner")
    );
    const client = createDeploymentClient({
      db,
      builderOrigin: "http://localhost:5180",
    });

    expect(
      await client.publish({
        projectId: "project-1",
        buildId: "build-1",
        label: "Project",
      })
    ).toEqual({ success: true });

    const publish = calls.at(-1)!;
    expect(publish.url).toBe("http://deploy.test/v1/publish");
    const body = publish.body as {
      builder: { origin: string; token: string };
    };
    expect(body).toMatchObject({
      buildId: "build-1",
      builder: { origin: "http://localhost:5180" },
      target,
      label: "Project",
    });
    expect(verifyPublishToken(body.builder.token)).toMatchObject({
      projectId: "project-1",
      buildId: "build-1",
    });
    expect(await buildStatus()).toBe("PENDING");
  });

  test("uses the deployer's builder address when it has one", async () => {
    const { deployerId } = await setup();
    await db
      .update(deployer)
      .set({ builderUrl: "http://builder:3000" })
      .where(eq(deployer.id, deployerId));
    await seedBuild();
    const calls = stubDeployer();
    await setProjectDeployTarget(
      { projectId: "project-1", target: { deployerId, ...target } },
      contextFor("owner")
    );
    await createDeploymentClient({ db, builderOrigin: "http://x" }).publish({
      projectId: "project-1",
      buildId: "build-1",
      label: "Project",
    });
    expect(calls.at(-1)!.body).toMatchObject({
      builder: { origin: "http://builder:3000" },
    });
  });

  test("fails the build when the project has no target", async () => {
    await setup();
    await seedBuild();
    const result = await createDeploymentClient({
      db,
      builderOrigin: "http://x",
    }).publish({
      projectId: "project-1",
      buildId: "build-1",
      label: "Project",
    });
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("no deploy target"),
    });
    expect(await buildStatus()).toBe("FAILED");
  });

  test("records the deployer's report", async () => {
    await setup();
    await seedBuild();
    const token = createPublishToken({
      projectId: "project-1",
      buildId: "build-1",
    });
    await recordDeployReport(
      {
        buildId: "build-1",
        token,
        body: { status: "PUBLISHED", url: "https://p1.example.com/" },
      },
      db
    );
    expect(await buildStatus()).toBe("PUBLISHED");
    const [row] = await db
      .select({ publishedUrl: project.publishedUrl })
      .from(project)
      .where(eq(project.id, "project-1"));
    expect(row.publishedUrl).toBe("https://p1.example.com/");
  });

  test("rejects a report with another build's token", async () => {
    await setup();
    await seedBuild();
    const token = createPublishToken({
      projectId: "project-1",
      buildId: "build-2",
    });
    await expect(
      recordDeployReport(
        { buildId: "build-1", token, body: { status: "FAILED", error: "x" } },
        db
      )
    ).rejects.toThrow("Invalid or expired publish token");
    expect(await buildStatus()).toBe("PENDING");
  });

  test("unpublish removes the site and clears the published link", async () => {
    const { deployerId } = await setup();
    const calls = stubDeployer();
    await setProjectDeployTarget(
      { projectId: "project-1", target: { deployerId, ...target } },
      contextFor("owner")
    );
    await db
      .update(project)
      .set({ publishedUrl: "https://p1.example.com/" })
      .where(eq(project.id, "project-1"));
    expect(
      await createDeploymentClient({ db, builderOrigin: "http://x" }).unpublish(
        { projectId: "project-1" }
      )
    ).toEqual({ success: true });
    expect(calls.at(-1)).toMatchObject({
      url: "http://deploy.test/v1/unpublish",
      body: { target },
    });
    const [row] = await db
      .select({ publishedUrl: project.publishedUrl })
      .from(project)
      .where(eq(project.id, "project-1"));
    expect(row.publishedUrl).toBeNull();
  });
});
