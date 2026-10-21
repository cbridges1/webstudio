import * as projectApi from "../db/project";
import { z } from "zod";
import {
  router,
  procedure,
  AuthorizationError,
  authorizeProject,
  createErrorResponse,
  getPlanFeaturesByOwnerId,
  getProjectOwnerId,
} from "@webstudio-is/trpc-interface/index.server";
import { defaultPlanFeatures } from "@webstudio-is/plans";
import { getExtraPaidSeats } from "@webstudio-is/plans/index.server";
import { projectTitle } from "../shared/project-schema";
import { marketplaceApprovalStatus } from "../shared/marketplace-schema";
import {
  and,
  build,
  eq,
  isNull,
  maybeOne,
  publishedBuilds,
  userPublishCount,
  type Db,
} from "@webstudio-is/db";

export const projectRouter = router({
  rename: procedure
    .input(
      z.object({
        title: projectTitle,
        projectId: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      return await projectApi.rename(input, ctx);
    }),

  delete: procedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      return await projectApi.markAsDeleted(input.projectId, ctx);
    }),

  clone: procedure
    .input(
      z.object({
        projectId: z.string(),
        title: z.optional(z.string()),
        authToken: z.optional(z.string()),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const sourceContext = input.authToken
        ? await ctx.createTokenContext(input.authToken)
        : ctx;
      return await projectApi.clone(input, ctx, sourceContext);
    }),

  create: procedure
    .input(
      z.object({ title: projectTitle, workspaceId: z.string().optional() })
    )
    .mutation(async ({ input, ctx }) => {
      return await projectApi.create(input, ctx);
    }),

  setMarketplaceApprovalStatus: procedure
    .input(
      z.object({
        projectId: z.string(),
        marketplaceApprovalStatus: marketplaceApprovalStatus,
      })
    )
    .mutation(async ({ input, ctx }) => {
      return await projectApi.setMarketplaceApprovalStatus(input, ctx);
    }),

  updateTags: procedure
    .input(
      z.object({
        projectId: z.string(),
        tags: z.array(z.string()),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await projectApi.updateProjectTags(input, ctx);
    }),

  findCurrentUserProjectIds: procedure.query(async ({ ctx }) => {
    if (ctx.authorization.type !== "user") {
      return [];
    }
    const projectIds = await projectApi.findProjectIdsByUserId(
      ctx.authorization.userId,
      ctx
    );
    return projectIds.map((project) => project.id);
  }),

  userPublishCount: procedure
    .input(z.object({ projectId: z.string() }).optional())
    .query(async ({ input, ctx }) => {
      try {
        if (
          ctx.authorization.type !== "user" &&
          ctx.authorization.type !== "token"
        ) {
          throw new Error("Not authorized");
        }
        const userId =
          ctx.authorization.type === "user"
            ? ctx.authorization.userId
            : ctx.authorization.ownerId;

        let ownerId = userId;
        let limit: number | undefined;

        if (input?.projectId !== undefined) {
          const canView = await authorizeProject.hasProjectPermit(
            { projectId: input.projectId, permit: "view" },
            ctx
          );

          if (canView === false) {
            throw new AuthorizationError(
              "Not authorized to access this project"
            );
          }

          ownerId = await getProjectOwnerId(input.projectId, ctx);
          const plan = await getPlanFeaturesByOwnerId(ownerId, ctx);
          limit = plan.maxDailyPublishesPerUser;
          if (limit > defaultPlanFeatures.maxDailyPublishesPerUser) {
            const extraSeats = await getExtraPaidSeats(ownerId, ctx);
            limit *= 1 + plan.seatsIncluded + (extraSeats ?? 0);
          }
        }

        const result = maybeOne(
          await ctx.db
            .select({ count: userPublishCount.count })
            .from(userPublishCount)
            .where(eq(userPublishCount.user_id, ownerId))
        );
        const count = result?.count ?? 0;
        if (limit === undefined) {
          return { success: true, data: count };
        }
        return { success: true, data: count, limit };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  publishedBuilds: procedure
    .input(
      z.object({
        projectId: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        if (
          ctx.authorization.type !== "user" &&
          ctx.authorization.type !== "token"
        ) {
          throw new AuthorizationError("Not authorized");
        }
        const permit = await authorizeProject.getProjectPermit(
          {
            projectId: input.projectId,
            permits: ["view", "build", "admin"],
          },
          ctx
        );
        if (permit === undefined) {
          throw new AuthorizationError("Not authorized to access this project");
        }
        return {
          success: true,
          data: await ctx.db
            .select()
            .from(publishedBuilds)
            .where(eq(publishedBuilds.projectId, input.projectId)),
        };
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  restoreDevelopmentBuild: procedure
    .input(
      z.object({
        projectId: z.string(),
        fromBuildId: z.string(),
      })
    )
    .mutation(
      async ({
        input,
        ctx,
      }): Promise<{ success: true } | { success: false; error: string }> => {
        try {
          const permit = await authorizeProject.getProjectPermit(
            {
              projectId: input.projectId,
              permits: ["build", "admin"],
            },
            ctx
          );
          if (!permit) {
            throw new AuthorizationError("Not authorized");
          }
          await restoreDevelopmentBuild(ctx.db, input);
          return {
            success: true,
          };
        } catch (error) {
          return createErrorResponse(error);
        }
      }
    ),
});

export type ProjectRouter = typeof projectRouter;

/** Replaces the development build's content with a copy of another build's. */
const restoreDevelopmentBuild = async (
  db: Db,
  input: { projectId: string; fromBuildId: string }
) => {
  await db.transaction(async (tx) => {
    const source = maybeOne(
      await tx
        .select({
          version: build.version,
          lastTransactionId: build.lastTransactionId,
          pages: build.pages,
          breakpoints: build.breakpoints,
          styles: build.styles,
          styleSources: build.styleSources,
          styleSourceSelections: build.styleSourceSelections,
          props: build.props,
          dataSources: build.dataSources,
          resources: build.resources,
          instances: build.instances,
          marketplaceProduct: build.marketplaceProduct,
          projectSettings: build.projectSettings,
        })
        .from(build)
        .where(
          and(
            eq(build.projectId, input.projectId),
            eq(build.id, input.fromBuildId)
          )
        )
    );
    if (source === null) {
      return;
    }
    await tx
      .update(build)
      .set(source)
      .where(
        and(eq(build.projectId, input.projectId), isNull(build.deployment))
      );
  });
};
