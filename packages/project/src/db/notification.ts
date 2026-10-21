import {
  type AppContext,
  AuthorizationError,
  getPlanFeaturesByOwnerId,
} from "@webstudio-is/trpc-interface/index.server";
import { createId } from "@webstudio-is/sdk";
import {
  type NotificationType,
  type NotificationStatus,
  NOTIFICATION_TTL_MS,
  type WorkspaceInvitePayload,
  workspaceInvitePayload,
  type ProjectTransferPayload,
  projectTransferPayload,
} from "../shared/notification-schema";
import { roleLabels } from "@webstudio-is/trpc-interface/authorize";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  maybeOne,
  notification as notificationTable,
  one,
  project as projectTable,
  projectDomain,
  sql,
  user,
  workspace as workspaceTable,
  workspaceMember,
  type Db,
  type Json,
  type SQL,
} from "@webstudio-is/db";

const assertUser = (context: AppContext) => {
  if (context.authorization.type !== "user") {
    throw new AuthorizationError(
      "Only logged in users can manage notifications"
    );
  }
  return context.authorization.userId;
};

const expirationCutoff = () =>
  new Date(Date.now() - NOTIFICATION_TTL_MS).toISOString();

/** Pending and not yet expired. */
const isLivePending = () =>
  and(
    eq(notificationTable.status, "pending"),
    gte(notificationTable.createdAt, expirationCutoff())
  );

/** jsonb containment, like PostgREST's `.contains()`. */
const payloadContains = (value: Record<string, unknown>): SQL =>
  sql`${notificationTable.payload} @> ${JSON.stringify(value)}::jsonb`;

export const create = async (
  {
    type,
    recipientId,
    payload,
  }: {
    type: NotificationType;
    recipientId: string;
    payload: Record<string, unknown>;
  },
  context: AppContext
): Promise<string> => {
  const senderId = assertUser(context);

  // For workspace invites, check if a pending invite for the same workspace exists.
  if (type === "workspaceInvite") {
    const duplicate = maybeOne(
      await context.db
        .select({ id: notificationTable.id })
        .from(notificationTable)
        .where(
          and(
            eq(notificationTable.type, type),
            eq(notificationTable.recipientId, recipientId),
            eq(notificationTable.senderId, senderId),
            isLivePending(),
            payloadContains({
              workspaceId: (payload as { workspaceId: string }).workspaceId,
            })
          )
        )
    );

    if (duplicate !== null) {
      return duplicate.id;
    }
  }

  // For project transfers, only one pending transfer per project is allowed
  // (across all senders and recipients).
  if (type === "projectTransfer") {
    const duplicate = maybeOne(
      await context.db
        .select({ id: notificationTable.id })
        .from(notificationTable)
        .where(
          and(
            eq(notificationTable.type, type),
            isLivePending(),
            payloadContains({
              projectId: (payload as { projectId: string }).projectId,
            })
          )
        )
    );

    if (duplicate !== null) {
      throw new Error(
        "A transfer is already pending for this project. Cancel it first."
      );
    }
  }

  const newId = createId();

  await context.db.insert(notificationTable).values({
    id: newId,
    type,
    recipientId,
    senderId,
    status: "pending" satisfies NotificationStatus,
    payload: payload as Json,
  });

  // Post-insert dedup: if a concurrent request inserted an identical
  // notification between our check and our insert, keep the one with the
  // earliest createdAt and silently discard ours.
  const dedup = await postInsertDedup({
    newId,
    type,
    recipientId,
    senderId,
    payload,
    client: context.db,
  });

  return dedup ?? newId;
};

/**
 * After inserting a notification, check whether a concurrent request created a
 * duplicate. If one exists, delete the row we just inserted and return the
 * existing id. Returns undefined when no duplicate was found.
 */
const postInsertDedup = async ({
  newId,
  type,
  recipientId,
  senderId,
  payload,
  client,
}: {
  newId: string;
  type: NotificationType;
  recipientId: string;
  senderId: string;
  payload: Record<string, unknown>;
  client: Db;
}): Promise<string | undefined> => {
  let filter: SQL | undefined;
  if (type === "workspaceInvite") {
    filter = and(
      eq(notificationTable.recipientId, recipientId),
      eq(notificationTable.senderId, senderId),
      payloadContains({
        workspaceId: (payload as { workspaceId: string }).workspaceId,
      })
    );
  } else if (type === "projectTransfer") {
    filter = payloadContains({
      projectId: (payload as { projectId: string }).projectId,
    });
  } else {
    return;
  }

  let data: Array<{ id: string; createdAt: string }>;
  try {
    data = await client
      .select({
        id: notificationTable.id,
        createdAt: notificationTable.createdAt,
      })
      .from(notificationTable)
      .where(and(eq(notificationTable.type, type), isLivePending(), filter))
      .orderBy(asc(notificationTable.createdAt));
  } catch (error) {
    console.error("postInsertDedup: failed to query duplicates:", error);
    return;
  }

  if (data.length <= 1) {
    return;
  }

  // Keep the earliest; if ours isn't earliest, delete ours.
  const earliest = data[0];
  if (earliest.id !== newId) {
    // For projectTransfer, verify the winning notification was sent by the
    // same sender. Otherwise the caller would receive an ID they didn't
    // create and can't cancel.
    if (type === "projectTransfer") {
      const winner = maybeOne(
        await client
          .select({ senderId: notificationTable.senderId })
          .from(notificationTable)
          .where(eq(notificationTable.id, earliest.id))
      );

      if (winner?.senderId !== senderId) {
        // Different sender won the race — delete ours and surface error.
        await client
          .delete(notificationTable)
          .where(eq(notificationTable.id, newId));
        throw new Error(
          "A transfer is already pending for this project. Cancel it first."
        );
      }
    }

    try {
      await client
        .delete(notificationTable)
        .where(eq(notificationTable.id, newId));
    } catch (error) {
      console.error(
        `postInsertDedup: failed to remove duplicate notification ${newId}:`,
        error
      );
    }
    return earliest.id;
  }
};

export const list = async (context: AppContext) => {
  const userId = assertUser(context);

  const notifications = await context.db
    .select()
    .from(notificationTable)
    .where(and(eq(notificationTable.recipientId, userId), isLivePending()))
    .orderBy(desc(notificationTable.createdAt));

  if (notifications.length === 0) {
    return [];
  }

  // Resolve sender info
  const senderIds = [...new Set(notifications.map((n) => n.senderId))];
  const users = await context.db
    .select({ id: user.id, email: user.email, username: user.username })
    .from(user)
    .where(inArray(user.id, senderIds));

  const usersById = new Map(users.map((u) => [u.id, u]));

  // Parse payloads once and cache results
  const parsedInvites = new Map<string, WorkspaceInvitePayload>();
  const parsedTransfers = new Map<string, ProjectTransferPayload>();

  for (const n of notifications) {
    if (n.type === "workspaceInvite") {
      const parsed = workspaceInvitePayload.safeParse(n.payload);
      if (parsed.success) {
        parsedInvites.set(n.id, parsed.data);
      }
    } else if (n.type === "projectTransfer") {
      const parsed = projectTransferPayload.safeParse(n.payload);
      if (parsed.success) {
        parsedTransfers.set(n.id, parsed.data);
      }
    }
  }

  // Resolve workspace names for workspaceInvite notifications
  const uniqueWorkspaceIds = [
    ...new Set([...parsedInvites.values()].map((p) => p.workspaceId)),
  ];

  const workspacesById = new Map<
    string,
    { id: string; name: string; userId: string }
  >();

  if (uniqueWorkspaceIds.length > 0) {
    const workspaces = await context.db
      .select({
        id: workspaceTable.id,
        name: workspaceTable.name,
        userId: workspaceTable.userId,
      })
      .from(workspaceTable)
      .where(
        and(
          inArray(workspaceTable.id, uniqueWorkspaceIds),
          eq(workspaceTable.isDeleted, false)
        )
      );

    for (const w of workspaces) {
      workspacesById.set(w.id, w);
    }
  }

  // Resolve project titles for projectTransfer notifications
  const uniqueProjectIds = [
    ...new Set([...parsedTransfers.values()].map((p) => p.projectId)),
  ];

  const projectsById = new Map<string, { id: string; title: string }>();

  if (uniqueProjectIds.length > 0) {
    const projects = await context.db
      .select({ id: projectTable.id, title: projectTable.title })
      .from(projectTable)
      .where(inArray(projectTable.id, uniqueProjectIds));

    for (const p of projects) {
      projectsById.set(p.id, p);
    }
  }

  return notifications.map((n) => {
    const sender = usersById.get(n.senderId);
    const invite = parsedInvites.get(n.id);
    const transfer = parsedTransfers.get(n.id);

    const senderLabel = sender?.username || sender?.email || "Someone";
    const workspaceName = invite
      ? workspacesById.get(invite.workspaceId)?.name
      : undefined;
    const projectTitle = transfer
      ? projectsById.get(transfer.projectId)?.title
      : undefined;

    return {
      id: n.id,
      type: n.type,
      status: n.status,
      payload: n.payload as Record<string, unknown>,
      createdAt: n.createdAt,
      senderEmail: sender?.email ?? "",
      senderName: sender?.username ?? "",
      workspaceName,
      projectTitle,
      description: describeNotification({
        type: n.type,
        senderLabel,
        workspaceName,
        projectTitle,
        invite,
      }),
    };
  });
};

/**
 * Build a human-readable one-liner for a notification.
 *
 * Extracted as a pure function so the popover never needs to know
 * about individual notification types — adding a new type only
 * requires updating this switch.
 */
const describeNotification = ({
  type,
  senderLabel,
  workspaceName,
  projectTitle,
  invite,
}: {
  type: string;
  senderLabel: string;
  workspaceName?: string;
  projectTitle?: string;
  invite?: WorkspaceInvitePayload;
}): string => {
  if (type === "workspaceInvite" && invite) {
    const roleLabel =
      roleLabels[invite.relation]?.toLowerCase() ?? invite.relation;
    return `${senderLabel} invited you to "${workspaceName ?? "a workspace"}" as ${roleLabel}`;
  }

  if (type === "projectTransfer") {
    return `${senderLabel} wants to transfer "${projectTitle ?? "a project"}" to you`;
  }

  return "You have a new notification";
};

export const count = async (context: AppContext) => {
  const userId = assertUser(context);

  return await context.db.$count(
    notificationTable,
    and(eq(notificationTable.recipientId, userId), isLivePending())
  );
};

export const accept = async (
  {
    notificationId,
    targetWorkspaceId,
  }: { notificationId: string; targetWorkspaceId?: string },
  context: AppContext
) => {
  const userId = assertUser(context);

  // Load the notification
  const notifications = await context.db
    .select()
    .from(notificationTable)
    .where(
      and(
        eq(notificationTable.id, notificationId),
        eq(notificationTable.recipientId, userId)
      )
    );

  if (notifications.length !== 1) {
    throw new Error("Notification not found");
  }
  const notification = notifications[0];

  if (notification.status !== "pending") {
    throw new Error("This notification has already been acted on");
  }

  // Check expiration
  const createdAt = new Date(notification.createdAt).getTime();
  if (Date.now() - createdAt > NOTIFICATION_TTL_MS) {
    throw new Error("This invitation has expired");
  }

  // Atomically claim the notification by setting status='accepted'.
  // Only one concurrent accept() call will match the pending row.
  const claim = await context.db
    .update(notificationTable)
    .set({
      status: "accepted" satisfies NotificationStatus,
      respondedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(notificationTable.id, notificationId),
        eq(notificationTable.status, "pending")
      )
    )
    .returning({ id: notificationTable.id });

  if (claim.length === 0) {
    throw new Error("This notification has already been acted on");
  }

  // Revert the status if the side effect below fails, so the user may retry.
  const revertStatus = async () => {
    try {
      await context.db
        .update(notificationTable)
        .set({
          status: "pending" satisfies NotificationStatus,
          respondedAt: null,
        })
        .where(eq(notificationTable.id, notificationId));
    } catch (error) {
      console.error(
        `Failed to revert notification ${notificationId} to pending:`,
        error
      );
    }
  };

  // Auto-decline helper — used when the referenced entity no longer exists.
  // The notification was already claimed (accepted), so we overwrite to declined.
  const autoDecline = async () => {
    await context.db
      .update(notificationTable)
      .set({
        status: "declined" satisfies NotificationStatus,
        respondedAt: new Date().toISOString(),
      })
      .where(eq(notificationTable.id, notificationId));
  };

  // Wrap side effects so every failure path reverts the atomic claim.
  try {
    await performAcceptSideEffect({
      notification,
      userId,
      targetWorkspaceId,
      autoDecline,
      context,
    });
  } catch (error) {
    // Auto-decline errors already set their own status — only revert others.
    if (error instanceof AutoDeclinedError) {
      throw error;
    }
    await revertStatus();
    throw error;
  }
};

/**
 * Sentinel thrown when the notification was auto-declined because the
 * referenced entity (workspace / project) no longer exists.
 */
class AutoDeclinedError extends Error {}

const performAcceptSideEffect = async ({
  notification,
  userId,
  targetWorkspaceId,
  autoDecline,
  context,
}: {
  notification: { type: string; senderId: string; payload: unknown };
  userId: string;
  targetWorkspaceId: string | undefined;
  autoDecline: () => Promise<void>;
  context: AppContext;
}) => {
  if (notification.type === "workspaceInvite") {
    const parseResult = workspaceInvitePayload.safeParse(notification.payload);
    if (parseResult.success === false) {
      throw new Error("Invalid workspace invite payload");
    }
    const parsed = parseResult.data;

    // Verify the workspace still exists
    const workspace = await findLiveWorkspace(parsed.workspaceId, context);

    if (workspace === null) {
      await autoDecline();
      throw new AutoDeclinedError("This workspace no longer exists");
    }

    // Upsert the member — handles re-inviting previously removed members
    await context.db
      .insert(workspaceMember)
      .values({
        workspaceId: parsed.workspaceId,
        userId,
        relation: parsed.relation,
        removedAt: null,
      })
      .onConflictDoUpdate({
        target: [workspaceMember.workspaceId, workspaceMember.userId],
        set: { relation: parsed.relation, removedAt: null },
      });
    return;
  }

  if (notification.type === "projectTransfer") {
    if (userId === notification.senderId) {
      throw new Error("You cannot accept your own transfer request");
    }

    const parseResult = projectTransferPayload.safeParse(notification.payload);
    if (parseResult.success === false) {
      throw new Error("Invalid project transfer payload");
    }
    const parsed = parseResult.data;

    // Verify the project still exists
    const project = maybeOne(
      await context.db
        .select({ id: projectTable.id, userId: projectTable.userId })
        .from(projectTable)
        .where(
          and(
            eq(projectTable.id, parsed.projectId),
            eq(projectTable.isDeleted, false)
          )
        )
    );

    if (project === null) {
      await autoDecline();
      throw new AutoDeclinedError("This project no longer exists");
    }

    // Verify the sender still owns the project
    if (project.userId !== notification.senderId) {
      await autoDecline();
      throw new AutoDeclinedError("The sender no longer owns this project");
    }

    // Check receiver's plan limit before accepting the transfer
    const receiverPlan = await getPlanFeaturesByOwnerId(userId, context);
    const projectCount = await context.db.$count(
      projectTable,
      and(eq(projectTable.userId, userId), eq(projectTable.isDeleted, false))
    );

    if (projectCount >= receiverPlan.maxProjectsAllowedPerUser) {
      throw new Error(
        "You've reached the project limit for your plan. Upgrade or delete projects to accept this transfer."
      );
    }

    // Block transfer if the project has custom domains and the receiver's plan
    // does not include domain support.
    if (receiverPlan.maxDomainsAllowedPerUser === 0) {
      const domainCount = await context.db.$count(
        projectDomain,
        eq(projectDomain.projectId, parsed.projectId)
      );

      if (receiverPlan.maxDomainsAllowedPerUser === 0 && domainCount > 0) {
        throw new Error(
          "This project has custom domains attached. Upgrade your plan to accept projects with custom domains."
        );
      }
    }

    // Determine the target workspace: use the one from the notification payload,
    // or fall back to the one provided by the receiver at accept time.
    const resolvedWorkspaceId = parsed.targetWorkspaceId ?? targetWorkspaceId;

    if (resolvedWorkspaceId !== undefined) {
      // Verify the workspace exists and belongs to the receiver
      const workspace = await findLiveWorkspace(resolvedWorkspaceId, context);

      if (workspace === null) {
        await autoDecline();
        throw new AutoDeclinedError("This workspace no longer exists");
      }

      if (workspace.userId !== userId) {
        throw new AuthorizationError(
          "You can only transfer projects into your own workspaces"
        );
      }

      console.info(
        `Project ownership change (transfer accepted): project=${parsed.projectId} from=${notification.senderId} to=${userId} workspace=${resolvedWorkspaceId}`
      );

      await reassignProject(
        parsed.projectId,
        { userId, workspaceId: resolvedWorkspaceId },
        context
      );
      return;
    }

    // No workspace specified — assign to receiver's default workspace
    const defaultWorkspace = maybeOne(
      await context.db
        .select({ id: workspaceTable.id })
        .from(workspaceTable)
        .where(
          and(
            eq(workspaceTable.userId, userId),
            eq(workspaceTable.isDefault, true),
            eq(workspaceTable.isDeleted, false)
          )
        )
    );

    console.info(
      `Project ownership change (transfer accepted): project=${parsed.projectId} from=${notification.senderId} to=${userId} workspace=${defaultWorkspace?.id ?? "default"}`
    );

    await reassignProject(
      parsed.projectId,
      { userId, workspaceId: defaultWorkspace?.id ?? null },
      context
    );
  }
};

const findLiveWorkspace = async (workspaceId: string, context: AppContext) =>
  maybeOne(
    await context.db
      .select({ id: workspaceTable.id, userId: workspaceTable.userId })
      .from(workspaceTable)
      .where(
        and(
          eq(workspaceTable.id, workspaceId),
          eq(workspaceTable.isDeleted, false)
        )
      )
  );

const reassignProject = async (
  projectId: string,
  owner: { userId: string; workspaceId: string | null },
  context: AppContext
) => {
  try {
    one(
      await context.db
        .update(projectTable)
        .set(owner)
        .where(eq(projectTable.id, projectId))
        .returning({ id: projectTable.id })
    );
  } catch {
    throw new Error("Failed to reassign the project");
  }
};

/** Marks a pending notification declined; `party` limits who may do it. */
const declinePending = async (
  notificationId: string,
  party: SQL,
  context: AppContext
) => {
  // Atomic update — only succeeds if still pending, preventing
  // a race where a concurrent accept() already claimed the row.
  const declined = await context.db
    .update(notificationTable)
    .set({
      status: "declined" satisfies NotificationStatus,
      respondedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(notificationTable.id, notificationId),
        party,
        eq(notificationTable.status, "pending")
      )
    )
    .returning({ id: notificationTable.id });

  if (declined.length === 0) {
    throw new Error("Notification not found or already acted on");
  }
};

export const decline = async (
  { notificationId }: { notificationId: string },
  context: AppContext
) => {
  const userId = assertUser(context);

  await declinePending(
    notificationId,
    eq(notificationTable.recipientId, userId),
    context
  );
};

export const cancel = async (
  { notificationId }: { notificationId: string },
  context: AppContext
) => {
  const userId = assertUser(context);

  await declinePending(
    notificationId,
    eq(notificationTable.senderId, userId),
    context
  );
};

export const __testing__ = { describeNotification };
