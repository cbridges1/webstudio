// selfhost: workspace deployers and project deploy targets (deployers.server.ts).
import { z } from "zod";
import {
  createErrorResponse,
  procedure,
  router,
} from "@webstudio-is/trpc-interface/index.server";
import {
  checkDeployer,
  createDeployer,
  deployerInput,
  listDeployerHosts,
  listDeployers,
  loadProjectDeploySettings,
  projectTargetInput,
  removeDeployer,
  setProjectDeployTarget,
  updateDeployer,
} from "./deployers.server";

const apiKey = z.string().trim().min(1, "Enter the deployer's API key");

const respond = async <T>(run: () => Promise<T>) => {
  try {
    return { success: true as const, data: await run() };
  } catch (error) {
    return createErrorResponse(error);
  }
};

export const deployersRouter = router({
  list: procedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ input, ctx }) => respond(() => listDeployers(input, ctx))),

  create: procedure
    .input(deployerInput.extend({ workspaceId: z.string(), apiKey }))
    .mutation(({ input, ctx }) => respond(() => createDeployer(input, ctx))),

  update: procedure
    .input(
      deployerInput.extend({
        deployerId: z.string(),
        apiKey: z.string().trim().optional(),
      })
    )
    .mutation(({ input, ctx }) => respond(() => updateDeployer(input, ctx))),

  remove: procedure
    .input(z.object({ deployerId: z.string() }))
    .mutation(({ input, ctx }) => respond(() => removeDeployer(input, ctx))),

  check: procedure
    .input(z.object({ deployerId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await checkDeployer(input, ctx);
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  projectSettings: procedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input, ctx }) =>
      respond(() => loadProjectDeploySettings(input, ctx))
    ),

  projectHosts: procedure
    .input(z.object({ projectId: z.string(), deployerId: z.string() }))
    .query(async ({ input, ctx }) => {
      try {
        return await listDeployerHosts(input, ctx);
      } catch (error) {
        return createErrorResponse(error);
      }
    }),

  setProjectTarget: procedure
    .input(
      z.object({ projectId: z.string(), target: projectTargetInput.nullable() })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await setProjectDeployTarget(input, ctx);
      } catch (error) {
        return createErrorResponse(error);
      }
    }),
});
