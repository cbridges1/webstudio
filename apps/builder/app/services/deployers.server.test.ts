import { afterEach, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_SECRET = "test-auth-secret";
  process.env.DEPLOY_CREDENTIALS_KEY = "test-deploy-credentials-key-0123456789";
});

import { build, eq, project, projectDeployTarget } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import {
  checkDeployer,
  createDeploymentClient,
  loadDeployerSettings,
  loadProjectDeploySettings,
  recordDeployReport,
  removeDeployer,
  saveDeployer,
  setProjectDeployTarget,
} from "./deployers.server";
import env from "~/env/env.server";
import { createPublishToken, verifyPublishToken } from "./publish-token.server";
import {
  credentialsKey,
  decryptCredentials,
} from "@webstudio-is/deploy-protocol/credentials";

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
  env.DEPLOYER_URL = undefined;
  env.DEPLOYER_API_KEY = undefined;
  env.DEPLOYER_BUILDER_URL = undefined;
});

const target = {
  host: "directory",
  config: { site: "p1", url: "https://p1.example.com/" },
};

/** An app admin, a project owner and their project, and the deployer. */
const setup = async () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  await seed.user(db, { id: "admin", role: "admin" });
  await seed.workspace(db, { id: workspaceId, userId: "owner" });
  await seed.project(db, { id: "project-1", userId: "owner", workspaceId });
  await saveDeployer(
    { url: "http://deploy.test/", apiKey: "secret-api-key-1234" },
    contextFor("admin")
  );
};

describe("deployer", () => {
  test("admins set it without seeing the key", async () => {
    await setup();
    expect(await loadDeployerSettings(contextFor("admin"))).toEqual({
      source: "app",
      url: "http://deploy.test/",
      builderUrl: null,
      apiKeyEnding: "1234",
    });
    // A save without a key keeps it.
    await saveDeployer(
      { url: "http://deploy2.test/", builderUrl: "http://builder:3000" },
      contextFor("admin")
    );
    expect(await loadDeployerSettings(contextFor("admin"))).toMatchObject({
      url: "http://deploy2.test/",
      builderUrl: "http://builder:3000",
      apiKeyEnding: "1234",
    });
  });

  test("only admins manage it", async () => {
    await setup();
    await expect(loadDeployerSettings(contextFor("owner"))).rejects.toThrow(
      "Only admins"
    );
    await expect(
      saveDeployer({ url: "http://evil.test/" }, contextFor("owner"))
    ).rejects.toThrow("Only admins");
    await expect(removeDeployer(contextFor("owner"))).rejects.toThrow(
      "Only admins"
    );
  });

  test("admins have Better Auth's admin role among their roles", async () => {
    await seed.user(db, { id: "both", role: "user,admin" });
    await seed.user(db, { id: "superadmin", role: "superadmin" });
    expect(await loadDeployerSettings(contextFor("both"))).toEqual({
      source: "none",
    });
    await expect(
      loadDeployerSettings(contextFor("superadmin"))
    ).rejects.toThrow("Only admins");
  });

  test("the environment's replaces the saved one and can't be changed", async () => {
    await setup();
    env.DEPLOYER_URL = "http://env-deploy.test/";
    env.DEPLOYER_API_KEY = "env-api-key-9876";
    expect(await loadDeployerSettings(contextFor("admin"))).toEqual({
      source: "env",
      url: "http://env-deploy.test/",
      builderUrl: null,
      apiKeyEnding: "9876",
    });
    await expect(
      saveDeployer({ url: "http://x.test/" }, contextFor("admin"))
    ).rejects.toThrow("set by the builder's environment");
    await expect(removeDeployer(contextFor("admin"))).rejects.toThrow(
      "set by the builder's environment"
    );
    const calls = stubDeployer(() => ({ success: true, data: { hosts: [] } }));
    await checkDeployer(contextFor("admin"));
    expect(calls).toEqual([
      {
        url: "http://env-deploy.test/v1/hosts",
        auth: "Bearer env-api-key-9876",
        body: undefined,
      },
    ]);
  });
});

describe("project deploy target", () => {
  test("is checked with the deployer before it's saved", async () => {
    await setup();
    const calls = stubDeployer(() => ({ success: false, error: "bad site" }));
    expect(
      await setProjectDeployTarget(
        { projectId: "project-1", target },
        contextFor("owner")
      )
    ).toEqual({ success: false, error: "bad site" });
    expect(calls).toEqual([
      {
        url: "http://deploy.test/v1/validate",
        auth: "Bearer secret-api-key-1234",
        body: { projectId: "project-1", target },
      },
    ]);
    expect(await db.select().from(projectDeployTarget)).toEqual([]);
  });

  test("is saved and loaded", async () => {
    await setup();
    stubDeployer();
    expect(
      await setProjectDeployTarget(
        { projectId: "project-1", target },
        contextFor("owner")
      )
    ).toEqual({ success: true });
    expect(
      await loadProjectDeploySettings(
        { projectId: "project-1" },
        contextFor("owner")
      )
    ).toEqual({
      hasDeployer: true,
      canManageDeployer: false,
      target: { ...target, credentials: { status: "none" } },
    });
  });

  test("keeps credentials encrypted for the deployer to read, never sending them", async () => {
    await setup();
    let accept = true;
    const calls = stubDeployer(() =>
      accept ? { success: true } : { success: false, error: "bad key" }
    );
    const firebase = { host: "firebase", config: { site: "my-site" } };
    const key = {
      client_email: "deploy@project.iam.gserviceaccount.com",
      private_key: "very-secret-private-key",
    };
    const save = (credentials?: Record<string, unknown> | null) =>
      setProjectDeployTarget(
        {
          projectId: "project-1",
          target: { ...firebase, credentials },
        },
        contextFor("owner")
      );
    const saved = async () => {
      const [row] = await db.select().from(projectDeployTarget);
      return row?.credentials == null
        ? row?.credentials
        : decryptCredentials(
            "project-1",
            row.credentials,
            credentialsKey(process.env.DEPLOY_CREDENTIALS_KEY)
          );
    };
    const summary = async (projectId = "project-1") =>
      (await loadProjectDeploySettings({ projectId }, contextFor("owner")))
        .target?.credentials;

    expect(await save(key)).toEqual({ success: true });
    // The deployer checks the saved target, reading the credentials itself.
    expect(calls.at(-1)!.body).toEqual({
      projectId: "project-1",
      target: firebase,
    });
    const [row] = await db.select().from(projectDeployTarget);
    expect(row.credentials).toMatch(/^enc1\./);
    expect(row.credentials).not.toContain("very-secret");
    expect(await saved()).toEqual(key);
    expect(await summary()).toEqual({
      status: "saved",
      account: key.client_email,
    });

    // Saving without credentials keeps them.
    expect(await save(undefined)).toEqual({ success: true });
    expect(await saved()).toEqual(key);

    // A rejected check puts the previous credentials back.
    accept = false;
    expect(
      await save({ client_email: "other@x.com", private_key: "k" })
    ).toEqual({ success: false, error: "bad key" });
    expect(await saved()).toEqual(key);
    accept = true;

    await seed.build(db, {
      id: "build-1",
      projectId: "project-1",
      deployment: JSON.stringify({ destination: "saas", domains: [] }),
      publishStatus: "PENDING",
    });
    await createDeploymentClient({ db, builderOrigin: "http://x" }).publish({
      projectId: "project-1",
      buildId: "build-1",
      label: "Project",
    });
    expect(calls.at(-1)!.body).toMatchObject({
      projectId: "project-1",
      target: firebase,
    });
    expect(JSON.stringify(calls)).not.toContain("very-secret");

    // Another project can't use a copied value.
    await seed.project(db, {
      id: "project-2",
      userId: "owner",
      workspaceId: "00000000-0000-4000-8000-000000000001",
    });
    await db
      .insert(projectDeployTarget)
      .values({ ...row, projectId: "project-2" });
    expect(await summary("project-2")).toEqual({ status: "unreadable" });

    expect(await save(null)).toEqual({ success: true });
    expect(await summary()).toEqual({ status: "none" });
  });

  test("puts back no target when the first check fails", async () => {
    await setup();
    stubDeployer(() => ({ success: false, error: "no" }));
    await setProjectDeployTarget(
      {
        projectId: "project-1",
        target: {
          host: "firebase",
          config: {},
          credentials: { a: 1 },
        },
      },
      contextFor("owner")
    );
    expect(await db.select().from(projectDeployTarget)).toEqual([]);
  });

  test("stays when the deployer is removed", async () => {
    await setup();
    stubDeployer();
    await setProjectDeployTarget(
      { projectId: "project-1", target },
      contextFor("owner")
    );
    await removeDeployer(contextFor("admin"));
    expect(await db.select().from(projectDeployTarget)).toHaveLength(1);
    expect(
      await loadProjectDeploySettings(
        { projectId: "project-1" },
        contextFor("owner")
      )
    ).toMatchObject({ hasDeployer: false });
    await expect(
      setProjectDeployTarget(
        { projectId: "project-1", target },
        contextFor("owner")
      )
    ).rejects.toThrow("No deployer is set up");
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
  const buildError = async () =>
    (
      await db
        .select({ error: build.publishError })
        .from(build)
        .where(eq(build.id, "build-1"))
    )[0].error;

  test("sends the build, a scoped token and the target", async () => {
    await setup();
    await seedBuild();
    const calls = stubDeployer();
    await setProjectDeployTarget(
      { projectId: "project-1", target },
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
    await setup();
    await saveDeployer(
      { url: "http://deploy.test/", builderUrl: "http://builder:3000" },
      contextFor("admin")
    );
    await seedBuild();
    const calls = stubDeployer();
    await setProjectDeployTarget(
      { projectId: "project-1", target },
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

  test("fails the build when no deployer is set up", async () => {
    await seed.project(db, { id: "project-1", userId: "owner" });
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
      error: expect.stringContaining("No deployer is set up"),
    });
    expect(await buildError()).toContain("No deployer is set up");
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
    // Kept on the build, so Publish can say why.
    expect(await buildError()).toContain("no deploy target");
  });

  test("keeps the deployer's error for a failed publish", async () => {
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
        body: { status: "FAILED", error: "Site ID is taken" },
      },
      db
    );
    expect(await buildStatus()).toBe("FAILED");
    expect(await buildError()).toBe("Site ID is taken");
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
    await setup();
    const calls = stubDeployer();
    await setProjectDeployTarget(
      { projectId: "project-1", target },
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
      body: { projectId: "project-1", target },
    });
    const [row] = await db
      .select({ publishedUrl: project.publishedUrl })
      .from(project)
      .where(eq(project.id, "project-1"));
    expect(row.publishedUrl).toBeNull();
  });
});
