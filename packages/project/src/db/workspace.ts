import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  maybeOne,
  notification,
  one,
  project,
  user,
  workspace as workspaceTable,
  workspaceMember,
  type Database,
} from "@webstudio-is/db";
import { createId } from "@webstudio-is/sdk";
import {
  type AppContext,
  AuthorizationError,
  getPlanFeaturesByOwnerId,
} from "@webstudio-is/trpc-interface/index.server";
import { softDeleteProject } from "./project";
import { defaultRole, type Role } from "@webstudio-is/trpc-interface/authorize";
import {
  type WorkspaceInvitePayload,
  type ProjectTransferPayload,
  NOTIFICATION_TTL_MS,
} from "../shared/notification-schema";
import { create as createNotification } from "./notification";
import { getExtraPaidSeats } from "@webstudio-is/plans/index.server";

export type Workspace = Database["public"]["Tables"]["Workspace"]["Row"];

export type WorkspaceWithRelation = Workspace & {
  /** The current user's relation to the workspace: "own" for owners */
  role: Role | "own";
  /**
   * True when the workspace owner has lost workspace access for members.
   * Fires when either:
   *   - owner's plan no longer grants workspaces (`maxWorkspaces <= 1`), or
   *   - `actualMembers > paidSeats` (owner has more members than paid seats).
   * Members lose project access but workspace data stays intact.
   */
  isDowngraded: boolean;
};

const activeMembership = (workspaceId: string, userId: string) =>
  and(
    eq(workspaceMember.workspaceId, workspaceId),
    eq(workspaceMember.userId, userId),
    isNull(workspaceMember.removedAt)
  );

const liveWorkspace = (workspaceId: string) =>
  and(eq(workspaceTable.id, workspaceId), eq(workspaceTable.isDeleted, false));

const assertUser = (context: AppContext) => {
  if (context.authorization.type !== "user") {
    throw new AuthorizationError("Only logged in users can manage workspaces");
  }
  return context.authorization.userId;
};

export const create = async (
  { name, maxWorkspaces }: { name: string; maxWorkspaces: number },
  context: AppContext
) => {
  const userId = assertUser(context);

  const trimmed = name.trim();
  if (trimmed.length < 2) {
    throw new Error("Workspace name must be at least 2 characters");
  }

  // Count existing workspaces owned by the user
  const workspaceCount = await context.db.$count(
    workspaceTable,
    and(eq(workspaceTable.userId, userId), eq(workspaceTable.isDeleted, false))
  );

  if (workspaceCount >= maxWorkspaces) {
    throw new Error(
      `You have reached the maximum number of workspaces (${maxWorkspaces}).`
    );
  }

  return one(
    await context.db
      .insert(workspaceTable)
      .values({
        id: createId(),
        name: trimmed,
        isDefault: false,
        userId,
      })
      .returning()
  );
};

export const rename = async (
  { workspaceId, name }: { workspaceId: string; name: string },
  context: AppContext
) => {
  const userId = assertUser(context);

  const trimmed = name.trim();
  if (trimmed.length < 2) {
    throw new Error("Workspace name must be at least 2 characters");
  }

  return one(
    await context.db
      .update(workspaceTable)
      .set({ name: trimmed })
      .where(and(liveWorkspace(workspaceId), eq(workspaceTable.userId, userId)))
      .returning(),
    "Workspace"
  );
};

export const remove = async (
  {
    workspaceId,
    deleteProjects,
  }: { workspaceId: string; deleteProjects?: boolean },
  context: AppContext
) => {
  const userId = assertUser(context);

  // Load the workspace to check ownership and isDefault
  const workspace = one(
    await context.db
      .select({
        id: workspaceTable.id,
        isDefault: workspaceTable.isDefault,
        userId: workspaceTable.userId,
      })
      .from(workspaceTable)
      .where(liveWorkspace(workspaceId)),
    "Workspace"
  );

  if (workspace.userId !== userId) {
    throw new AuthorizationError(
      "Only the workspace owner can delete a workspace"
    );
  }

  if (workspace.isDefault) {
    throw new Error("The default workspace cannot be deleted");
  }

  // Check for active projects BEFORE soft-deleting to avoid
  // leaving the workspace in a deleted state on error.
  const projects = await context.db
    .select({ id: project.id })
    .from(project)
    .where(
      and(eq(project.workspaceId, workspaceId), eq(project.isDeleted, false))
    );

  // Collect project IDs upfront so concurrent changes can't alter the set.
  const projectIds = projects.map((p) => p.id);

  if (projectIds.length > 0 && deleteProjects !== true) {
    throw new Error(
      "Cannot delete a workspace that still contains projects. Move or delete all projects first."
    );
  }

  // Soft-delete projects first so the operation is retryable:
  // if a project deletion fails mid-loop the workspace is still visible
  // (isDeleted=false) and the caller can retry the whole operation.
  if (projectIds.length > 0) {
    for (const id of projectIds) {
      await softDeleteProject(id, context);
    }
  }

  // Soft-delete the workspace last — single atomic update makes it
  // immediately invisible everywhere.
  await context.db
    .update(workspaceTable)
    .set({ isDeleted: true })
    .where(
      and(eq(workspaceTable.id, workspaceId), eq(workspaceTable.userId, userId))
    );
};

export const findMany = async (userId: string, context: AppContext) => {
  assertUser(context);

  // Workspaces owned by the user
  const owned = await context.db
    .select()
    .from(workspaceTable)
    .where(
      and(
        eq(workspaceTable.userId, userId),
        eq(workspaceTable.isDeleted, false)
      )
    )
    .orderBy(desc(workspaceTable.isDefault), asc(workspaceTable.createdAt));

  // Workspaces where the user is a member (not owner)
  const memberships = await context.db
    .select({
      workspaceId: workspaceMember.workspaceId,
      relation: workspaceMember.relation,
    })
    .from(workspaceMember)
    .where(
      and(eq(workspaceMember.userId, userId), isNull(workspaceMember.removedAt))
    );

  const memberWorkspaceIds = memberships.map((m) => m.workspaceId);
  const relationByWorkspaceId = new Map(
    memberships.map((m) => [m.workspaceId, m.relation as Role])
  );

  const ownedWithRelation: WorkspaceWithRelation[] = owned.map((w) => ({
    ...w,
    role: "own" as const,
    isDowngraded: false,
  }));

  if (memberWorkspaceIds.length === 0) {
    return ownedWithRelation;
  }

  const memberOf = await context.db
    .select()
    .from(workspaceTable)
    .where(
      and(
        inArray(workspaceTable.id, memberWorkspaceIds),
        eq(workspaceTable.isDeleted, false)
      )
    )
    .orderBy(asc(workspaceTable.createdAt));

  // For member workspaces, check whether the owner still grants workspace access.
  // Two conditions downgrade: plan no longer includes workspaces
  // (`maxWorkspaces <= 1`), or owner has more members than paid seats
  // (`actualMembers > paidSeats`). Collect unique owner IDs and batch-check.
  const ownerIds = [...new Set(memberOf.map((w) => w.userId))];
  const downgradedOwners = new Set<string>();

  if (ownerIds.length > 0) {
    // Use allSettled so a single owner's check failure doesn't
    // break the entire workspace list. Failed checks default to not-downgraded.
    const checks = await Promise.allSettled(
      ownerIds.map(async (ownerId) => {
        const plan = await getPlanFeaturesByOwnerId(ownerId, context);
        if (plan.maxWorkspaces <= 1) {
          return { ownerId, isDowngraded: true };
        }
        const [memberCount, extraSeats] = await Promise.all([
          countAllMembers(ownerId, context),
          getExtraPaidSeats(ownerId, context),
        ]);
        // seatsIncluded is the number of non-owner member slots included in
        // the plan. The owner is not counted — consistent with the billing
        // formula used at invite time and at invoice renewal.
        const paidSeats = plan.seatsIncluded + (extraSeats ?? 0);
        return { ownerId, isDowngraded: memberCount > paidSeats };
      })
    );
    for (const result of checks) {
      if (result.status === "fulfilled" && result.value.isDowngraded) {
        downgradedOwners.add(result.value.ownerId);
      }
    }
  }

  const memberWithRelation: WorkspaceWithRelation[] = memberOf.map((w) => ({
    ...w,
    role: relationByWorkspaceId.get(w.id) ?? defaultRole,
    isDowngraded: downgradedOwners.has(w.userId),
  }));

  // Owned workspaces first (default on top), then member workspaces
  return [...ownedWithRelation, ...memberWithRelation];
};

const loadWorkspaceOwner = async (workspaceId: string, context: AppContext) =>
  one(
    await context.db
      .select({ id: workspaceTable.id, userId: workspaceTable.userId })
      .from(workspaceTable)
      .where(liveWorkspace(workspaceId)),
    "Workspace"
  );

const assertWorkspaceOwnerByUserId = async (
  workspaceId: string,
  userId: string,
  context: AppContext
) => {
  const workspace = await loadWorkspaceOwner(workspaceId, context);

  if (workspace.userId !== userId) {
    throw new AuthorizationError("Only the workspace owner can manage members");
  }

  return workspace;
};

export const assertWorkspaceOwner = async (
  workspaceId: string,
  context: AppContext
) => {
  const userId = assertUser(context);
  return await assertWorkspaceOwnerByUserId(workspaceId, userId, context);
};

export const assertWorkspaceOwnerPlan = async (
  workspaceId: string,
  context: AppContext
) => {
  const workspace = await assertWorkspaceOwner(workspaceId, context);
  return {
    workspace,
    plan: await getPlanFeaturesByOwnerId(workspace.userId, context),
  };
};

/**
 * Count all current members (non-removed) plus pending invites across all
 * non-deleted workspaces owned by userId.
 * The owner is NOT counted.
 * Pending invites are included because seats are billed at invite time.
 */
export const countAllMembers = async (
  userId: string,
  context: AppContext
): Promise<number> => {
  const workspaces = await context.db
    .select({ id: workspaceTable.id })
    .from(workspaceTable)
    .where(
      and(
        eq(workspaceTable.userId, userId),
        eq(workspaceTable.isDeleted, false)
      )
    );

  if (workspaces.length === 0) {
    return 0;
  }

  const workspaceIds = workspaces.map((w) => w.id);

  const [members, pendingCount] = await Promise.all([
    // Fetch all userIds so we can deduplicate — the same person may be a
    // member of several of the owner's workspaces but counts as one seat.
    context.db
      .select({ userId: workspaceMember.userId })
      .from(workspaceMember)
      .where(
        and(
          inArray(workspaceMember.workspaceId, workspaceIds),
          isNull(workspaceMember.removedAt)
        )
      ),
    context.db.$count(
      notification,
      and(
        eq(notification.type, "workspaceInvite"),
        eq(notification.senderId, userId),
        eq(notification.status, "pending")
      )
    ),
  ]);

  const uniqueMembers = new Set(members.map((row) => row.userId));
  return uniqueMembers.size + pendingCount;
};

const findUserIdByEmail = async (email: string, context: AppContext) =>
  maybeOne(
    await context.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
  );

const findActiveMember = async (
  workspaceId: string,
  userId: string,
  context: AppContext
) =>
  maybeOne(
    await context.db
      .select({ relation: workspaceMember.relation })
      .from(workspaceMember)
      .where(activeMembership(workspaceId, userId))
  );

export const addMember = async (
  {
    workspaceId,
    email,
    relation,
  }: { workspaceId: string; email: string; relation: Role },
  context: AppContext
): Promise<{ notificationId: string }> => {
  const userId = assertUser(context);
  await assertWorkspaceOwnerByUserId(workspaceId, userId, context);

  // Look up the user by email
  const invitee = await findUserIdByEmail(email, context);

  if (invitee === null) {
    throw new Error(
      "No Webstudio account found. The user needs to sign up first."
    );
  }

  if (invitee.id === userId) {
    throw new Error("You are already the owner of this workspace");
  }

  const memberId = invitee.id;

  // Check if already a member — no need for a notification
  const existing = await findActiveMember(workspaceId, memberId, context);

  if (existing !== null) {
    throw new Error("Already a member of this workspace.");
  }

  // Create a pending notification instead of inserting directly
  const payload: WorkspaceInvitePayload = { workspaceId, relation };
  const notificationId = await createNotification(
    { type: "workspaceInvite", recipientId: memberId, payload },
    context
  );

  return { notificationId };
};

export const updateRole = async (
  {
    workspaceId,
    memberUserId,
    relation,
  }: {
    workspaceId: string;
    memberUserId: string;
    relation: Role;
  },
  context: AppContext
) => {
  const userId = assertUser(context);
  await assertWorkspaceOwnerByUserId(workspaceId, userId, context);

  if (memberUserId === userId) {
    throw new Error("Cannot change the workspace owner's role");
  }

  const updated = await context.db
    .update(workspaceMember)
    .set({ relation })
    .where(activeMembership(workspaceId, memberUserId))
    .returning({ userId: workspaceMember.userId });

  if (updated.length === 0) {
    throw new Error("Member not found");
  }
};

export const removeMember = async (
  { workspaceId, memberUserId }: { workspaceId: string; memberUserId: string },
  context: AppContext
) => {
  const userId = assertUser(context);

  // A member can remove themselves (leave) without being the owner.
  const isSelfRemoval = memberUserId === userId;

  if (isSelfRemoval) {
    // Verify the caller is NOT the owner — owners cannot leave their own workspace.
    const workspace = await loadWorkspaceOwner(workspaceId, context);

    if (workspace.userId === userId) {
      throw new Error("The workspace owner cannot be removed");
    }
  } else {
    // Only the owner can remove other members.
    await assertWorkspaceOwnerByUserId(workspaceId, userId, context);
  }

  const removed = await context.db
    .update(workspaceMember)
    .set({ removedAt: new Date().toISOString() })
    .where(activeMembership(workspaceId, memberUserId))
    .returning({ userId: workspaceMember.userId });

  if (removed.length === 0) {
    throw new Error("Member not found");
  }
};

export const listMembers = async (
  { workspaceId }: { workspaceId: string },
  context: AppContext
) => {
  const userId = assertUser(context);

  // Verify the caller is the owner or a member
  const workspace = await loadWorkspaceOwner(workspaceId, context);

  if (workspace.userId !== userId) {
    // Check if caller is a member
    const membership = await findActiveMember(workspaceId, userId, context);

    if (membership === null) {
      throw new AuthorizationError("You don't have access to this workspace");
    }
  }

  const members = await context.db
    .select({
      userId: workspaceMember.userId,
      relation: workspaceMember.relation,
      createdAt: workspaceMember.createdAt,
    })
    .from(workspaceMember)
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        isNull(workspaceMember.removedAt)
      )
    )
    .orderBy(desc(workspaceMember.createdAt));

  // Fetch pending workspace invite notifications for this workspace.
  // Only visible to the owner (already verified above).
  const pendingInvites =
    workspace.userId === userId
      ? await context.db
          .select({
            id: notification.id,
            recipientId: notification.recipientId,
            payload: notification.payload,
            createdAt: notification.createdAt,
          })
          .from(notification)
          .where(
            and(
              eq(notification.type, "workspaceInvite"),
              eq(notification.senderId, workspace.userId),
              eq(notification.status, "pending"),
              gte(
                notification.createdAt,
                new Date(Date.now() - NOTIFICATION_TTL_MS).toISOString()
              )
            )
          )
          .orderBy(desc(notification.createdAt))
      : [];

  // Filter to only invites for this specific workspace.
  const acceptedUserIds = new Set(members.map((m) => m.userId));
  const pendingForWorkspace = pendingInvites.filter((n) => {
    const payload = n.payload as unknown as Partial<WorkspaceInvitePayload>;
    return (
      payload.workspaceId === workspaceId && !acceptedUserIds.has(n.recipientId)
    );
  });

  // Fetch user info for members, owner, and pending invite recipients.
  const allUserIds = [
    workspace.userId,
    ...members.map((m) => m.userId),
    ...pendingForWorkspace.map((n) => n.recipientId),
  ];
  const uniqueUserIds = [...new Set(allUserIds)];

  const users = await context.db
    .select({ id: user.id, email: user.email, username: user.username })
    .from(user)
    .where(inArray(user.id, uniqueUserIds));

  const usersById = new Map(users.map((u) => [u.id, u]));

  const ownerUser = usersById.get(workspace.userId);

  return {
    owner: {
      userId: workspace.userId,
      email: ownerUser?.email ?? "",
      username: ownerUser?.username ?? "",
    },
    members: members.map((m) => ({
      userId: m.userId,
      relation: m.relation,
      createdAt: m.createdAt,
      email: usersById.get(m.userId)?.email ?? "",
      username: usersById.get(m.userId)?.username ?? "",
    })),
    pendingInvites: pendingForWorkspace.map((n) => {
      const payload = n.payload as unknown as WorkspaceInvitePayload;
      return {
        notificationId: n.id,
        recipientId: n.recipientId,
        relation: payload.relation,
        createdAt: n.createdAt,
        email: usersById.get(n.recipientId)?.email ?? "",
      };
    }),
  };
};

/**
 * Verify the caller is the project owner or an admin of the project's source workspace.
 * Returns the loaded project data.
 */
const assertProjectPermission = async (
  {
    projectId,
    userId,
    action,
  }: { projectId: string; userId: string; action: string },
  context: AppContext
) => {
  const projectRows = await context.db
    .select({
      id: project.id,
      userId: project.userId,
      workspaceId: project.workspaceId,
    })
    .from(project)
    .where(and(eq(project.id, projectId), eq(project.isDeleted, false)));

  if (projectRows.length !== 1) {
    throw new Error("Project not found");
  }
  const projectData = projectRows[0];

  const isProjectOwner = projectData.userId === userId;
  const sourceWorkspaceId = projectData.workspaceId;

  if (isProjectOwner === false && sourceWorkspaceId !== null) {
    const membership = await findActiveMember(
      sourceWorkspaceId,
      userId,
      context
    );

    if (membership === null || membership.relation !== "administrators") {
      throw new AuthorizationError(
        `Only the project owner or a workspace admin can ${action} projects`
      );
    }
  } else if (isProjectOwner === false) {
    throw new AuthorizationError(
      `Only the project owner can ${action} this project`
    );
  }

  return projectData;
};

const findTargetWorkspace = async (
  workspaceId: string,
  context: AppContext
) => {
  const rows = await context.db
    .select({ id: workspaceTable.id, userId: workspaceTable.userId })
    .from(workspaceTable)
    .where(liveWorkspace(workspaceId));
  if (rows.length !== 1) {
    throw new Error("Target workspace not found");
  }
  return rows[0];
};

/**
 * Move a project to a different workspace owned by or shared with the current user.
 * No notification is needed — the move is instant.
 */
export const moveProject = async (
  {
    projectId,
    targetWorkspaceId,
  }: { projectId: string; targetWorkspaceId: string },
  context: AppContext
) => {
  const userId = assertUser(context);

  const projectData = await assertProjectPermission(
    { projectId, userId, action: "move" },
    context
  );

  // Verify the target workspace exists
  const targetWorkspace = await findTargetWorkspace(targetWorkspaceId, context);

  // Verify the caller is owner or admin of the target workspace
  const isTargetOwner = targetWorkspace.userId === userId;
  if (isTargetOwner === false) {
    const targetMembership = await findActiveMember(
      targetWorkspaceId,
      userId,
      context
    );

    if (
      targetMembership === null ||
      targetMembership.relation !== "administrators"
    ) {
      throw new AuthorizationError(
        "You need admin or owner permissions on the target workspace"
      );
    }
  }

  // Cross-owner moves are not allowed — use the transfer flow instead
  // so the target workspace owner gets a notification and must accept.
  if (targetWorkspace.userId !== projectData.userId) {
    throw new AuthorizationError(
      "Use the transfer flow to move a project to another user's workspace"
    );
  }

  one(
    await context.db
      .update(project)
      .set({ workspaceId: targetWorkspaceId })
      .where(eq(project.id, projectId))
      .returning({ id: project.id }),
    "Project"
  );
};

/**
 * Initiate a project transfer to another user. Creates a notification
 * the recipient must accept before the project is reassigned.
 */
export const transferProject = async (
  {
    projectId,
    recipientEmail,
    targetWorkspaceId,
  }: {
    projectId: string;
    recipientEmail: string;
    targetWorkspaceId?: string;
  },
  context: AppContext
) => {
  const userId = assertUser(context);

  await assertProjectPermission(
    { projectId, userId, action: "transfer" },
    context
  );

  // Look up the recipient by email
  const recipient = await findUserIdByEmail(recipientEmail, context);

  // Silently succeed for non-existent emails (anti-enumeration)
  if (recipient === null) {
    return;
  }

  if (recipient.id === userId) {
    throw new Error("You cannot transfer a project to yourself");
  }

  // If a target workspace is specified, verify it exists and belongs to the recipient
  if (targetWorkspaceId !== undefined) {
    const targetWorkspace = await findTargetWorkspace(
      targetWorkspaceId,
      context
    );

    if (targetWorkspace.userId !== recipient.id) {
      throw new Error("Target workspace does not belong to the recipient");
    }
  }

  const payload: ProjectTransferPayload = {
    projectId,
    targetWorkspaceId,
  };

  await createNotification(
    { type: "projectTransfer", recipientId: recipient.id, payload },
    context
  );
};

/**
 * List workspaces owned by a specific user that the current user is a member of.
 * Used in the transfer dialog to show available target workspaces.
 */
export const findSharedWorkspacesByOwnerEmail = async (
  { email }: { email: string },
  context: AppContext
) => {
  const userId = assertUser(context);

  // Look up the target user by email
  const targetUser = await findUserIdByEmail(email, context);

  // Return empty for non-existent emails (anti-enumeration)
  if (targetUser === null) {
    return [];
  }

  // Find workspaces owned by the target user
  const workspaces = await context.db
    .select({ id: workspaceTable.id, name: workspaceTable.name })
    .from(workspaceTable)
    .where(
      and(
        eq(workspaceTable.userId, targetUser.id),
        eq(workspaceTable.isDeleted, false)
      )
    );

  if (workspaces.length === 0) {
    return [];
  }

  // Filter to only those where the current user is a member
  const memberships = await context.db
    .select({ workspaceId: workspaceMember.workspaceId })
    .from(workspaceMember)
    .where(
      and(
        eq(workspaceMember.userId, userId),
        isNull(workspaceMember.removedAt),
        inArray(
          workspaceMember.workspaceId,
          workspaces.map((w) => w.id)
        )
      )
    );

  const memberWorkspaceIds = new Set(memberships.map((m) => m.workspaceId));

  return workspaces.filter((w) => memberWorkspaceIds.has(w.id));
};
