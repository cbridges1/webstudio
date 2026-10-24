// selfhost: the deployer and projects' deploy targets.
//
// The deployer is the one deploy service (apps/deploy, or anything speaking
// @webstudio-is/deploy-protocol's REST API) every project publishes through. It comes from
// the builder's environment (DEPLOYER_URL, DEPLOYER_API_KEY, DEPLOYER_BUILDER_URL) or, when
// that isn't set, from what an app admin (a user with Better Auth's "admin" role) saves in
// the dashboard. Each project picks a target there (a host, its settings and its
// credentials). Credentials are stored encrypted with DEPLOY_CREDENTIALS_KEY
// (@webstudio-is/deploy-protocol/credentials) and never sent: the deployer reads them from
// this database. Publish sends the build with a token scoped to the project
// (publish-token.server.ts); the deployer reports the result back to
// /rest/deployments/<buildId>.
import {
  createDeployServiceClient,
  deployCredentials,
  deployReport,
  deployTarget,
  type DeployResult,
  type DeployTarget,
} from "@webstudio-is/deploy-protocol";
import {
  build,
  deployer,
  eq,
  maybeOne,
  project,
  projectDeployTarget,
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
  "No deployer is set up. An admin sets it in the dashboard: profile menu → Deployer.";

type Deployer = {
  /** "env": from the builder's environment, which the app can't change. */
  source: "env" | "app";
  url: string;
  apiKey: string;
  /** The builder's address as the deployer reaches it. Null: the builder's own origin. */
  builderUrl: string | null;
};

/** The environment's deployer, else the one saved in the app, else undefined. */
const loadDeployer = async (db: Db): Promise<Deployer | undefined> => {
  if (env.DEPLOYER_URL !== undefined) {
    return {
      source: "env",
      url: env.DEPLOYER_URL,
      apiKey: env.DEPLOYER_API_KEY ?? "",
      builderUrl: env.DEPLOYER_BUILDER_URL ?? null,
    };
  }
  const row = maybeOne(await db.select().from(deployer));
  return row === null
    ? undefined
    : {
        source: "app",
        url: row.url,
        apiKey: row.apiKey,
        builderUrl: row.builderUrl,
      };
};

const requireDeployer = async (db: Db) => {
  const found = await loadDeployer(db);
  if (found === undefined) {
    throw new Error(NO_DEPLOYER);
  }
  return found;
};

const clientFor = (found: Deployer) =>
  createDeployServiceClient({ url: found.url, apiKey: found.apiKey });

export const deployerInput = z.object({
  url: z.string().trim().url(),
  /** Empty or missing keeps the saved key. */
  apiKey: z.string().trim().optional(),
  /** The builder's address as the deployer reaches it. Empty: the builder's own origin. */
  builderUrl: z.union([z.string().trim().url(), z.literal("")]).optional(),
});

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
    throw new AuthorizationError("Only admins can set up the deployer");
  }
};

// App admins: the deployer.

/** What the browser may see: never the API key, only its last characters. */
export const loadDeployerSettings = async (context: AppContext) => {
  await assertAppAdmin(context);
  const found = await loadDeployer(context.db);
  if (found === undefined) {
    return { source: "none" as const };
  }
  return {
    source: found.source,
    url: found.url,
    builderUrl: found.builderUrl,
    apiKeyEnding: found.apiKey.slice(-4),
  };
};

export type DeployerSettings = Awaited<ReturnType<typeof loadDeployerSettings>>;

const assertNotFromEnv = () => {
  if (env.DEPLOYER_URL !== undefined) {
    throw new Error(
      "The deployer is set by the builder's environment (DEPLOYER_URL), so it can't be changed here"
    );
  }
};

export const saveDeployer = async (
  input: z.infer<typeof deployerInput>,
  context: AppContext
) => {
  await assertAppAdmin(context);
  assertNotFromEnv();
  const current = maybeOne(await context.db.select().from(deployer));
  const apiKey = input.apiKey || current?.apiKey;
  if (apiKey === undefined) {
    throw new Error("Enter the deployer's API key");
  }
  const values = {
    url: input.url,
    apiKey,
    builderUrl: input.builderUrl || null,
  };
  if (current === null) {
    await context.db.insert(deployer).values(values);
  } else {
    await context.db
      .update(deployer)
      .set(values)
      .where(eq(deployer.id, current.id));
  }
  return await loadDeployerSettings(context);
};

/** Projects keep their targets for when a deployer is set up again. */
export const removeDeployer = async (context: AppContext) => {
  await assertAppAdmin(context);
  assertNotFromEnv();
  await context.db.delete(deployer);
};

/** Calls the deployer: its hosts when it answers, its error when it doesn't. */
export const checkDeployer = async (context: AppContext) => {
  await assertAppAdmin(context);
  return await clientFor(await requireDeployer(context.db)).hosts();
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
    hasDeployer: (await loadDeployer(context.db)) !== undefined,
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

export const listDeployerHosts = async (
  { projectId }: { projectId: string },
  context: AppContext
) => {
  await assertProjectAdmin(projectId, context);
  return await clientFor(await requireDeployer(context.db)).hosts();
};

/**
 * Saves the target, then has the deployer check it (it reads the credentials from this
 * database, so they must be saved first) and puts the previous target back when the check
 * fails. `null` removes it.
 */
export const setProjectDeployTarget = async (
  {
    projectId,
    target,
  }: { projectId: string; target: z.infer<typeof projectTargetInput> | null },
  context: AppContext
): Promise<DeployResult> => {
  await assertProjectAdmin(projectId, context);
  if (target === null) {
    await context.db
      .delete(projectDeployTarget)
      .where(eq(projectDeployTarget.projectId, projectId));
    return { success: true };
  }
  const found = await requireDeployer(context.db);
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
  const checked = await clientFor(found).validate({
    projectId,
    target: { host: target.host, config: target.config },
  });
  if (checked.success === false) {
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
  }
  return checked;
};

// Publish.

const loadPublishTarget = async (projectId: string, db: Db) => {
  const found = await loadDeployer(db);
  if (found === undefined) {
    return { success: false as const, error: NO_DEPLOYER };
  }
  const row = maybeOne(
    await db
      .select()
      .from(projectDeployTarget)
      .where(eq(projectDeployTarget.projectId, projectId))
  );
  if (row === null) {
    return { success: false as const, error: NO_TARGET };
  }
  const target: DeployTarget = {
    host: row.host,
    config: (row.config ?? {}) as Record<string, unknown>,
  };
  return { success: true as const, deployer: found, target };
};

/**
 * The deployment client for a request. `builderOrigin` is where deployers reach the
 * builder unless the deployer has its own builder address.
 */
export const createDeploymentClient = ({
  db,
  builderOrigin,
}: {
  db: Db;
  builderOrigin: string;
}): DeploymentClient => ({
  async publish({ projectId, buildId, label }) {
    const resolved = await loadPublishTarget(projectId, db);
    const result: DeployResult = resolved.success
      ? await clientFor(resolved.deployer).publish({
          projectId,
          buildId,
          builder: {
            origin: resolved.deployer.builderUrl ?? builderOrigin,
            token: createPublishToken({ projectId, buildId }),
          },
          target: resolved.target,
          label,
        })
      : resolved;
    if (result.success === false) {
      // The build was created as PENDING before this call; nothing will report on it.
      await db
        .update(build)
        .set({
          publishStatus: "FAILED",
          publishError: result.error,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(build.id, buildId));
    }
    return result;
  },

  async unpublish({ projectId }) {
    const resolved = await loadPublishTarget(projectId, db);
    const result: DeployResult = resolved.success
      ? await clientFor(resolved.deployer).unpublish({
          projectId,
          target: resolved.target,
        })
      : // Without a target nothing was deployed; without a deployer it can't be removed.
        resolved.error === NO_TARGET
        ? { success: true }
        : resolved;
    if (result.success) {
      await db
        .update(project)
        .set({ publishedUrl: null })
        .where(eq(project.id, projectId));
    }
    return result;
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
