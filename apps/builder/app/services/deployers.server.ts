// selfhost: the deploy service and projects' deploy targets.
//
// The builder and the deploy service (apps/deploy) share this database. Publish, unpublish
// and target checks are queued as DeployJob rows with a NOTIFY on DEPLOY_JOBS_CHANNEL; the
// deploy service LISTENs (and polls), runs them and records the outcome, and registers itself
// and its hosts in DeployWorker. Optionally the builder also POSTs to a wake URL whenever it
// queues a job, to start a deploy service that is stopped while idle.
//
// The wake URL, its token and the builder's address as the deploy service reaches it come
// from the builder's environment (DEPLOYER_WAKE_URL, DEPLOYER_WAKE_TOKEN,
// DEPLOYER_BUILDER_URL) or, when none is set, from what an app admin (a user with Better
// Auth's "admin" role) saves in the dashboard. Each project sets its target (a host, its
// settings and its credentials) in its settings. Credentials are stored encrypted with
// DEPLOY_CREDENTIALS_KEY (@webstudio-is/deploy-protocol/credentials); the deploy service reads
// and decrypts them itself. A publish job carries a token scoped to the project
// (publish-token.server.ts) for downloading the build; the deploy service reports the result
// to /rest/deployments/<buildId>.
import {
  DEPLOY_JOBS_CHANNEL,
  deployCredentials,
  deployReport,
  deployTarget,
  hostInfo,
  type DeployResult,
  type HostInfo,
  type PublishJobRequest,
} from "@webstudio-is/deploy-protocol";
import {
  and,
  build,
  deployJob,
  deploySettings,
  deployWorker,
  desc,
  eq,
  inArray,
  maybeOne,
  ne,
  project,
  projectDeployTarget,
  sql,
  user,
  type Db,
  type Json,
} from "@webstudio-is/db";
import {
  AuthorizationError,
  authorizeProject,
  type AppContext,
  type DeploymentClient,
} from "@webstudio-is/trpc-interface/index.server";
import { z } from "zod";
import { createPublishToken, verifyPublishToken } from "./publish-token.server";
import { startStaticExport } from "./static-export.server";
import {
  credentialsKey,
  decryptCredentials,
  describeCredentials,
  encryptCredentials,
} from "@webstudio-is/deploy-protocol/credentials";
import env from "~/env/env.server";

const NO_TARGET =
  "This project has no deploy target. Choose one in Project settings → Deploy.";
const NO_DEPLOYER =
  "No deploy service has connected to this builder's database yet. Start one (apps/deploy) with this database's DATABASE_URL.";

/** How long the builder waits for the deploy service to finish a job it waits on. */
export const jobWaits = {
  validateMs: 10_000,
  unpublishMs: 60_000,
  pollMs: 250,
};

/** A deploy service seen this recently is running (it marks itself every poll, ≤ 1 min). */
const RUNNING_WITHIN_MS = 3 * 60_000;

type Settings = {
  /** "env": from the builder's environment, which the app can't change. */
  source: "env" | "app";
  wakeUrl: string | null;
  wakeToken: string | null;
  /** The builder's address as the deploy service reaches it. Null: the builder's own origin. */
  builderUrl: string | null;
};

const settingsFromEnv = () =>
  env.DEPLOYER_WAKE_URL !== undefined ||
  env.DEPLOYER_WAKE_TOKEN !== undefined ||
  env.DEPLOYER_BUILDER_URL !== undefined;

/** The environment's settings, else the ones saved in the app (all empty when none are). */
const loadSettings = async (db: Db): Promise<Settings> => {
  if (settingsFromEnv()) {
    return {
      source: "env",
      wakeUrl: env.DEPLOYER_WAKE_URL ?? null,
      wakeToken: env.DEPLOYER_WAKE_TOKEN ?? null,
      builderUrl: env.DEPLOYER_BUILDER_URL ?? null,
    };
  }
  const row = maybeOne(await db.select().from(deploySettings));
  return {
    source: "app",
    wakeUrl: row?.wakeUrl ?? null,
    wakeToken: row?.wakeToken ?? null,
    builderUrl: row?.builderUrl ?? null,
  };
};

/** The job queue this builder's deploy services take from. */
const jobQueue = () => env.DEPLOYER_QUEUE ?? "default";

/** This queue's deploy services that have registered, most recently seen first. */
const loadWorkers = async (db: Db) => {
  const rows = await db
    .select()
    .from(deployWorker)
    .where(eq(deployWorker.queue, jobQueue()))
    .orderBy(desc(deployWorker.seenAt));
  return rows.map((row) => ({
    id: row.id,
    seenAt: row.seenAt,
    running: Date.now() - new Date(row.seenAt).getTime() < RUNNING_WITHIN_MS,
    hosts: z.array(hostInfo).catch([]).parse(row.hosts),
  }));
};

/** POSTs to the wake URL; never throws. */
const wake = async (
  settings: Settings,
  body: Record<string, unknown>
): Promise<{ ok: boolean; status?: number; error?: string } | undefined> => {
  if (settings.wakeUrl === null) {
    return;
  }
  try {
    const response = await fetch(settings.wakeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(settings.wakeToken
          ? { Authorization: `Bearer ${settings.wakeToken}` }
          : {}),
      },
      body: JSON.stringify(body),
      // A stopped service may take a while to answer; the request has started it by then.
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (response.ok === false) {
      console.warn(`Deploy wake URL answered ${response.status}`);
    }
    return { ok: response.ok, status: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Deploy wake URL failed: ${message}`);
    return { ok: false, error: message };
  }
};

type JobKind = (typeof deployJob.kind.enumValues)[number];

/**
 * Queues a job, notifies the deploy service in the same transaction (the notification is sent
 * on commit) and calls the wake URL. Also drops old finished jobs.
 */
const queueJob = async (
  db: Db,
  job: {
    kind: JobKind;
    projectId: string;
    buildId?: string;
    request?: Json;
  }
) => {
  const id = await db.transaction(async (tx) => {
    await tx
      .delete(deployJob)
      .where(
        and(
          inArray(deployJob.status, ["succeeded", "failed", "canceled"]),
          sql`${deployJob.createdAt} < now() - interval '7 days'`
        )
      );
    const [row] = await tx
      .insert(deployJob)
      .values({
        queue: jobQueue(),
        kind: job.kind,
        projectId: job.projectId,
        buildId: job.buildId ?? null,
        request: job.request ?? {},
      })
      .returning({ id: deployJob.id });
    await tx.execute(sql`SELECT pg_notify(${DEPLOY_JOBS_CHANNEL}, ${row.id})`);
    return row.id;
  });
  await wake(await loadSettings(db), {
    jobId: id,
    kind: job.kind,
    projectId: job.projectId,
  });
  return id;
};

/**
 * Waits for a job to finish. When it doesn't in time, a job nobody took is canceled (and
 * reported as "queued"); one that's running keeps running.
 */
const waitForJob = async (db: Db, id: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const row = maybeOne(
      await db
        .select({ status: deployJob.status, error: deployJob.error })
        .from(deployJob)
        .where(eq(deployJob.id, id))
    );
    if (row === null) {
      return { status: "canceled" as const };
    }
    if (row.status === "succeeded" || row.status === "failed") {
      return { status: row.status, error: row.error ?? "Failed" };
    }
    if (Date.now() >= deadline) {
      const canceled = await db
        .update(deployJob)
        .set({ status: "canceled", finishedAt: sql`now()` })
        .where(and(eq(deployJob.id, id), eq(deployJob.status, "queued")))
        .returning({ id: deployJob.id });
      return { status: canceled.length > 0 ? ("queued" as const) : row.status };
    }
    await new Promise((done) => setTimeout(done, jobWaits.pollMs));
  }
};

/** Users with Better Auth's admin role (roles are comma-separated). */
export const isAppAdmin = async (db: Db, userId: string) => {
  const row = maybeOne(
    await db.select({ role: user.role }).from(user).where(eq(user.id, userId))
  );
  return (row?.role ?? "").split(",").some((role) => role.trim() === "admin");
};

const assertAppAdmin = async (context: AppContext) => {
  if (
    context.authorization.type !== "user" ||
    (await isAppAdmin(context.db, context.authorization.userId)) === false
  ) {
    throw new AuthorizationError("Only admins can set up the deploy service");
  }
};

// App admins: how the builder reaches the deploy service.

export const deployerInput = z.object({
  /** Empty: no wake URL. */
  wakeUrl: z.union([z.string().trim().url(), z.literal("")]).optional(),
  /** Empty or missing keeps the saved token. */
  wakeToken: z.string().trim().optional(),
  removeWakeToken: z.boolean().optional(),
  /** Empty: the builder's own origin. */
  builderUrl: z.union([z.string().trim().url(), z.literal("")]).optional(),
});

/** What the browser may see: never the wake token, only its last characters. */
export const loadDeployerSettings = async (context: AppContext) => {
  await assertAppAdmin(context);
  const settings = await loadSettings(context.db);
  return {
    source: settings.source,
    wakeUrl: settings.wakeUrl,
    wakeTokenEnding: settings.wakeToken?.slice(-4) ?? null,
    builderUrl: settings.builderUrl,
    workers: (await loadWorkers(context.db)).map((worker) => ({
      id: worker.id,
      seenAt: worker.seenAt,
      running: worker.running,
      hosts: worker.hosts.map((host) => host.label),
    })),
  };
};

export type DeployerSettings = Awaited<ReturnType<typeof loadDeployerSettings>>;

export const saveDeployer = async (
  input: z.infer<typeof deployerInput>,
  context: AppContext
) => {
  await assertAppAdmin(context);
  if (settingsFromEnv()) {
    throw new Error(
      "The deploy service settings come from the builder's environment (DEPLOYER_WAKE_URL, DEPLOYER_WAKE_TOKEN, DEPLOYER_BUILDER_URL), so they can't be changed here"
    );
  }
  const current = maybeOne(await context.db.select().from(deploySettings));
  const values = {
    wakeUrl: input.wakeUrl || null,
    wakeToken: input.removeWakeToken
      ? null
      : input.wakeToken || (current?.wakeToken ?? null),
    builderUrl: input.builderUrl || null,
    updatedAt: new Date().toISOString(),
  };
  if (current === null) {
    await context.db.insert(deploySettings).values(values);
  } else {
    await context.db
      .update(deploySettings)
      .set(values)
      .where(eq(deploySettings.id, current.id));
  }
  return await loadDeployerSettings(context);
};

/** Calls the wake URL as a test; the deploy service's status is in the settings. */
export const checkDeployer = async (context: AppContext) => {
  await assertAppAdmin(context);
  return {
    wake: (await wake(await loadSettings(context.db), { test: true })) ?? null,
  };
};

// Project admins: where a project deploys.

const assertProjectAdmin = async (projectId: string, context: AppContext) => {
  const allowed = await authorizeProject.hasProjectPermit(
    { projectId, permit: "admin" },
    context
  );
  if (allowed === false) {
    throw new AuthorizationError(
      "Only the project's owner and admins can change where it deploys"
    );
  }
};

export const projectTargetInput = deployTarget.extend({
  /** New credentials; null removes them, undefined keeps the saved ones. */
  credentials: deployCredentials.nullable().optional(),
});

/** What the settings show about saved credentials. Never the secret. */
const summarizeCredentials = (projectId: string, stored: string | null) => {
  if (stored === null) {
    return { status: "none" as const };
  }
  let credentials;
  try {
    credentials = decryptCredentials(
      projectId,
      stored,
      credentialsKey(env.DEPLOY_CREDENTIALS_KEY)
    );
  } catch {
    // No key: it can't be read either way.
  }
  return credentials === undefined
    ? { status: "unreadable" as const }
    : { status: "saved" as const, account: describeCredentials(credentials) };
};

export const loadProjectDeploySettings = async (
  { projectId }: { projectId: string },
  context: AppContext
) => {
  await assertProjectAdmin(projectId, context);
  const target = maybeOne(
    await context.db
      .select({
        host: projectDeployTarget.host,
        config: projectDeployTarget.config,
        credentials: projectDeployTarget.credentials,
      })
      .from(projectDeployTarget)
      .where(eq(projectDeployTarget.projectId, projectId))
  );
  return {
    hasDeployer: (await loadWorkers(context.db)).length > 0,
    canManageDeployer:
      context.authorization.type === "user" &&
      (await isAppAdmin(context.db, context.authorization.userId)),
    target:
      target === null
        ? null
        : {
            ...target,
            config: (target.config ?? {}) as Record<string, unknown>,
            credentials: summarizeCredentials(projectId, target.credentials),
          },
  };
};

/** The hosts the most recently seen deploy service registered (it needn't be running). */
export const listDeployerHosts = async (
  { projectId }: { projectId: string },
  context: AppContext
): Promise<{ success: true; data: { hosts: HostInfo[] } }> => {
  await assertProjectAdmin(projectId, context);
  const [latest] = await loadWorkers(context.db);
  if (latest === undefined) {
    throw new Error(NO_DEPLOYER);
  }
  return { success: true, data: { hosts: latest.hosts } };
};

export type SaveTargetResult =
  | { success: true; warning?: string }
  | { success: false; error: string };

/**
 * Saves the target, then has the deploy service check it (it reads the target and the
 * credentials from this database, so they must be saved first) and puts the previous target
 * back when the check fails. Kept unchecked, with a warning, when the deploy service doesn't
 * answer in time. `null` removes it.
 */
export const setProjectDeployTarget = async (
  {
    projectId,
    target,
  }: { projectId: string; target: z.infer<typeof projectTargetInput> | null },
  context: AppContext
): Promise<SaveTargetResult> => {
  await assertProjectAdmin(projectId, context);
  if (target === null) {
    await context.db
      .delete(projectDeployTarget)
      .where(eq(projectDeployTarget.projectId, projectId));
    return { success: true };
  }
  const previous = maybeOne(
    await context.db
      .select()
      .from(projectDeployTarget)
      .where(eq(projectDeployTarget.projectId, projectId))
  );
  const values = {
    host: target.host,
    config: target.config as Json,
    // Undefined keeps the saved credentials.
    credentials:
      target.credentials === undefined
        ? (previous?.credentials ?? null)
        : target.credentials === null
          ? null
          : encryptCredentials(
              projectId,
              target.credentials,
              credentialsKey(env.DEPLOY_CREDENTIALS_KEY)
            ),
    updatedAt: new Date().toISOString(),
  };
  await context.db
    .insert(projectDeployTarget)
    .values({ projectId, ...values })
    .onConflictDoUpdate({ target: projectDeployTarget.projectId, set: values });

  if ((await loadWorkers(context.db)).length === 0) {
    return {
      success: true,
      warning: `Saved without a check. ${NO_DEPLOYER}`,
    };
  }
  const jobId = await queueJob(context.db, { kind: "validate", projectId });
  const checked = await waitForJob(context.db, jobId, jobWaits.validateMs);
  if (checked.status === "succeeded") {
    return { success: true };
  }
  if (checked.status === "failed") {
    if (previous === null) {
      await context.db
        .delete(projectDeployTarget)
        .where(eq(projectDeployTarget.projectId, projectId));
    } else {
      await context.db
        .update(projectDeployTarget)
        .set(previous)
        .where(eq(projectDeployTarget.projectId, projectId));
    }
    return { success: false, error: checked.error };
  }
  return {
    success: true,
    warning:
      "Saved, but the deploy service didn't check it in time (is it running?). Problems will show when you publish.",
  };
};

// Publish.

const hasTarget = async (db: Db, projectId: string) =>
  maybeOne(
    await db
      .select({ projectId: projectDeployTarget.projectId })
      .from(projectDeployTarget)
      .where(eq(projectDeployTarget.projectId, projectId))
  ) !== null;

const failBuild = (db: Db, buildIds: string[], error: string) =>
  buildIds.length === 0
    ? Promise.resolve()
    : db
        .update(build)
        .set({
          publishStatus: "FAILED",
          publishError: error,
          updatedAt: new Date().toISOString(),
        })
        .where(inArray(build.id, buildIds));

/**
 * The deployment client for a request. `builderOrigin` is where the deploy service reaches
 * the builder unless the settings name another builder address.
 */
export const createDeploymentClient = ({
  db,
  builderOrigin,
}: {
  db: Db;
  builderOrigin: string;
}): DeploymentClient => ({
  async publish({ projectId, buildId, label }) {
    const problem =
      (await loadWorkers(db)).length === 0
        ? NO_DEPLOYER
        : (await hasTarget(db, projectId)) === false
          ? NO_TARGET
          : undefined;
    if (problem !== undefined) {
      // The build was created as PENDING before this call; nothing will report on it.
      await failBuild(db, [buildId], problem);
      return { success: false, error: problem };
    }
    // An older publish still waiting would only be overwritten by this one.
    const replaced = await db
      .update(deployJob)
      .set({ status: "canceled", finishedAt: sql`now()` })
      .where(
        and(
          eq(deployJob.projectId, projectId),
          eq(deployJob.kind, "publish"),
          eq(deployJob.status, "queued"),
          ne(deployJob.buildId, buildId)
        )
      )
      .returning({ buildId: deployJob.buildId });
    await failBuild(
      db,
      replaced.flatMap((row) => (row.buildId === null ? [] : [row.buildId])),
      "Replaced by a newer publish"
    );
    const settings = await loadSettings(db);
    const request: PublishJobRequest = {
      builderOrigin: settings.builderUrl ?? builderOrigin,
      token: createPublishToken({ projectId, buildId }),
      label,
    };
    await queueJob(db, { kind: "publish", projectId, buildId, request });
    return { success: true };
  },

  async unpublish({ projectId }) {
    // Without a target nothing was deployed.
    if ((await hasTarget(db, projectId)) === false) {
      await db
        .update(project)
        .set({ publishedUrl: null })
        .where(eq(project.id, projectId));
      return { success: true };
    }
    if ((await loadWorkers(db)).length === 0) {
      return { success: false, error: NO_DEPLOYER };
    }
    const jobId = await queueJob(db, { kind: "unpublish", projectId });
    const done = await waitForJob(db, jobId, jobWaits.unpublishMs);
    if (done.status === "succeeded") {
      await db
        .update(project)
        .set({ publishedUrl: null })
        .where(eq(project.id, projectId));
      return { success: true };
    }
    const error: DeployResult = {
      success: false,
      error:
        done.status === "failed"
          ? done.error
          : done.status === "running"
            ? "The deploy service is still removing the site. Try again in a minute."
            : "The deploy service didn't pick up the request (is it running?).",
    };
    return error;
  },

  async exportStatic({ projectId, buildId, templates }) {
    startStaticExport({ db, projectId, buildId, templates, builderOrigin });
    return { success: true };
  },
});

// Reports from deployers.

export class DeployReportError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Records a deployer's report on a publish, authorized by that publish's token. */
export const recordDeployReport = async (
  {
    buildId,
    token,
    body,
  }: { buildId: string; token: string | null; body: unknown },
  db: Db
) => {
  const payload = verifyPublishToken(token);
  if (payload === undefined || payload.buildId !== buildId) {
    throw new DeployReportError("Invalid or expired publish token", 401);
  }
  const report = deployReport.safeParse(body);
  if (report.success === false) {
    throw new DeployReportError(`Invalid report: ${report.error.message}`, 400);
  }
  const row = maybeOne(
    await db
      .select({ projectId: build.projectId })
      .from(build)
      .where(eq(build.id, buildId))
  );
  if (row === null || row.projectId !== payload.projectId) {
    throw new DeployReportError("Build not found", 404);
  }
  await db.transaction(async (tx) => {
    await tx
      .update(build)
      .set({
        publishStatus: report.data.status,
        publishError:
          report.data.status === "FAILED" ? report.data.error : null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(build.id, buildId));
    if (report.data.status === "PUBLISHED") {
      await tx
        .update(project)
        .set({ publishedUrl: report.data.url })
        .where(eq(project.id, payload.projectId));
    }
  });
};
