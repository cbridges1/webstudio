import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_SECRET = "test-auth-secret";
  process.env.DEPLOY_CREDENTIALS_KEY = "test-deploy-credentials-key-0123456789";
});

import {
  and,
  build,
  deployJob,
  deployWorker,
  eq,
  project,
  projectDeployTarget,
} from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import {
  checkDeployer,
  createDeploymentClient,
  jobWaits,
  listDeployerHosts,
  loadDeployerSettings,
  loadProjectDeploySettings,
  recordDeployReport,
  saveDeployer,
  setProjectDeployTarget,
} from "./deployers.server";
import { createPublishToken, verifyPublishToken } from "./publish-token.server";
import {
  credentialsKey,
  decryptCredentials,
} from "@webstudio-is/deploy-protocol/credentials";
import env from "~/env/env.server";

const db = setupTestDb();

const contextFor = (userId: string) =>
  ({
    db,
    authorization: { type: "user", userId },
  }) as unknown as AppContext;

const waits = { ...jobWaits };

beforeEach(() => {
  Object.assign(jobWaits, { validateMs: 2000, unpublishMs: 2000, pollMs: 5 });
});

afterEach(() => {
  Object.assign(jobWaits, waits);
  vi.unstubAllGlobals();
  env.DEPLOYER_WAKE_URL = undefined;
  env.DEPLOYER_WAKE_TOKEN = undefined;
  env.DEPLOYER_BUILDER_URL = undefined;
  env.DEPLOYER_QUEUE = undefined;
  stopAnswering?.();
});

type Call = { url: string; auth: string | null; body: unknown };

/** Stubs fetch as a wake URL that accepts everything and records the calls. */
const stubWake = (status = 202) => {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      auth: new Headers(init.headers).get("Authorization"),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(null, { status });
  });
  return calls;
};

let stopAnswering: (() => void) | undefined;

type QueuedJob = typeof deployJob.$inferSelect;

/**
 * Plays the deploy service: finishes each queued job with `respond`'s outcome. Records the
 * jobs it saw.
 */
const answerJobs = (
  respond: (job: QueuedJob) => {
    status: "succeeded" | "failed";
    error?: string;
  }
) => {
  const seen: QueuedJob[] = [];
  let stopped = false;
  stopAnswering = () => {
    stopped = true;
  };
  void (async () => {
    while (stopped === false) {
      const queued = await db
        .select()
        .from(deployJob)
        .where(eq(deployJob.status, "queued"));
      for (const job of queued) {
        seen.push(job);
        const outcome = respond(job);
        await db
          .update(deployJob)
          .set({ status: outcome.status, error: outcome.error ?? null })
          .where(eq(deployJob.id, job.id));
      }
      await new Promise((done) => setTimeout(done, 5));
    }
  })();
  return seen;
};

const target = {
  host: "directory",
  config: { site: "p1", url: "https://p1.example.com/" },
};

const hosts = [
  { id: "directory", label: "Folder", config: {}, credentials: null },
];

/** An app admin, a project owner and their project, and a registered deploy service. */
const setup = async ({ worker = true } = {}) => {
  await seed.user(db, { id: "admin", role: "admin" });
  await seed.workspace(db, {
    id: "00000000-0000-4000-8000-000000000001",
    userId: "owner",
  });
  await seed.project(db, {
    id: "project-1",
    userId: "owner",
    workspaceId: "00000000-0000-4000-8000-000000000001",
  });
  if (worker) {
    await db.insert(deployWorker).values({ id: "deploy-1", hosts });
  }
};

const jobs = () => db.select().from(deployJob).orderBy(deployJob.createdAt);

describe("deploy service settings", () => {
  test("admins set the wake URL and builder address without seeing the token", async () => {
    await setup();
    expect(await loadDeployerSettings(contextFor("admin"))).toEqual({
      source: "app",
      wakeUrl: null,
      wakeTokenEnding: null,
      builderUrl: null,
      workers: [
        {
          id: "deploy-1",
          seenAt: expect.any(String),
          running: true,
          hosts: ["Folder"],
        },
      ],
    });
    await saveDeployer(
      {
        wakeUrl: "https://deploy.test/wake",
        wakeToken: "wake-token-1234",
        builderUrl: "http://builder:3000",
      },
      contextFor("admin")
    );
    // A save without a token keeps it.
    await saveDeployer(
      { wakeUrl: "https://deploy2.test/wake", builderUrl: "" },
      contextFor("admin")
    );
    expect(await loadDeployerSettings(contextFor("admin"))).toMatchObject({
      wakeUrl: "https://deploy2.test/wake",
      wakeTokenEnding: "1234",
      builderUrl: null,
    });
    await saveDeployer(
      { wakeUrl: "https://deploy2.test/wake", removeWakeToken: true },
      contextFor("admin")
    );
    expect(await loadDeployerSettings(contextFor("admin"))).toMatchObject({
      wakeTokenEnding: null,
    });
  });

  test("only admins manage them", async () => {
    await setup();
    await expect(loadDeployerSettings(contextFor("owner"))).rejects.toThrow(
      "Only admins"
    );
    await expect(
      saveDeployer({ wakeUrl: "http://evil.test/" }, contextFor("owner"))
    ).rejects.toThrow("Only admins");
    await expect(checkDeployer(contextFor("owner"))).rejects.toThrow(
      "Only admins"
    );
  });

  test("admins have Better Auth's admin role among their roles", async () => {
    await seed.user(db, { id: "both", role: "user,admin" });
    await seed.user(db, { id: "superadmin", role: "superadmin" });
    expect(await loadDeployerSettings(contextFor("both"))).toMatchObject({
      workers: [],
    });
    await expect(
      loadDeployerSettings(contextFor("superadmin"))
    ).rejects.toThrow("Only admins");
  });

  test("the environment's replace the saved ones and can't be changed", async () => {
    await setup();
    env.DEPLOYER_WAKE_URL = "http://env-deploy.test/wake";
    env.DEPLOYER_WAKE_TOKEN = "env-wake-token-9876";
    expect(await loadDeployerSettings(contextFor("admin"))).toMatchObject({
      source: "env",
      wakeUrl: "http://env-deploy.test/wake",
      wakeTokenEnding: "9876",
      builderUrl: null,
    });
    await expect(
      saveDeployer({ wakeUrl: "http://x.test/" }, contextFor("admin"))
    ).rejects.toThrow("builder's environment");
    const calls = stubWake();
    expect(await checkDeployer(contextFor("admin"))).toEqual({
      wake: { ok: true, status: 202 },
    });
    expect(calls).toEqual([
      {
        url: "http://env-deploy.test/wake",
        auth: "Bearer env-wake-token-9876",
        body: { test: true },
      },
    ]);
  });

  test("a failing wake URL is reported, not thrown", async () => {
    await setup();
    env.DEPLOYER_WAKE_URL = "http://env-deploy.test/wake";
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection refused");
    });
    expect(await checkDeployer(contextFor("admin"))).toEqual({
      wake: { ok: false, error: "connection refused" },
    });
  });
});

describe("project deploy target", () => {
  test("lists the registered deploy service's hosts", async () => {
    await setup();
    expect(
      await listDeployerHosts({ projectId: "project-1" }, contextFor("owner"))
    ).toEqual({ success: true, data: { hosts } });
  });

  test("is checked by the deploy service, which reads it from the database", async () => {
    await setup();
    const seen = answerJobs(() => ({ status: "failed", error: "bad site" }));
    expect(
      await setProjectDeployTarget(
        { projectId: "project-1", target },
        contextFor("owner")
      )
    ).toEqual({ success: false, error: "bad site" });
    expect(seen).toEqual([
      expect.objectContaining({
        kind: "validate",
        projectId: "project-1",
        request: {},
      }),
    ]);
    // The first target is removed again.
    expect(await db.select().from(projectDeployTarget)).toEqual([]);
  });

  test("is saved and loaded", async () => {
    await setup();
    answerJobs(() => ({ status: "succeeded" }));
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

  test("is kept unchecked when the deploy service doesn't answer", async () => {
    await setup();
    jobWaits.validateMs = 50;
    expect(
      await setProjectDeployTarget(
        { projectId: "project-1", target },
        contextFor("owner")
      )
    ).toEqual({
      success: true,
      warning: expect.stringContaining("didn't check it in time"),
    });
    expect(await db.select().from(projectDeployTarget)).toHaveLength(1);
    // Nobody took the check, so it's dropped.
    expect(await jobs()).toMatchObject([{ status: "canceled" }]);
  });

  test("is kept unchecked before any deploy service has connected", async () => {
    await setup({ worker: false });
    expect(
      await setProjectDeployTarget(
        { projectId: "project-1", target },
        contextFor("owner")
      )
    ).toEqual({
      success: true,
      warning: expect.stringContaining("No deploy service has connected"),
    });
    expect(await jobs()).toEqual([]);
    expect(
      await loadProjectDeploySettings(
        { projectId: "project-1" },
        contextFor("owner")
      )
    ).toMatchObject({ hasDeployer: false });
  });

  test("keeps credentials encrypted for the deploy service to read, never putting them in jobs", async () => {
    await setup();
    let accept = true;
    answerJobs(() =>
      accept ? { status: "succeeded" } : { status: "failed", error: "bad key" }
    );
    const firebase = { host: "firebase", config: { site: "my-site" } };
    const key = {
      client_email: "deploy@project.iam.gserviceaccount.com",
      private_key: "very-secret-private-key",
    };
    const save = (credentials?: Record<string, unknown> | null) =>
      setProjectDeployTarget(
        { projectId: "project-1", target: { ...firebase, credentials } },
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
    expect(JSON.stringify(await jobs())).not.toContain("very-secret");

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
});

describe("publish", () => {
  const seedBuild = (id = "build-1") =>
    seed.build(db, {
      id,
      projectId: "project-1",
      deployment: JSON.stringify({ destination: "saas", domains: [] }),
      publishStatus: "PENDING",
    });

  const buildRow = async (id = "build-1") =>
    (
      await db
        .select({ status: build.publishStatus, error: build.publishError })
        .from(build)
        .where(eq(build.id, id))
    )[0];

  const saveTarget = async () => {
    await db
      .insert(projectDeployTarget)
      .values({ projectId: "project-1", ...target });
  };

  const publish = (
    buildId = "build-1",
    builderOrigin = "http://localhost:5180"
  ) =>
    createDeploymentClient({ db, builderOrigin }).publish({
      projectId: "project-1",
      buildId,
      label: "Project",
    });

  test("queues a job with a scoped token and the builder's address, and wakes the deploy service", async () => {
    await setup();
    await saveTarget();
    await seedBuild();
    env.DEPLOYER_WAKE_URL = "https://deploy.test/wake";
    const wakes = stubWake();

    expect(await publish()).toEqual({ success: true });

    const [job] = await jobs();
    expect(job).toMatchObject({
      kind: "publish",
      projectId: "project-1",
      buildId: "build-1",
      status: "queued",
      request: { builderOrigin: "http://localhost:5180", label: "Project" },
    });
    expect(
      verifyPublishToken((job.request as { token: string }).token)
    ).toMatchObject({ projectId: "project-1", buildId: "build-1" });
    expect(wakes).toEqual([
      {
        url: "https://deploy.test/wake",
        auth: null,
        body: { jobId: job.id, kind: "publish", projectId: "project-1" },
      },
    ]);
    expect((await buildRow()).status).toBe("PENDING");
  });

  test("still queues when the wake URL fails", async () => {
    await setup();
    await saveTarget();
    await seedBuild();
    env.DEPLOYER_WAKE_URL = "https://deploy.test/wake";
    stubWake(503);
    expect(await publish()).toEqual({ success: true });
    expect(await jobs()).toHaveLength(1);
  });

  test("uses the builder address from the settings", async () => {
    await setup();
    await saveTarget();
    await seedBuild();
    await saveDeployer(
      { builderUrl: "http://builder:3000" },
      contextFor("admin")
    );
    await publish("build-1", "http://x");
    expect((await jobs())[0].request).toMatchObject({
      builderOrigin: "http://builder:3000",
    });
  });

  test("replaces a publish that's still queued", async () => {
    await setup();
    await saveTarget();
    await seedBuild("build-1");
    await seedBuild("build-2");
    await publish("build-1");
    await publish("build-2");
    expect((await jobs()).map((job) => [job.buildId, job.status])).toEqual([
      ["build-1", "canceled"],
      ["build-2", "queued"],
    ]);
    expect(await buildRow("build-1")).toEqual({
      status: "FAILED",
      error: "Replaced by a newer publish",
    });
  });

  test("fails the build when no deploy service has connected", async () => {
    await setup({ worker: false });
    await saveTarget();
    await seedBuild();
    expect(await publish()).toEqual({
      success: false,
      error: expect.stringContaining("No deploy service has connected"),
    });
    expect(await buildRow()).toEqual({
      status: "FAILED",
      error: expect.stringContaining("No deploy service has connected"),
    });
    expect(await jobs()).toEqual([]);
  });

  test("fails the build when the project has no target", async () => {
    await setup();
    await seedBuild();
    expect(await publish()).toEqual({
      success: false,
      error: expect.stringContaining("no deploy target"),
    });
    // Kept on the build, so Publish can say why.
    expect(await buildRow()).toEqual({
      status: "FAILED",
      error: expect.stringContaining("no deploy target"),
    });
  });

  test("keeps the deploy service's error for a failed publish", async () => {
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
    expect(await buildRow()).toEqual({
      status: "FAILED",
      error: "Site ID is taken",
    });
  });

  test("records the deploy service's report", async () => {
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
    expect((await buildRow()).status).toBe("PUBLISHED");
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
    expect((await buildRow()).status).toBe("PENDING");
  });

  const publishedUrl = async () =>
    (
      await db
        .select({ publishedUrl: project.publishedUrl })
        .from(project)
        .where(eq(project.id, "project-1"))
    )[0].publishedUrl;

  const unpublish = () =>
    createDeploymentClient({ db, builderOrigin: "http://x" }).unpublish({
      projectId: "project-1",
    });

  test("unpublish has the deploy service remove the site, then clears the link", async () => {
    await setup();
    await saveTarget();
    await db
      .update(project)
      .set({ publishedUrl: "https://p1.example.com/" })
      .where(eq(project.id, "project-1"));
    const seen = answerJobs(() => ({ status: "succeeded" }));
    expect(await unpublish()).toEqual({ success: true });
    expect(seen).toMatchObject([{ kind: "unpublish", projectId: "project-1" }]);
    expect(await publishedUrl()).toBeNull();
  });

  test("unpublish keeps the link when the site couldn't be removed", async () => {
    await setup();
    await saveTarget();
    await db
      .update(project)
      .set({ publishedUrl: "https://p1.example.com/" })
      .where(eq(project.id, "project-1"));
    answerJobs(() => ({ status: "failed", error: "no access" }));
    expect(await unpublish()).toEqual({ success: false, error: "no access" });
    expect(await publishedUrl()).toBe("https://p1.example.com/");
  });

  test("unpublish says so when nobody takes the job", async () => {
    await setup();
    await saveTarget();
    jobWaits.unpublishMs = 50;
    expect(await unpublish()).toEqual({
      success: false,
      error: expect.stringContaining("didn't pick up"),
    });
    expect(
      await db
        .select()
        .from(deployJob)
        .where(
          and(eq(deployJob.kind, "unpublish"), eq(deployJob.status, "canceled"))
        )
    ).toHaveLength(1);
  });
});
