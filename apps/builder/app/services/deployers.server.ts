// selfhost: deployers and deploy targets.
//
// A deployer is a deploy service (apps/deploy, or anything speaking
// @webstudio-is/deploy-protocol) that a workspace's admins add with its URL and API key.
// Each project picks one of its workspace's deployers and a target there (a host, its
// settings and its credentials). Credentials are stored encrypted with
// DEPLOY_CREDENTIALS_KEY (@webstudio-is/deploy-protocol/credentials) and never sent: the
// deployer reads them from this database. Publish sends the build to that deployer with a
// token scoped to the project (publish-token.server.ts); the deployer reports the result back
// to /rest/deployments/<buildId>.
import {
  createDeployServiceClient,
  deployCredentials,
  deployReport,
  deployTarget,
  type DeployResult,
  type DeployTarget,
} from "@webstudio-is/deploy-protocol";
import {
  and,
  build,
  deployer,
  eq,
  isNull,
  maybeOne,
  project,
  projectDeployTarget,
  workspace,
  workspaceMember,
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

type DeployerRow = typeof deployer.$inferSelect;

export const deployerInput = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().url(),
  /** The builder's address as the deployer reaches it. Empty: the builder's own origin. */
  builderUrl: z.union([z.string().trim().url(), z.literal("")]).optional(),
});

/** What the browser may see: never the API key, only its last characters. */
const toPublicDeployer = (row: DeployerRow) => ({
  id: row.id,
  workspaceId: row.workspaceId,
  name: row.name,
  url: row.url,
  builderUrl: row.builderUrl,
  apiKeyEnding: row.apiKey.slice(-4),
  createdAt: row.createdAt,
});

export type PublicDeployer = ReturnType<typeof toPublicDeployer>;

const clientFor = (row: DeployerRow) =>
  createDeployServiceClient({ url: row.url, apiKey: row.apiKey });

const assertUser = (context: AppContext) => {
  if (context.authorization.type !== "user") {
    throw new AuthorizationError("Only signed-in users can manage deployers");
  }
  return context.authorization.userId;
};

/** Owners and administrators of the workspace. */
const isWorkspaceAdmin = async (
  db: Db,
  workspaceId: string,
  userId: string
) => {
  const owned = maybeOne(
    await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(
        and(
          eq(workspace.id, workspaceId),
          eq(workspace.userId, userId),
          eq(workspace.isDeleted, false)
        )
      )
  );
  if (owned !== null) {
    return true;
  }
  const member = maybeOne(
    await db
      .select({ relation: workspaceMember.relation })
      .from(workspaceMember)
      .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
      .where(
        and(
          eq(workspaceMember.workspaceId, workspaceId),
          eq(workspaceMember.userId, userId),
          isNull(workspaceMember.removedAt),
          eq(workspace.isDeleted, false)
        )
      )
  );
  return member?.relation === "administrators";
};

const assertWorkspaceAdmin = async (
  workspaceId: string,
  context: AppContext
) => {
  const userId = assertUser(context);
  if ((await isWorkspaceAdmin(context.db, workspaceId, userId)) === false) {
    throw new AuthorizationError(
      "Only the workspace's owner and admins can manage its deployers"
    );
  }
};

const loadDeployer = async (deployerId: string, db: Db) => {
  const row = maybeOne(
    await db.select().from(deployer).where(eq(deployer.id, deployerId))
  );
  if (row === null) {
    throw new Error("Deployer not found");
  }
  return row;
};

/** A project's workspace; projects from before workspaces use the owner's default one. */
const loadProjectWorkspaceId = async (projectId: string, db: Db) => {
  const row = maybeOne(
    await db
      .select({ workspaceId: project.workspaceId, userId: project.userId })
      .from(project)
      .where(eq(project.id, projectId))
  );
  if (row === null) {
    throw new Error("Project not found");
  }
  if (row.workspaceId !== null || row.userId === null) {
    return row.workspaceId;
  }
  const fallback = maybeOne(
    await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(
        and(
          eq(workspace.userId, row.userId),
          eq(workspace.isDefault, true),
          eq(workspace.isDeleted, false)
        )
      )
  );
  return fallback?.id ?? null;
};

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

/** The deployer, if it belongs to the project's workspace. */
const loadProjectDeployer = async (
  projectId: string,
  deployerId: string,
  db: Db
) => {
  const row = await loadDeployer(deployerId, db);
  if (row.workspaceId !== (await loadProjectWorkspaceId(projectId, db))) {
    throw new Error("That deployer belongs to another workspace");
  }
  return row;
};

// Workspace admins: the deployers a workspace's projects can use.

export const listDeployers = async (
  { workspaceId }: { workspaceId: string },
  context: AppContext
) => {
  await assertWorkspaceAdmin(workspaceId, context);
  const rows = await context.db
    .select()
    .from(deployer)
    .where(eq(deployer.workspaceId, workspaceId))
    .orderBy(deployer.createdAt);
  return rows.map(toPublicDeployer);
};

export const createDeployer = async (
  input: z.infer<typeof deployerInput> & {
    workspaceId: string;
    apiKey: string;
  },
  context: AppContext
) => {
  await assertWorkspaceAdmin(input.workspaceId, context);
  const [row] = await context.db
    .insert(deployer)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      url: input.url,
      apiKey: input.apiKey,
      builderUrl: input.builderUrl || null,
    })
    .returning();
  return toPublicDeployer(row);
};

export const updateDeployer = async (
  input: z.infer<typeof deployerInput> & {
    deployerId: string;
    /** Empty or missing keeps the current key. */
    apiKey?: string;
  },
  context: AppContext
) => {
  const current = await loadDeployer(input.deployerId, context.db);
  await assertWorkspaceAdmin(current.workspaceId, context);
  const [row] = await context.db
    .update(deployer)
    .set({
      name: input.name,
      url: input.url,
      builderUrl: input.builderUrl || null,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    })
    .where(eq(deployer.id, input.deployerId))
    .returning();
  return toPublicDeployer(row);
};

/** Also removes the deploy targets that use it. */
export const removeDeployer = async (
  { deployerId }: { deployerId: string },
  context: AppContext
) => {
  const current = await loadDeployer(deployerId, context.db);
  await assertWorkspaceAdmin(current.workspaceId, context);
  await context.db.delete(deployer).where(eq(deployer.id, deployerId));
};

/** Calls the deployer: its hosts when it answers, its error when it doesn't. */
export const checkDeployer = async (
  { deployerId }: { deployerId: string },
  context: AppContext
) => {
  const row = await loadDeployer(deployerId, context.db);
  await assertWorkspaceAdmin(row.workspaceId, context);
  return await clientFor(row).hosts();
};

// Project admins: where a project deploys.

export const projectTargetInput = deployTarget.extend({
  deployerId: z.string(),
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
  const workspaceId = await loadProjectWorkspaceId(projectId, context.db);
  const deployers =
    workspaceId === null
      ? []
      : await context.db
          .select({ id: deployer.id, name: deployer.name })
          .from(deployer)
          .where(eq(deployer.workspaceId, workspaceId))
          .orderBy(deployer.createdAt);
  const target = maybeOne(
    await context.db
      .select({
        deployerId: projectDeployTarget.deployerId,
        host: projectDeployTarget.host,
        config: projectDeployTarget.config,
        credentials: projectDeployTarget.credentials,
      })
      .from(projectDeployTarget)
      .where(eq(projectDeployTarget.projectId, projectId))
  );
  const userId =
    context.authorization.type === "user"
      ? context.authorization.userId
      : undefined;
  return {
    workspaceId,
    canManageDeployers:
      workspaceId !== null &&
      userId !== undefined &&
      (await isWorkspaceAdmin(context.db, workspaceId, userId)),
    deployers,
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
  { projectId, deployerId }: { projectId: string; deployerId: string },
  context: AppContext
) => {
  await assertProjectAdmin(projectId, context);
  const row = await loadProjectDeployer(projectId, deployerId, context.db);
  return await clientFor(row).hosts();
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
  const row = await loadProjectDeployer(
    projectId,
    target.deployerId,
    context.db
  );
  const previous = maybeOne(
    await context.db
      .select()
      .from(projectDeployTarget)
      .where(eq(projectDeployTarget.projectId, projectId))
  );
  const values = {
    deployerId: target.deployerId,
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
  const checked = await clientFor(row).validate({
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
  const row = maybeOne(
    await db
      .select({ target: projectDeployTarget, deployer })
      .from(projectDeployTarget)
      .innerJoin(deployer, eq(deployer.id, projectDeployTarget.deployerId))
      .where(eq(projectDeployTarget.projectId, projectId))
  );
  if (row === null) {
    return { success: false as const, error: NO_TARGET };
  }
  // The project may have moved to another workspace since its target was chosen.
  if (
    row.deployer.workspaceId !== (await loadProjectWorkspaceId(projectId, db))
  ) {
    return {
      success: false as const,
      error:
        "This project's deployer belongs to another workspace. Choose a new one in Project settings → Deploy.",
    };
  }
  const target: DeployTarget = {
    host: row.target.host,
    config: (row.target.config ?? {}) as Record<string, unknown>,
  };
  return { success: true as const, deployer: row.deployer, target };
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
      : { success: true };
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
