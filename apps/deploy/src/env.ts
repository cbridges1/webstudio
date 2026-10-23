import { join, resolve } from "node:path";
import { z } from "zod";

// This service lives in the checkout at apps/deploy.
const checkoutDir = join(import.meta.dirname, "../../..");

const schema = z.object({
  // Shared with the builder: it sends this in `Authorization`, and we send it back when
  // fetching build bundles.
  TRPC_SERVER_API_TOKEN: z.string().min(32, "use at least 32 characters"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3001),

  // The builder's database (same as its DATABASE_URL).
  DATABASE_URL: z.string().url(),

  // The builder's private address for `webstudio sync` (e.g. http://builder:3000). Unset: the
  // public origin the builder sends with each publish.
  BUILDER_INTERNAL_URL: z.string().url().optional(),

  // Must match the builder's: unpublish sends `<project.domain>.<PUBLISHER_HOST>`.
  PUBLISHER_HOST: z.string().default("wstd.work"),

  // The Webstudio checkout whose CLI and packages build the sites: by default the one this
  // service is in, so it always matches the builder.
  WEBSTUDIO_DIR: z.string().default(checkoutDir),
  DEPLOYER_DATA_DIR: z.string().default(".data"),
  DEPLOY_CONFIG: z.string().default("deploy-targets.json"),
  DEPLOY_CREDENTIALS_DIR: z.string().default("credentials"),

  JOB_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  KEEP_FAILED_WORKDIRS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type Env = z.infer<typeof schema> & {
  jobsDir: string;
  logsDir: string;
};

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const result = schema.safeParse(source);
  if (result.success === false) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid deployer environment:\n${problems}`);
  }
  const env = result.data;
  const dataDir = resolve(env.DEPLOYER_DATA_DIR);
  return {
    ...env,
    WEBSTUDIO_DIR: resolve(env.WEBSTUDIO_DIR),
    DEPLOYER_DATA_DIR: dataDir,
    DEPLOY_CONFIG: resolve(env.DEPLOY_CONFIG),
    DEPLOY_CREDENTIALS_DIR: resolve(env.DEPLOY_CREDENTIALS_DIR),
    jobsDir: resolve(dataDir, "jobs"),
    logsDir: resolve(dataDir, "logs"),
  };
};
