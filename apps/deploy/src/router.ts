// The service the builder calls when TRPC_SERVER_URL is set. Procedure names, inputs and outputs
// mirror upstream's sharedRouter (packages/trpc-interface/src/shared/{deployment,domain}.ts);
// src/contract.test.ts compares them against the Webstudio checkout so upgrades can't drift.
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import type { Publisher } from "./publisher";

const { router, procedure } = initTRPC.create();

// deployment.ts
export const publishInput = z.object({
  buildId: z.string(),
  builderOrigin: z.string(),
  githubSha: z.string().optional(),
  destination: z.enum(["saas", "static"]),
  branchName: z.string(),
  logProjectName: z.string(),
});

export const unpublishInput = z.object({
  domain: z.string(),
});

export const deploymentOutput = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: z.string() }),
]);

// domain.ts
const domainCreateInput = z.object({
  domain: z.string(),
  txtRecord: z.string(),
});
const domainInput = z.object({ domain: z.string() });

const createOutput = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion("success", [
    z.object({ success: z.literal(true), data }),
    z.object({ success: z.literal(false), error: z.string() }),
  ]);

const domainStatus = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["active", "pending"]) }),
  z.object({ status: z.enum(["error"]), error: z.string() }),
]);

export const CUSTOM_DOMAINS_UNSUPPORTED =
  "Custom domains aren't managed here. Point your domain at the deployed site in your hosting provider.";

const unsupported = () => ({
  success: false as const,
  error: CUSTOM_DOMAINS_UNSUPPORTED,
});

export const createRouter = (publisher: Publisher) =>
  router({
    deployment: router({
      publish: procedure
        .input(publishInput)
        .output(deploymentOutput)
        .mutation(({ input }) => publisher.publish(input)),
      unpublish: procedure
        .input(unpublishInput)
        .output(deploymentOutput)
        .mutation(({ input }) => publisher.unpublish(input)),
    }),
    domain: router({
      create: procedure
        .input(domainCreateInput)
        .output(createOutput(z.optional(z.undefined())))
        .mutation(unsupported),
      refresh: procedure
        .input(domainInput)
        .output(createOutput(z.optional(z.undefined())))
        .mutation(unsupported),
      getStatus: procedure
        .input(domainInput)
        .output(createOutput(domainStatus))
        .query(unsupported),
    }),
  });

export type DeployerRouter = ReturnType<typeof createRouter>;
