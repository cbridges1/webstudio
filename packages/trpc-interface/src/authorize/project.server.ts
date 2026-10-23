import {
  and,
  authorizationToken,
  eq,
  inArray,
  maybeOne,
  project,
  workspaceProjectAuthorization,
  type Db,
} from "@webstudio-is/db";
import type { AppContext } from "../context/context.server";
import type { AuthPermit, ProjectPermit } from "./project-permits";
import type { Role } from "./role";
import memoize from "memoize";
import { getProjectPlanFeatures } from "../context/project-plan.server";

type Relation = Role;

type CheckInput = {
  namespace: "Project";
  id: string;

  permit: AuthPermit;

  subjectSet: {
    namespace: "User" | "Token";
    id: string;
  };
};

const permitToRelationRewrite: Record<ProjectPermit, Relation[]> = {
  view: ["viewers", "editors", "builders", "administrators"],
  edit: ["editors", "builders", "administrators"],
  build: ["builders", "administrators"],
  admin: ["administrators"],
};

/**
 * Pure function: checks whether a set of workspace relations grants a given
 * permit. Used by the auth layer to evaluate workspace-based access.
 */
const isRolePermitted = (relations: string[], permit: AuthPermit): boolean => {
  // Workspace owner gets all permits
  if (relations.includes("own")) {
    return true;
  }
  // Only workspace owner gets "own" permit
  if (permit === "own") {
    return false;
  }
  const permitted = permitToRelationRewrite[permit] ?? [];
  return relations.some((r) => permitted.includes(r as Relation));
};

const check = async (db: Db, input: CheckInput) => {
  const { subjectSet } = input;

  if (subjectSet.namespace === "User") {
    // Check if the user is the direct owner of the project
    const row = maybeOne(
      await db
        .select({ id: project.id })
        .from(project)
        .where(and(eq(project.id, input.id), eq(project.userId, subjectSet.id)))
    );

    if (row !== null) {
      return { allowed: true };
    }

    // Workspace-based authorization
    const wpaRows = await db
      .select({ relation: workspaceProjectAuthorization.relation })
      .from(workspaceProjectAuthorization)
      .where(
        and(
          eq(workspaceProjectAuthorization.userId, subjectSet.id),
          eq(workspaceProjectAuthorization.projectId, input.id)
        )
      );

    if (wpaRows.length > 0) {
      const relations = wpaRows.map((r) => r.relation);
      return { allowed: isRolePermitted(relations, input.permit) };
    }

    return { allowed: false };
  }

  if (input.permit === "own") {
    return { allowed: false };
  }

  if (subjectSet.namespace !== "Token") {
    return { allowed: false };
  }

  const row = maybeOne(
    await db
      .select({ token: authorizationToken.token })
      .from(authorizationToken)
      .where(
        and(
          eq(authorizationToken.token, subjectSet.id),
          eq(authorizationToken.projectId, input.id),
          inArray(authorizationToken.relation, [
            ...permitToRelationRewrite[input.permit],
          ])
        )
      )
  );

  return { allowed: row !== null };
};

// doesn't work in cloudflare workers
const memoizedCheck = memoize(check, {
  // Short TTL so plan downgrades propagate quickly. No cache invalidation
  // hook exists yet — keep this low until one is added.
  maxAge: 10 * 1000,
  cacheKey: ([_context, input]) => JSON.stringify(input),
});

type AuthInfo =
  | {
      type: "user";
      userId: string;
    }
  | {
      type: "token";
      authToken: string;
    }
  | {
      type: "service";
      /** selfhost: a deployer's publish token, scoped to one project. */
      projectId?: string;
    };

export const checkProjectPermit = async ({
  projectId,
  permit,
  authInfo,
  db,
}: {
  projectId: string;
  permit: AuthPermit;
  authInfo: AuthInfo;
  db: Db;
}) => {
  const checks = [];
  const namespace = "Project";

  if (authInfo.type === "service") {
    return (
      permit === "view" &&
      (authInfo.projectId === undefined || authInfo.projectId === projectId)
    );
  }

  if (authInfo.type === "token") {
    // Token doesn't have "own" permit, do not check it
    if (permit === "own") {
      return false;
    }

    checks.push(
      memoizedCheck(db, {
        namespace,
        id: projectId,
        subjectSet: {
          id: authInfo.authToken,
          namespace: "Token",
        },
        permit: permit,
      })
    );
  }

  // Check if the user is allowed to access the project
  if (authInfo.type === "user") {
    checks.push(
      memoizedCheck(db, {
        subjectSet: {
          namespace: "User",
          id: authInfo.userId,
        },
        namespace,
        id: projectId,
        permit: permit,
      })
    );
  }

  if (checks.length === 0) {
    return false;
  }

  const authResults = await Promise.allSettled(checks);

  for (const authResult of authResults) {
    if (authResult.status === "rejected") {
      throw new Error(`Authorization call failed ${authResult.reason}`);
    }
  }

  const allowed = authResults.some(
    (authResult) =>
      authResult.status === "fulfilled" && authResult.value.allowed
  );

  return allowed;
};

export const hasProjectPermit = async (
  props: {
    projectId: string;
    permit: AuthPermit;
  },
  context: AppContext
) => {
  const { authorization } = context;

  if (authorization.type === "anonymous") {
    return false;
  }

  const authInfo: AuthInfo = authorization;

  if (authInfo === undefined) {
    return false;
  }

  const allowed = await checkProjectPermit({
    projectId: props.projectId,
    permit: props.permit,
    authInfo,
    db: context.db,
  });

  if (allowed === false) {
    return false;
  }

  // Workspace downgrade check: when a workspace member accesses a project,
  // verify the project owner's plan still supports workspace features.
  // Direct project owners are not affected.
  if (authorization.type === "user") {
    // "own" permit is only granted to direct project owners.
    // They are unaffected by downgrade. This call is memoized.
    const isOwner = await checkProjectPermit({
      projectId: props.projectId,
      permit: "own",
      authInfo,
      db: context.db,
    });

    if (isOwner === false) {
      // User is a workspace member — verify the project owner's plan.
      const ownerPlan = await getProjectPlanFeatures(props.projectId, context);
      if (ownerPlan.maxWorkspaces <= 1) {
        return false;
      }
    }
  }

  return true;
};

/**
 * Returns the first allowed permit from the list or undefined if none is allowed
 * @todo think about caching to authorizeTrpc.check.query
 * batching check queries would help too https://github.com/ory/keto/issues/812
 */
export const getProjectPermit = async (
  props: {
    projectId: string;
    permits: readonly AuthPermit[];
  },
  context: AppContext
): Promise<AuthPermit | undefined> => {
  const permitToCheck = props.permits;

  const permits = await Promise.allSettled(
    permitToCheck.map((permit) =>
      hasProjectPermit({ projectId: props.projectId, permit }, context)
    )
  );

  for (const permit of permits) {
    if (permit.status === "rejected") {
      throw new Error(`Authorization call failed ${permit.reason}`);
    }

    if (permit.value === true) {
      return permitToCheck[permits.indexOf(permit)];
    }
  }
};

export const __testing__ = {
  isRolePermitted,
};
