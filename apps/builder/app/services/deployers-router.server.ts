// selfhost: the deploy service settings and project deploy targets (deployers.server.ts).
import { z } from "zod";
import {
  createErrorResponse,
  procedure,
  router,
} from "@webstudio-is/trpc-interface/index.server";
import {
  checkDeployer,
  deployerInput,
  listDeployerHosts,
  loadDeployerSettings,
  loadProjectDeploySettings,
  projectTargetInput,
  saveDeployer,
  setProjectDeployTarget,
} from "./deployers.server";

const respond = async <T>(run: () => Promise<T>) => {
  try {
    return { success: true as const, data: await run() };
  } catch (error) {
    return createErrorResponse(error);
  }
};

export const deployerRouter = router({
  settings: procedure.query(({ ctx }) =>
    respond(() => loadDeployerSettings(ctx))
  ),

  save: procedure
    .input(deployerInput)
    .mutation(({ input, ctx }) => respond(() => saveDeployer(input, ctx))),

  check: procedure.mutation(({ ctx }) => respond(() => checkDeployer(ctx))),

  projectSettings: procedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input, ctx }) =>
      respond(() => loadProjectDeploySettings(input, ctx))
    ),

  projectHosts: procedure
    .input(z.object({ projectId: z.string() }))
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
