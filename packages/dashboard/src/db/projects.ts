import {
  AuthorizationError,
  type AppContext,
} from "@webstudio-is/trpc-interface/index.server";
import {
  and,
  dashboardProject,
  desc,
  domain,
  eq,
  inArray,
  isNull,
  loadLatestBuildVirtual,
  loadPreviewImageAssets,
  maybeOne,
  or,
  project,
  projectDomain,
  workspace,
  workspaceMember,
  type SQL,
} from "@webstudio-is/db";

type DomainVirtual = {
  domain: string;
  status: string;
  verified: boolean;
};

const fetchAndMapDomains = async <
  T extends {
    id: string;
    title: string;
    domain: string;
    createdAt: string;
    [key: string]: unknown;
  },
>(
  projects: T[],
  context: AppContext
) => {
  const projectIds = projects.map((project) => project.id);

  type ProjectWithDomains = T & {
    domainsVirtual: DomainVirtual[];
  };

  if (projectIds.length === 0) {
    return projects.map((project) => ({
      ...project,
      domainsVirtual: [],
    })) as ProjectWithDomains[];
  }

  // Query ProjectDomain and Domain tables
  const domainsData = await context.db
    .select({
      projectId: projectDomain.projectId,
      txtRecord: projectDomain.txtRecord,
      domain: domain.domain,
      status: domain.status,
      domainTxtRecord: domain.txtRecord,
    })
    .from(projectDomain)
    .innerJoin(domain, eq(domain.id, projectDomain.domainId))
    .where(inArray(projectDomain.projectId, projectIds))
    .catch((error) => {
      console.error("Error fetching domains:", error);
      // Continue without domains rather than failing
      return [];
    });

  // Map domains to projects
  const domainsByProject = new Map<string, DomainVirtual[]>();
  for (const row of domainsData) {
    if (!domainsByProject.has(row.projectId)) {
      domainsByProject.set(row.projectId, []);
    }
    domainsByProject.get(row.projectId)?.push({
      domain: row.domain,
      status: row.status,
      verified: row.domainTxtRecord === row.txtRecord,
    });
  }

  // Add domains to projects
  return projects.map((project) => ({
    ...project,
    domainsVirtual: project.id ? domainsByProject.get(project.id) || [] : [],
  })) as ProjectWithDomains[];
};

/**
 * DashboardProject rows with the relations upstream embedded through PostgREST:
 * the preview image asset and the latest production build.
 */
const loadDashboardProjects = async (
  where: SQL | undefined,
  context: AppContext
) => {
  const rows = await context.db
    .select()
    .from(dashboardProject)
    .where(where)
    .orderBy(desc(dashboardProject.createdAt), desc(dashboardProject.id));
  const [previewImageAssets, latestBuilds] = await Promise.all([
    loadPreviewImageAssets(context.db, rows),
    loadLatestBuildVirtual(
      context.db,
      rows.map((row) => row.id)
    ),
  ]);
  return rows.map(({ publishedUrl, ...row }) => ({
    ...row,
    // selfhost: optional so fixtures without it still typecheck
    ...(publishedUrl === null ? {} : { publishedUrl }),
    previewImageAsset: previewImageAssets.get(row.id) ?? null,
    latestBuildVirtual: latestBuilds.get(row.id) ?? null,
  }));
};

export type DashboardProject = Awaited<ReturnType<typeof findMany>>[number];

export const findMany = async ({
  userId,
  context,
  workspaceId,
  includeUnassigned,
}: {
  userId: string;
  context: AppContext;
  workspaceId?: string;
  includeUnassigned?: boolean;
}) => {
  if (context.authorization.type !== "user") {
    throw new AuthorizationError(
      "Only logged in users can view the project list"
    );
  }

  if (userId !== context.authorization.userId) {
    throw new AuthorizationError(
      "Only the project owner can view the project list"
    );
  }

  // When filtering by workspace, verify the caller is a member or owner
  // to prevent unauthorized access via direct tRPC calls.
  if (workspaceId !== undefined) {
    const workspaceRow = maybeOne(
      await context.db
        .select({ userId: workspace.userId })
        .from(workspace)
        .where(
          and(eq(workspace.id, workspaceId), eq(workspace.isDeleted, false))
        )
    );

    if (workspaceRow === null) {
      throw new AuthorizationError("Workspace not found");
    }

    const isOwner = workspaceRow.userId === userId;

    if (isOwner === false) {
      const membership = maybeOne(
        await context.db
          .select({ userId: workspaceMember.userId })
          .from(workspaceMember)
          .where(
            and(
              eq(workspaceMember.workspaceId, workspaceId),
              eq(workspaceMember.userId, userId),
              isNull(workspaceMember.removedAt)
            )
          )
      );

      if (membership === null) {
        throw new AuthorizationError("You don't have access to this workspace");
      }
    }
  }

  // When filtering by workspace, show all workspace projects
  // (members can see all projects in the workspace)
  let scope: SQL | undefined;
  if (workspaceId !== undefined) {
    scope = includeUnassigned
      ? // For the default workspace, also include pre-workspace projects that
        // have NULL workspaceId — these belong to the user but haven't been
        // assigned to a workspace yet.
        or(
          eq(dashboardProject.workspaceId, workspaceId),
          and(
            isNull(dashboardProject.workspaceId),
            eq(dashboardProject.userId, userId)
          )
        )
      : eq(dashboardProject.workspaceId, workspaceId);
  } else {
    scope = eq(dashboardProject.userId, userId);
  }

  const projects = await loadDashboardProjects(
    and(scope, eq(dashboardProject.isDeleted, false)),
    context
  );

  return await fetchAndMapDomains(projects, context);
};

export const countByUserId = async ({
  userId,
  context,
}: {
  userId: string;
  context: AppContext;
}) => {
  if (context.authorization.type !== "user") {
    throw new AuthorizationError(
      "Only logged in users can view the project count"
    );
  }
  if (userId !== context.authorization.userId) {
    throw new AuthorizationError(
      "Only the project owner can view the project count"
    );
  }
  return await context.db.$count(
    project,
    and(eq(project.userId, userId), eq(project.isDeleted, false))
  );
};

export const findManyByIds = async (
  projectIds: string[],
  context: AppContext
) => {
  if (projectIds.length === 0) {
    return [];
  }

  const userId =
    context.authorization.type === "user"
      ? context.authorization.userId
      : undefined;

  const isApproved = eq(dashboardProject.marketplaceApprovalStatus, "APPROVED");
  const projects = await loadDashboardProjects(
    and(
      inArray(dashboardProject.id, projectIds),
      eq(dashboardProject.isDeleted, false),
      userId === undefined
        ? isApproved
        : or(eq(dashboardProject.userId, userId), isApproved)
    ),
    context
  );

  return await fetchAndMapDomains(projects, context);
};
