import {
  authorizeProject,
  type AppContext,
  AuthorizationError,
  createErrorResponse,
  getPlanFeaturesByOwnerId,
} from "@webstudio-is/trpc-interface/index.server";
import { createId } from "@webstudio-is/sdk";
import * as projectApi from "@webstudio-is/project/index.server";
import { unpublishBuild } from "@webstudio-is/project-build/server";
import { validateDomain } from "./validate";
import { cnameFromUserId } from "./cname-from-user-id";
import type { Project } from "@webstudio-is/project";
import {
  and,
  countDistinct,
  domain as domainTable,
  eq,
  one,
  project as projectTable,
  projectDomain,
  type Database,
} from "@webstudio-is/db";

type Result = { success: false; error: string } | { success: true };

/**
 * Creates 2 entries in the database:
 * at the "domain" table and at the "projectDomain" table
 */
export const create = async (
  props: {
    projectId: Project["id"];
    domain: string;
  },
  context: AppContext
): Promise<Result> => {
  // Only owner or admin of the project can create domains
  const canCreateDomain = await authorizeProject.hasProjectPermit(
    { projectId: props.projectId, permit: "admin" },
    context
  );

  if (canCreateDomain === false) {
    throw new AuthorizationError(
      "You don't have access to create this project domains"
    );
  }

  const project = await projectApi.loadById(props.projectId, context);

  const { userId: ownerId } = project;

  if (ownerId === null) {
    throw new AuthorizationError("Project must have project userId defined");
  }

  const ownerPlan = await getPlanFeaturesByOwnerId(ownerId, context);
  const totalDomainsCount = await countTotalDomains(ownerId, context);

  if (totalDomainsCount >= ownerPlan.maxDomainsAllowedPerUser) {
    return {
      success: false,
      error:
        "You have reached the maximum number of allowed domains. Please upgrade to the Pro plan or higher to add unlimited domains.",
    };
  }

  const validationResult = validateDomain(props.domain);

  if (validationResult.success === false) {
    return validationResult;
  }

  const { domain } = validationResult;

  try {
    // Create domain in domain table; keep an existing one as it is.
    await context.db
      .insert(domainTable)
      .values({ id: createId(), domain, status: "INITIALIZING" })
      .onConflictDoNothing({ target: domainTable.domain });

    const { id: domainId } = one(
      await context.db
        .select({ id: domainTable.id })
        .from(domainTable)
        .where(eq(domainTable.domain, domain)),
      "Domain"
    );
    const txtRecord = createId();

    await context.db.insert(projectDomain).values({
      domainId,
      projectId: props.projectId,
      txtRecord,
      cname: await cnameFromUserId(ownerId),
    });
  } catch (error) {
    return createErrorResponse(error);
  }

  return { success: true };
};

/**
 * Verify TXT record of the domain, update domain status, start 3rd party domain initialization process
 */
export const verify = async (
  props: {
    projectId: string;
    domainId: string;
  },
  context: AppContext
): Promise<Result> => {
  // Only owner or admin of the project can register domains
  const canRegisterDomain = await authorizeProject.hasProjectPermit(
    { projectId: props.projectId, permit: "admin" },
    context
  );

  if (canRegisterDomain === false) {
    throw new Error("You don't have access to create this project domains");
  }

  let projectDomainRow: { txtRecord: string; domain: string };
  try {
    projectDomainRow = one(
      await context.db
        .select({
          txtRecord: projectDomain.txtRecord,
          domain: domainTable.domain,
        })
        .from(projectDomain)
        .innerJoin(domainTable, eq(domainTable.id, projectDomain.domainId))
        .where(
          and(
            eq(projectDomain.domainId, props.domainId),
            eq(projectDomain.projectId, props.projectId)
          )
        ),
      "Domain"
    );
  } catch (error) {
    return createErrorResponse(error);
  }

  const { domain, txtRecord } = projectDomainRow;

  // @todo: TXT verification and domain initialization should be implemented in the future as queue service
  const createDomainResult = await context.domain.domainTrpc.create.mutate({
    domain,
    txtRecord,
  });

  if (createDomainResult.success === false) {
    return createDomainResult;
  }

  try {
    await context.db
      .update(domainTable)
      .set({ status: "PENDING", txtRecord })
      .where(eq(domainTable.id, props.domainId));
  } catch (error) {
    return createErrorResponse(error);
  }

  return { success: true };
};

/**
 * Removes projectDomain entry
 */
export const remove = async (
  props: {
    projectId: string;
    domainId: string;
  },
  context: AppContext
): Promise<Result> => {
  // Only owner or admin of the project can register domains
  const canDeleteDomain = await authorizeProject.hasProjectPermit(
    { projectId: props.projectId, permit: "admin" },
    context
  );

  if (canDeleteDomain === false) {
    throw new Error("You don't have access to delete this project domains");
  }

  const projectDomainFilter = and(
    eq(projectDomain.domainId, props.domainId),
    eq(projectDomain.projectId, props.projectId)
  );
  let domain: { id: string; domain: string };
  try {
    domain = one(
      await context.db
        .select({ id: domainTable.id, domain: domainTable.domain })
        .from(projectDomain)
        .innerJoin(domainTable, eq(domainTable.id, projectDomain.domainId))
        .where(projectDomainFilter),
      "Domain"
    );
  } catch (error) {
    return createErrorResponse(error);
  }

  // selfhost: a project's site lives at one host; a custom domain points at it from the
  // user's DNS, so removing the domain leaves the site deployed.
  await unpublishBuild(
    { projectId: props.projectId, domain: domain.domain },
    context
  ).catch((error) => {
    if (
      error instanceof Error &&
      error.message === `Domain ${domain.domain} is not published`
    ) {
      return;
    }
    throw error;
  });

  try {
    await context.db.delete(projectDomain).where(projectDomainFilter);

    const remainingDomains = await context.db.$count(
      projectDomain,
      eq(projectDomain.domainId, props.domainId)
    );

    if (remainingDomains === 0) {
      await context.db
        .update(domainTable)
        .set({
          status: "INITIALIZING",
          error: "Removed from project",
          txtRecord: null,
        })
        .where(eq(domainTable.id, props.domainId));
    }
  } catch (error) {
    return createErrorResponse(error);
  }

  return { success: true };
};

type Status = "active" | "pending" | "error";
type StatusEnum = Uppercase<Status>;

type Domain = Database["public"]["Tables"]["Domain"]["Row"];

type RefreshResult =
  | { success: false; error: string }
  | { success: true; domain: Domain };

const statusToStatusEnum = (status: Status): StatusEnum =>
  status.toUpperCase() as StatusEnum;

/**
 * Reads the status of the domain from the 3rd party provider
 * and updates the database accordingly
 *
 * @todo: In the future should be a read only status reader
 */
export const updateStatus = async (
  props: {
    projectId: Project["id"];
    domain: string;
  },
  context: AppContext
): Promise<RefreshResult> => {
  // Only owner or admin of the project can register domains
  const canRefreshDomain = await authorizeProject.hasProjectPermit(
    { projectId: props.projectId, permit: "admin" },
    context
  );

  if (canRefreshDomain === false) {
    throw new Error("You don't have access to refresh this project domains");
  }

  const validationResult = validateDomain(props.domain);

  if (validationResult.success === false) {
    return validationResult;
  }

  const { domain } = validationResult;

  // @todo: must be implemented as workflow/queue service part of 3rd party domain initialization process
  const statusResult = await context.domain.domainTrpc.getStatus.query({
    domain,
  });

  if (statusResult.success === false) {
    return statusResult;
  }

  const { data } = statusResult;

  // update domain status
  try {
    const updatedDomain = one(
      await context.db
        .update(domainTable)
        .set({
          status: statusToStatusEnum(data.status),
          error: data.status === "error" ? data.error : null,
        })
        .where(eq(domainTable.domain, domain))
        .returning(),
      "Domain"
    );
    return { success: true, domain: updatedDomain };
  } catch (error) {
    return createErrorResponse(error);
  }
};

export const countTotalDomains = async (
  userId: string,
  context: AppContext
): Promise<number> => {
  // Domains linked to at least one of the user's live projects.
  const [{ count }] = await context.db
    .select({ count: countDistinct(projectDomain.domainId) })
    .from(projectDomain)
    .innerJoin(projectTable, eq(projectTable.id, projectDomain.projectId))
    .where(
      and(eq(projectTable.userId, userId), eq(projectTable.isDeleted, false))
    );

  return count;
};
