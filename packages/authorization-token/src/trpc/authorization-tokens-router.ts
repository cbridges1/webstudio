import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  PlanRequiredError,
  router,
  procedure,
} from "@webstudio-is/trpc-interface/index.server";
import { db } from "../db";
import type { IsEqual } from "type-fest";
import { eq, project as projectTable, type Database } from "@webstudio-is/db";

type Relation =
  Database["public"]["Tables"]["AuthorizationToken"]["Row"]["relation"];

const tokenProjectRelation = z.enum([
  "viewers",
  "editors",
  "builders",
  "administrators",
]);

// Check DB types are compatible with zod types
type TokenRelation = z.infer<typeof tokenProjectRelation>;
true satisfies IsEqual<TokenRelation, Relation>;

const toTrpcError = (error: unknown): never => {
  if (error instanceof PlanRequiredError) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: error.message,
      cause: error,
    });
  }
  throw error;
};

export const authorizationTokenRouter = router({
  findMany: procedure
    .input(
      z.object({
        projectId: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      return await db.findMany(input, ctx);
    }),
  create: procedure
    .input(
      z.object({
        projectId: z.string(),
        relation: tokenProjectRelation,
        name: z.string(),
        canUseApi: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await db.create(input, ctx);
      } catch (error) {
        toTrpcError(error);
      }
    }),
  agentToken: procedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        const token = await db.findOrCreateAgentToken(input, ctx);
        const [project] = await ctx.db
          .select({ domain: projectTable.domain })
          .from(projectTable)
          .where(eq(projectTable.id, input.projectId));
        return {
          token: token.token,
          name: token.name,
          // A folder name for the agent's copy of the project.
          folder: project?.domain ?? "webstudio-project",
        };
      } catch (error) {
        toTrpcError(error);
      }
    }),
  remove: procedure
    .input(
      z.object({
        projectId: z.string(),
        token: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      return await db.remove(input, ctx);
    }),
  update: procedure
    .input(
      z.object({
        projectId: z.string(),
        token: z.string(),
        name: z.string(),
        relation: tokenProjectRelation,
        canClone: z.boolean(),
        canCopy: z.boolean(),
        canPublish: z.boolean(),
        canUseApi: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { projectId, ...token } = input;
      try {
        return await db.update(projectId, token, ctx);
      } catch (error) {
        toTrpcError(error);
      }
    }),
});

export type AuthorizationTokensRouter = typeof authorizationTokenRouter;
