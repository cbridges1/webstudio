import {
  and,
  eq,
  isNull,
  maybeOne,
  user,
  workspace,
  workspaceMember,
} from "@webstudio-is/db";
import { z } from "zod";
import {
  router,
  procedure,
  createErrorResponse,
} from "@webstudio-is/trpc-interface/index.server";
import { workspace as workspaceApi } from "@webstudio-is/project/index.server";
import { roles } from "@webstudio-is/trpc-interface/authorize";
import {
  isEmailEnabled,
  sendEmail,
  workspaceInviteEmail,
} from "./email.server";

/** selfhost: tells the invitee by email when email is set up. Never fails the invite. */
const emailInvite = async (
  { workspaceId, email }: { workspaceId: string; email: string },
  ctx: { db: Parameters<typeof isEmailEnabled>[0]; inviterId?: string }
) => {
  if ((await isEmailEnabled(ctx.db)) === false) {
    return false;
  }
  const target = maybeOne(
    await ctx.db
      .select({ name: workspace.name })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
  );
  const inviter =
    ctx.inviterId === undefined
      ? null
      : maybeOne(
          await ctx.db
            .select({ username: user.username, email: user.email })
            .from(user)
            .where(eq(user.id, ctx.inviterId))
        );
  const result = await sendEmail(
    ctx.db,
    workspaceInviteEmail({
      to: email,
      inviter: inviter?.username ?? inviter?.email ?? "Someone",
      workspaceName: target?.name ?? "a workspace",
    })
  );
  return result.sent;
};

const name = z.string().min(2).max(100);
const relation = z.enum(roles);

// selfhost: no plans or billing, so membership and moves have no plan checks
// and seats are never charged.
export const workspaceRouter = router({
  create: procedure
    .input(z.object({ name: name }))
    .mutation(async ({ input, ctx }) => {
      try {
        const workspace = await workspaceApi.create(
          { ...input, maxWorkspaces: ctx.planFeatures.maxWorkspaces },
          ctx
        );
        return { success: true as const, data: workspace };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  rename: procedure
    .input(z.object({ workspaceId: z.string(), name: name }))
    .mutation(async ({ input, ctx }) => {
      try {
        const workspace = await workspaceApi.rename(input, ctx);
        return { success: true as const, data: workspace };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  delete: procedure
    .input(
      z.object({
        workspaceId: z.string(),
        deleteProjects: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await workspaceApi.remove(input, ctx);
        return { success: true as const };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  list: procedure.query(async ({ ctx }) => {
    try {
      if (ctx.authorization.type !== "user") {
        return { success: true as const, data: [] };
      }
      const workspaces = await workspaceApi.findMany(
        ctx.authorization.userId,
        ctx
      );
      return { success: true as const, data: workspaces };
    } catch (error) {
      return createErrorResponse(error);
    }
  }),

  addMember: procedure
    .input(
      z.object({
        workspaceId: z.string(),
        email: z.string().email(),
        relation: relation,
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await workspaceApi.assertWorkspaceOwner(input.workspaceId, ctx);

        // Give clear errors for a missing account or an existing member.
        const invitee = maybeOne(
          await ctx.db
            .select({ id: user.id })
            .from(user)
            .where(eq(user.email, input.email))
        );
        if (invitee === null) {
          throw new Error(
            "No Webstudio account found. The user needs to sign up first."
          );
        }
        const existingMember = maybeOne(
          await ctx.db
            .select({ userId: workspaceMember.userId })
            .from(workspaceMember)
            .where(
              and(
                eq(workspaceMember.workspaceId, input.workspaceId),
                eq(workspaceMember.userId, invitee.id),
                isNull(workspaceMember.removedAt)
              )
            )
        );
        if (existingMember !== null) {
          throw new Error("Already a member of this workspace.");
        }

        const { notificationId } = await workspaceApi.addMember(input, ctx);
        const emailed = await emailInvite(input, {
          db: ctx.db,
          inviterId:
            ctx.authorization.type === "user"
              ? ctx.authorization.userId
              : undefined,
        }).catch((error) => {
          console.warn(`Invite email not sent: ${String(error)}`);
          return false;
        });

        return { success: true as const, notificationId, emailed };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  updateRole: procedure
    .input(
      z.object({
        workspaceId: z.string(),
        memberUserId: z.string(),
        relation: relation,
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await workspaceApi.assertWorkspaceOwner(input.workspaceId, ctx);
        await workspaceApi.updateRole(input, ctx);
        return { success: true as const };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  removeMember: procedure
    .input(z.object({ workspaceId: z.string(), memberUserId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        await workspaceApi.removeMember(input, ctx);
        return { success: true as const };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  listMembers: procedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input, ctx }) => {
      try {
        const members = await workspaceApi.listMembers(input, ctx);
        return { success: true as const, data: members };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  moveProject: procedure
    .input(
      z.object({
        projectId: z.string(),
        targetWorkspaceId: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await workspaceApi.moveProject(input, ctx);
        return { success: true as const };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  transferProject: procedure
    .input(
      z.object({
        projectId: z.string(),
        recipientEmail: z.string().email(),
        targetWorkspaceId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await workspaceApi.transferProject(input, ctx);
        return { success: true as const };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  findSharedWorkspacesByOwnerEmail: procedure
    .input(z.object({ email: z.string().email() }))
    .query(async ({ input, ctx }) => {
      try {
        const workspaces = await workspaceApi.findSharedWorkspacesByOwnerEmail(
          input,
          ctx
        );
        return { success: true as const, data: workspaces };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),
});

export type WorkspaceRouter = typeof workspaceRouter;
