import { createId } from "@webstudio-is/sdk";
import {
  authorizeProject,
  type AppContext,
  AuthorizationError,
  getPlanFeaturesByOwnerId,
} from "@webstudio-is/trpc-interface/index.server";
import { createBuild } from "@webstudio-is/project-build/server";
import { projectTitle } from "../shared/project-schema";
import type { MarketplaceApprovalStatus } from "../shared/marketplace-schema";
import { generateDomain, validateProjectDomain } from "./project-domain";
import {
  and,
  asc,
  assetFolder,
  asset,
  build,
  eq,
  file,
  isNotNull,
  isNull,
  latestStaticBuildPerProject,
  loadDomainsVirtual,
  loadLatestBuildVirtual,
  loadPreviewImageAssets,
  maybeOne,
  one,
  project as projectTable,
  sql,
  workspace,
  workspaceMember,
  isUniqueViolation,
} from "@webstudio-is/db";

export const findProjectIdsByUserId = async (
  userId: string,
  context: AppContext
) => {
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

  return await context.db
    .select({ id: projectTable.id })
    .from(projectTable)
    .where(
      and(eq(projectTable.userId, userId), eq(projectTable.isDeleted, false))
    )
    .orderBy(asc(projectTable.id));
};

export type Project = Awaited<ReturnType<typeof loadById>>;

export const loadById = async (projectId: string, context: AppContext) => {
  const canRead = await authorizeProject.hasProjectPermit(
    { projectId, permit: "view" },
    context
  );

  if (canRead === false) {
    throw new AuthorizationError("You don't have access to this project");
  }

  const row = one(
    await context.db
      .select()
      .from(projectTable)
      .where(
        and(eq(projectTable.id, projectId), eq(projectTable.isDeleted, false))
      ),
    "Project"
  );
  const [previewImageAssets, latestBuilds, latestStaticBuilds, domains] =
    await Promise.all([
      loadPreviewImageAssets(context.db, [row]),
      loadLatestBuildVirtual(context.db, [row.id]),
      context.db
        .select()
        .from(latestStaticBuildPerProject)
        .where(eq(latestStaticBuildPerProject.projectId, row.id)),
      loadDomainsVirtual(context.db, [row.id]),
    ]);
  const { publishedUrl, ...project } = row;

  return {
    ...project,
    // selfhost: optional so fixtures without it still typecheck
    ...(publishedUrl === null ? {} : { publishedUrl }),
    previewImageAsset: previewImageAssets.get(row.id) ?? null,
    latestBuildVirtual: latestBuilds.get(row.id) ?? null,
    latestStaticBuild: (latestStaticBuilds[0] ?? null) as
      | (typeof latestStaticBuilds)[number]
      | null,
    domainsVirtual: domains.get(row.id) ?? [],
  };
};

export const create = async (
  { title, workspaceId }: { title: string; workspaceId?: string },
  context: AppContext
) => {
  projectTitle.parse(title);

  if (context.authorization.type !== "user") {
    throw new AuthorizationError("Only logged in users can create a project");
  }

  const userId = context.authorization.userId;

  if (userId === undefined) {
    throw new Error("The user must be authenticated to create a project");
  }

  const projectId = createId();

  // When creating inside a workspace, the project is owned by the workspace
  // owner — not the creating user. This ensures the workspace owner retains
  // full control and removing a member revokes all their access.
  let projectOwnerUserId = userId;

  if (workspaceId !== undefined) {
    const workspaceRow = one(
      await context.db
        .select({ userId: workspace.userId })
        .from(workspace)
        .where(
          and(eq(workspace.id, workspaceId), eq(workspace.isDeleted, false))
        ),
      "Workspace"
    );

    // Verify the caller is the workspace owner or a member
    if (workspaceRow.userId !== userId) {
      const membership = await findActiveMembership(
        workspaceId,
        userId,
        context
      );

      if (membership === null) {
        throw new AuthorizationError("You don't have access to this workspace");
      }

      // Only builders and administrators can create projects
      const canCreate =
        membership.relation === "builders" ||
        membership.relation === "administrators";
      if (canCreate === false) {
        throw new AuthorizationError(
          "You don't have permission to create projects in this workspace"
        );
      }
    }

    projectOwnerUserId = workspaceRow.userId;
  }

  // Enforce the per-user project limit before creating anything
  const ownerPlan = await getPlanFeaturesByOwnerId(projectOwnerUserId, context);
  const projectCount = await context.db.$count(
    projectTable,
    and(
      eq(projectTable.userId, projectOwnerUserId),
      eq(projectTable.isDeleted, false)
    )
  );

  if (projectCount >= ownerPlan.maxProjectsAllowedPerUser) {
    throw new Error(
      "You've reached the project limit for your plan. Upgrade or delete a project to create a new one."
    );
  }

  // create project without user first
  // and set user only after build is successfully created
  // this way to make project creation transactional
  // for user
  await context.db.insert(projectTable).values({
    id: projectId,
    title,
    domain: generateDomain(title),
  });

  await createBuild({ projectId }, context);

  return one(
    await context.db
      .update(projectTable)
      .set({ userId: projectOwnerUserId, workspaceId: workspaceId ?? null })
      .where(eq(projectTable.id, projectId))
      .returning(),
    "Project"
  );
};

export const markAsDeleted = async (
  projectId: Project["id"],
  context: AppContext
) => {
  const canDelete = await authorizeProject.hasProjectPermit(
    { projectId, permit: "own" },
    context
  );

  if (canDelete === false) {
    return { errors: "Only the owner can delete the project" };
  }

  await softDeleteProject(projectId, context);
};

/**
 * Soft-delete a single project: marks it as deleted and frees the subdomain
 * by assigning a unique random domain. Must be called once per project —
 * never in a bulk update — so every row gets its own unique domain.
 */
export const softDeleteProject = async (
  projectId: string,
  context: AppContext
) => {
  await context.db
    .update(projectTable)
    .set({
      isDeleted: true,
      // Free the subdomain — each project needs a unique value
      domain: createId("nano"),
    })
    .where(eq(projectTable.id, projectId));
};

const assertEditPermission = async (projectId: string, context: AppContext) => {
  const canEdit = await authorizeProject.hasProjectPermit(
    { projectId, permit: "edit" },
    context
  );

  if (canEdit === false) {
    throw new Error(
      "Only a token or user with edit permission can edit the project."
    );
  }
};

export const rename = async (
  {
    projectId,
    title,
  }: {
    projectId: Project["id"];
    title: string;
  },
  context: AppContext
) => {
  projectTitle.parse(title);

  await assertEditPermission(projectId, context);

  await context.db
    .update(projectTable)
    .set({ title })
    .where(eq(projectTable.id, projectId));
};

export const updatePreviewImage = async (
  {
    projectId,
    assetId,
  }: {
    projectId: Project["id"];
    assetId: string | null;
  },
  context: AppContext
) => {
  await assertEditPermission(projectId, context);

  await context.db
    .update(projectTable)
    .set({ previewImageAssetId: assetId })
    .where(eq(projectTable.id, projectId));
};

export const clone = async (
  {
    projectId,
    title,
  }: {
    projectId: string;
    title?: string | undefined;
  },
  destinationContext: AppContext,
  sourceContext: AppContext
) => {
  const project = await loadById(projectId, sourceContext);
  if (project === null) {
    throw new Error(`Not found project "${projectId}"`);
  }

  if (destinationContext.authorization.type !== "user") {
    throw new AuthorizationError("Only logged in users can clone a project");
  }

  const { userId } = destinationContext.authorization;
  if (userId === undefined) {
    throw new Error("The user must be authenticated to clone the project");
  }

  // Should be some mixed context in case of RLS
  // If the source project belongs to a workspace, check clone permissions
  // BEFORE creating the clone to avoid unnecessary rollbacks.
  let workspaceCloneTarget:
    | undefined
    | { workspaceId: string; projectOwnerUserId: string };

  if (project.workspaceId !== null) {
    const workspaceRow = maybeOne(
      await destinationContext.db
        .select({ userId: workspace.userId })
        .from(workspace)
        .where(
          and(
            eq(workspace.id, project.workspaceId),
            eq(workspace.isDeleted, false)
          )
        )
    );

    if (workspaceRow !== null) {
      const isOwner = workspaceRow.userId === userId;

      if (isOwner) {
        workspaceCloneTarget = {
          workspaceId: project.workspaceId,
          projectOwnerUserId: workspaceRow.userId,
        };
      } else {
        const membership = await findActiveMembership(
          project.workspaceId,
          userId,
          destinationContext
        );

        if (membership !== null) {
          const canClone =
            membership.relation === "builders" ||
            membership.relation === "administrators";

          if (canClone === false) {
            throw new AuthorizationError(
              "You don't have permission to clone projects in this workspace"
            );
          }

          // Place clone in workspace, owned by the workspace owner
          // (consistent with project creation)
          workspaceCloneTarget = {
            workspaceId: project.workspaceId,
            projectOwnerUserId: workspaceRow.userId,
          };
        }
        // Non-members (e.g. token-based clone): clone stays in personal space
      }
    }
  }

  const clonedProject = await cloneProjectRows(destinationContext, {
    projectId,
    userId,
    title: title ?? `${project.title} (copy)`,
    domain: generateDomain(project.title),
  });

  if (workspaceCloneTarget !== undefined) {
    await destinationContext.db
      .update(projectTable)
      .set({
        workspaceId: workspaceCloneTarget.workspaceId,
        userId: workspaceCloneTarget.projectOwnerUserId,
      })
      .where(eq(projectTable.id, clonedProject.id));
  }

  return { id: clonedProject.id };
};

export const updateDomain = async (
  input: {
    id: string;
    domain: string;
  },
  context: AppContext
) => {
  const domainValidation = validateProjectDomain(input.domain);

  if (domainValidation.success === false) {
    throw new Error(domainValidation.error);
  }

  const { domain } = domainValidation;

  await assertEditPermission(input.id, context);

  // Check if the current wstd domain is published - forbid renaming while published
  // Get current domain first
  const currentProject = one(
    await context.db
      .select({ domain: projectTable.domain })
      .from(projectTable)
      .where(eq(projectTable.id, input.id)),
    "Project"
  );

  // Check if any build has this domain in deployment.domains
  const buildsWithDomain = await context.db
    .select({ id: build.id, deployment: build.deployment })
    .from(build)
    .where(and(eq(build.projectId, input.id), isNotNull(build.deployment)));

  const isDomainPublished = buildsWithDomain.some((build) => {
    const deployment = build.deployment as {
      destination?: string;
      domains?: string[];
    } | null;
    if (deployment === null) {
      return false;
    }
    if (deployment.destination === "static") {
      return false;
    }
    return deployment.domains?.includes(currentProject.domain) ?? false;
  });

  if (isDomainPublished) {
    throw new Error(
      "Cannot change domain while it is published. Unpublish first."
    );
  }

  try {
    await context.db
      .update(projectTable)
      .set({ domain })
      .where(eq(projectTable.id, input.id));
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error(`Domain "${domain}" is already used`);
    }
    throw error;
  }
};

export const setMarketplaceApprovalStatus = async (
  {
    projectId,
    marketplaceApprovalStatus,
  }: {
    projectId: Project["id"];
    marketplaceApprovalStatus: MarketplaceApprovalStatus;
  },
  context: AppContext
) => {
  if (
    marketplaceApprovalStatus === "APPROVED" ||
    marketplaceApprovalStatus === "REJECTED"
  ) {
    throw new Error("User can't approve or reject");
  }
  await assertEditPermission(projectId, context);

  return one(
    await context.db
      .update(projectTable)
      .set({ marketplaceApprovalStatus })
      .where(eq(projectTable.id, projectId))
      .returning(),
    "Project"
  );
};

export const updateProjectTags = async (
  { projectId, tags }: { projectId: Project["id"]; tags: string[] },
  context: AppContext
) => {
  await assertEditPermission(projectId, context);
  return one(
    await context.db
      .update(projectTable)
      .set({ tags })
      .where(eq(projectTable.id, projectId))
      .returning(),
    "Project"
  );
};

const findActiveMembership = async (
  workspaceId: string,
  userId: string,
  context: AppContext
) =>
  maybeOne(
    await context.db
      .select({
        userId: workspaceMember.userId,
        relation: workspaceMember.relation,
      })
      .from(workspaceMember)
      .where(
        and(
          eq(workspaceMember.workspaceId, workspaceId),
          eq(workspaceMember.userId, userId),
          isNull(workspaceMember.removedAt)
        )
      )
  );

/**
 * Copies a project into a new one owned by `userId`: its asset folders, the assets
 * whose files finished uploading (sharing the same File rows), the preview image and
 * the development build. All or nothing.
 */
const cloneProjectRows = async (
  context: AppContext,
  input: { projectId: string; userId: string; title: string; domain: string }
) =>
  await context.db.transaction(async (tx) => {
    const source = one(
      await tx
        .select({ previewImageAssetId: projectTable.previewImageAssetId })
        .from(projectTable)
        .where(eq(projectTable.id, input.projectId)),
      "Project"
    );

    const clone = one(
      await tx
        .insert(projectTable)
        .values({
          id: sql`gen_random_uuid()::text`,
          userId: input.userId,
          title: input.title,
          domain: input.domain,
        })
        .returning()
    );

    await tx.insert(assetFolder).select(
      tx
        .select({
          id: assetFolder.id,
          projectId: sql<string>`${clone.id}`.as("projectId"),
          name: assetFolder.name,
          parentId: assetFolder.parentId,
          createdAt: assetFolder.createdAt,
        })
        .from(assetFolder)
        .where(eq(assetFolder.projectId, input.projectId))
    );

    await tx.insert(asset).select(
      tx
        .select({
          id: asset.id,
          projectId: sql<string>`${clone.id}`.as("projectId"),
          name: asset.name,
          description: asset.description,
          filename: asset.filename,
          folderId: asset.folderId,
        })
        .from(asset)
        .innerJoin(file, eq(file.name, asset.name))
        .where(
          and(eq(asset.projectId, input.projectId), eq(file.status, "UPLOADED"))
        )
    );

    const [cloned] = await tx
      .update(projectTable)
      .set({ previewImageAssetId: source.previewImageAssetId })
      .where(eq(projectTable.id, clone.id))
      .returning();

    await tx.insert(build).select(
      tx
        .select({
          id: sql<string>`gen_random_uuid()::text`.as("id"),
          createdAt: sql<string>`CURRENT_TIMESTAMP`.as("createdAt"),
          pages: build.pages,
          projectId: sql<string>`${clone.id}`.as("projectId"),
          styleSources: build.styleSources,
          styles: build.styles,
          breakpoints: build.breakpoints,
          styleSourceSelections: build.styleSourceSelections,
          props: build.props,
          instances: build.instances,
          updatedAt: sql<string>`CURRENT_TIMESTAMP`.as("updatedAt"),
          version: sql<number>`0`.as("version"),
          deployment: sql<null>`NULL`.as("deployment"),
          publishStatus: sql<"PENDING">`'PENDING'::"PublishStatus"`.as(
            "publishStatus"
          ),
          // A new build has no publish error yet (insert-select lists every column, in order).
          publishError: sql<null>`NULL`.as("publishError"),
          dataSources: build.dataSources,
          lastTransactionId: sql<null>`NULL`.as("lastTransactionId"),
          resources: build.resources,
          marketplaceProduct: build.marketplaceProduct,
          isCleaned: sql<boolean>`false`.as("isCleaned"),
          projectSettings: build.projectSettings,
        })
        .from(build)
        .where(
          and(eq(build.projectId, input.projectId), isNull(build.deployment))
        )
    );

    return cloned;
  });
