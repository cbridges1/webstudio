import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

// This service lives in the checkout at apps/deploy.
const checkoutDir = join(import.meta.dirname, "../../..");

const optional = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional()
  );

const schema = z.object({
  // The builder's database: the job queue, projects' targets and their encrypted credentials.
  // Use a direct connection (on Neon, the connection string without "-pooler"): poolers in
  // transaction mode never deliver the notifications this service LISTENs for. Use a login
  // that can only do what this service needs (see the README).
  DATABASE_URL: z.string().min(1, "set it to the builder's database"),
  // The key projects' credentials are encrypted with (the builder's DEPLOY_CREDENTIALS_KEY).
  // Without it, only hosts that need no credentials work.
  DEPLOY_CREDENTIALS_KEY: optional(z.string()),
  // How often to look for jobs besides notifications (and mark this service as running).
  DEPLOY_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  // Names this service in the builder's database. Default: the host name.
  DEPLOY_WORKER_ID: optional(z.string()),
  // Takes only this queue's jobs: the builder's DEPLOYER_QUEUE. For builders sharing a database
  // whose deploy services can each reach only their own builder.
  DEPLOY_QUEUE: z.string().min(1).default("default"),
  // Required on POST /wake when set.
  DEPLOY_WAKE_TOKEN: optional(z.string()),

  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3001),

  // The Webstudio checkout whose CLI and packages build the sites: by default the one this
  // service is in, so it always matches the builder.
  WEBSTUDIO_DIR: z.string().default(checkoutDir),
  DEPLOYER_DATA_DIR: z.string().default(".data"),
  // Root for the "directory" host (one folder per site). Unset: that host is off.
  DEPLOY_SITES_DIR: optional(z.string()),

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
  workerId: string;
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
    DEPLOY_SITES_DIR:
      env.DEPLOY_SITES_DIR === undefined
        ? undefined
        : resolve(env.DEPLOY_SITES_DIR),
    workerId: env.DEPLOY_WORKER_ID ?? hostname(),
    jobsDir: resolve(dataDir, "jobs"),
    logsDir: resolve(dataDir, "logs"),
  };
};

/** Neon's pooled host: LISTEN goes through but notifications never arrive. */
export const isPooledNeonUrl = (url: string) => {
  try {
    return new URL(url).hostname.split(".")[0].endsWith("-pooler");
  } catch {
    return false;
  }
};
