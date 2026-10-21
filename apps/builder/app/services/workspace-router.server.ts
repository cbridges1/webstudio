import {
  and,
  eq,
  isNull,
  maybeOne,
  notification,
  sql,
  user,
  workspace as workspaceTable,
  workspaceMember,
} from "@webstudio-is/db";
import { z } from "zod";
import {
  router,
  procedure,
  createErrorResponse,
  getPlanFeaturesByOwnerId,
} from "@webstudio-is/trpc-interface/index.server";
import { workspace as workspaceApi } from "@webstudio-is/project/index.server";
import { roles } from "@webstudio-is/trpc-interface/authorize";
import { getExtraPaidSeats } from "@webstudio-is/plans/index.server";
import env from "~/env/env.server";

const name = z.string().min(2).max(100);
const relation = z.enum(roles);

/**
 * Tells the payment worker to count members and adjust Stripe seats.
 * All member-counting and Stripe logic lives in the worker — the builder
 * only passes the workspaceId and an optional delta.
 *
 * @param delta - adjustment to the current member count.
 *   Pass +1 when a member is about to be added (pre-charge before DB insert).
 *   Defaults to 0 (post-removal or manual sync).
 */
const syncSeats = async (workspaceId: string, delta = 0): Promise<void> => {
  if (!env.PAYMENT_WORKER_URL || !env.PAYMENT_WORKER_TOKEN) {
    return;
  }

  const response = await fetch(`${env.PAYMENT_WORKER_URL}/seats/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.PAYMENT_WORKER_TOKEN}`,
    },
    body: JSON.stringify({ workspaceId, delta }),
  });

  if (!response.ok) {
    throw new Error(
      `Payment worker /seats/sync responded with ${response.status}`
    );
  }

  const result = (await response.json()) as {
    type: string;
    error?: string;
  };

  if (result.type === "error") {
    throw new Error(`Payment worker rejected seat sync: ${result.error}`);
  }
};

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
        const { plan } = await workspaceApi.assertWorkspaceOwnerPlan(
          input.workspaceId,
          ctx
        );

        if (plan.maxWorkspaces <= 1) {
          throw new Error("Upgrade your plan to invite members to workspaces.");
        }

        const isDevEnvironment = env.DEPLOYMENT_ENVIRONMENT === "development";
        const hasPaymentWorker =
          env.PAYMENT_WORKER_URL && env.PAYMENT_WORKER_TOKEN;

        if (!hasPaymentWorker && !isDevEnvironment) {
          throw new Error(
            "Adding workspace members requires a configured payment provider."
          );
        }

        const { maxSeatsPerWorkspace } = plan;
        if (maxSeatsPerWorkspace > 0) {
          const [memberCount, pendingCount] = await Promise.all([
            ctx.db.$count(
              workspaceMember,
              and(
                eq(workspaceMember.workspaceId, input.workspaceId),
                isNull(workspaceMember.removedAt)
              )
            ),
            ctx.db.$count(
              notification,
              and(
                eq(notification.type, "workspaceInvite"),
                eq(notification.status, "pending"),
                sql`${notification.payload} ->> 'workspaceId' = ${input.workspaceId}`
              )
            ),
          ]);

          const currentCount = memberCount + pendingCount;
          if (currentCount >= maxSeatsPerWorkspace) {
            throw new Error(
              `This workspace has reached its seat limit of ${maxSeatsPerWorkspace}. Remove a member or upgrade your plan to invite more.`
            );
          }
        }

        // Pre-charge the seat before adding the member (Figma model).
        // We validate user existence first so that a missing account never
        // triggers a billing change.
        // When the payment worker is configured, a billing failure aborts the
        // invite so the member is never added. When the worker URL is not set
        // (self-hosted / dev), syncSeats returns early and this is a no-op.

        // Validate the invitee exists and is not already a member before
        // touching billing. This mirrors the checks in workspaceApi.addMember
        // so that we never charge for a doomed invite.
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

        try {
          await syncSeats(input.workspaceId, +1);
        } catch (error) {
          const technical =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `Unable to update billing. Please try again or contact support. (${technical})`
          );
        }

        const { notificationId } = await workspaceApi.addMember(input, ctx);

        return { success: true as const, notificationId };
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
        const { plan } = await workspaceApi.assertWorkspaceOwnerPlan(
          input.workspaceId,
          ctx
        );

        if (plan.maxWorkspaces <= 1) {
          throw new Error(
            "Upgrade your plan to manage workspace member roles."
          );
        }
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
        await syncSeats(input.workspaceId);

        return { success: true as const };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  syncSeats: procedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const { plan } = await workspaceApi.assertWorkspaceOwnerPlan(
          input.workspaceId,
          ctx
        );

        if (plan.maxWorkspaces <= 1) {
          throw new Error("Upgrade your plan to manage workspace seats.");
        }
        await syncSeats(input.workspaceId);
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
        const [ownerPlan, extraPaidSeats] = await Promise.all([
          getPlanFeaturesByOwnerId(members.owner.userId, ctx),
          getExtraPaidSeats(members.owner.userId, ctx),
        ]);
        return {
          success: true as const,
          data: {
            ...members,
            // seatsIncluded = seats covered by the Team plan.
            // extraPaidSeats = extra seats from the Seats subscription.
            // Total capacity = included + extras.
            maxSeats: ownerPlan.seatsIncluded + (extraPaidSeats ?? 0),
          },
        };
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
        const targetWorkspace = maybeOne(
          await ctx.db
            .select({ userId: workspaceTable.userId })
            .from(workspaceTable)
            .where(
              and(
                eq(workspaceTable.id, input.targetWorkspaceId),
                eq(workspaceTable.isDeleted, false)
              )
            )
        );

        if (targetWorkspace === null) {
          throw new Error("Target workspace not found");
        }

        const ownerPlan = await getPlanFeaturesByOwnerId(
          targetWorkspace.userId,
          ctx
        );

        if (ownerPlan.maxWorkspaces <= 1) {
          throw new Error(
            "Upgrade your plan to move projects between workspaces."
          );
        }
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
