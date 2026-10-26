import { z } from "zod";

/** An unset or empty variable is undefined. */
const optional = <Schema extends z.ZodTypeAny>(schema: Schema) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional()
  );

const environment = z.object({
  // Authentication
  // selfhost: username/password sign-in (Better Auth)
  AUTH_USERNAME_LOGIN: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  // "false" turns off the sign-in rate limit (e2e runs only; refused in production).
  AUTH_RATE_LIMIT: z.string().optional(),
  GH_CLIENT_ID: z.string().optional(),
  GH_CLIENT_SECRET: z.string().optional(),
  GITHUB_ISSUE_REPORT_APP_ID: z.string().optional(),
  GITHUB_ISSUE_REPORT_PRIVATE_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Secret session key, context encode
  AUTH_SECRET: z.string().optional(),
  // selfhost: encrypts projects' deploy credentials; deployers that read them share it.
  DEPLOY_CREDENTIALS_KEY: z.string().optional(),
  // selfhost: email (workspace invites, password resets) over SMTP. SMTP_HOST set replaces what
  // an app admin sets in the dashboard (Settings → Email), which then can't be changed
  // there. Unset everywhere: the builder sends no email.
  SMTP_HOST: optional(z.string()),
  // Default 587, or 465 with SMTP_SECURE=true.
  SMTP_PORT: optional(z.coerce.number().int().positive()),
  // "true": TLS from the start (usually port 465); otherwise STARTTLS when offered.
  SMTP_SECURE: optional(z.enum(["true", "false"])),
  SMTP_USER: optional(z.string()),
  SMTP_PASSWORD: optional(z.string()),
  // The From address, e.g. "Webstudio <noreply@example.com>". Required with SMTP_HOST.
  SMTP_FROM: optional(z.string()),

  // selfhost: how the builder reaches the deploy service, which takes jobs from the database.
  // Any of these set replaces what an app admin sets in the dashboard (Settings →
  // Deployer), which then can't be changed there.
  // POSTed to whenever a job is queued, e.g. to start a stopped deploy service (optional).
  DEPLOYER_WAKE_URL: optional(z.string().url()),
  // Sent as `Authorization: Bearer <token>` to the wake URL (optional).
  DEPLOYER_WAKE_TOKEN: optional(z.string()),
  // The builder's address as the deploy service reaches it (default: the builder's origin).
  DEPLOYER_BUILDER_URL: optional(z.string().url()),
  // The job queue its deploy services take from (their DEPLOY_QUEUE; default "default"), for
  // builders sharing a database whose deploy services can each reach only their own builder.
  DEPLOYER_QUEUE: optional(z.string()),
  // How publishes run: "separate" (default), a deploy service (apps/deploy) running on its own;
  // "builtin", this builder runs the deploy service's worker itself, so nothing else needs to
  // be deployed. An app admin can override it in Settings → Deployer.
  DEPLOYER_MODE: optional(z.enum(["separate", "builtin"])),
  // builtin: where builds are made and their logs kept (default: a folder in the system's
  // temporary directory).
  DEPLOYER_DATA_DIR: optional(z.string()),
  // builtin: the root folder of the "directory" host (one folder per site); unset, it's off.
  DEPLOY_SITES_DIR: optional(z.string()),

  // DEPLOYMENT_ENVIRONMENT development | preview | production
  DEPLOYMENT_ENVIRONMENT: z
    .enum(["development", "preview", "production"])
    .optional(),
  DEPLOYMENT_URL: z.string().url().optional(),

  // Trpc on SaaS
  TRPC_SERVER_URL: z.string().url().optional(),
  TRPC_SERVER_API_TOKEN: z.string().optional(),

  PORT: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : undefined)),

  // Assets
  MAX_UPLOAD_SIZE: z.string().optional(),

  // Remote assets
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACL: z.string().optional(),

  // Origin for /cdn-cgi/image/ cloudflare endpoint (without ending slash)
  RESIZE_ORIGIN: z.string().url().optional(),

  // Entri API credentials
  ENTRI_APPLICATION_ID: z.string().default("webstudio"),
  ENTRI_SECRET: z.string().optional(),

  PUBLISHER_HOST: z.string().default("wstd.work"),

  STAGING_USERNAME: z.string().default("admin"),
  STAGING_PASSWORD: z.string().default("webstudio"),

  FEATURE_FLAGS: z.string().default(""),

  DATABASE_URL: z.string().default("postgresql://localhost:5432/webstudio"),

  // Used for project oauth login flow
  AUTH_WS_CLIENT_ID: z.string().default("12345"),
  AUTH_WS_CLIENT_SECRET: z.string().default("12345678"),

  // Vercel system variables
  VERCEL: z.string().optional(),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  VERCEL_URL: z.string().optional(),
});

const rawEnv = {
  AUTH_USERNAME_LOGIN: process.env.AUTH_USERNAME_LOGIN,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  AUTH_RATE_LIMIT: process.env.AUTH_RATE_LIMIT,
  GH_CLIENT_ID: process.env.GH_CLIENT_ID,
  GH_CLIENT_SECRET: process.env.GH_CLIENT_SECRET,
  GITHUB_ISSUE_REPORT_APP_ID: process.env.GITHUB_ISSUE_REPORT_APP_ID,
  GITHUB_ISSUE_REPORT_PRIVATE_KEY: process.env.GITHUB_ISSUE_REPORT_PRIVATE_KEY,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  AUTH_SECRET: process.env.AUTH_SECRET,
  DEPLOY_CREDENTIALS_KEY: process.env.DEPLOY_CREDENTIALS_KEY,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_SECURE: process.env.SMTP_SECURE,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  SMTP_FROM: process.env.SMTP_FROM,
  DEPLOYER_WAKE_URL: process.env.DEPLOYER_WAKE_URL,
  DEPLOYER_WAKE_TOKEN: process.env.DEPLOYER_WAKE_TOKEN,
  DEPLOYER_BUILDER_URL: process.env.DEPLOYER_BUILDER_URL,
  DEPLOYER_QUEUE: process.env.DEPLOYER_QUEUE,
  DEPLOYER_MODE: process.env.DEPLOYER_MODE,
  DEPLOYER_DATA_DIR: process.env.DEPLOYER_DATA_DIR,
  DEPLOY_SITES_DIR: process.env.DEPLOY_SITES_DIR,
  DEPLOYMENT_ENVIRONMENT: process.env.DEPLOYMENT_ENVIRONMENT,
  DEPLOYMENT_URL: process.env.DEPLOYMENT_URL,
  TRPC_SERVER_URL: process.env.TRPC_SERVER_URL,
  TRPC_SERVER_API_TOKEN: process.env.TRPC_SERVER_API_TOKEN,
  PORT: process.env.PORT,
  MAX_UPLOAD_SIZE: process.env.MAX_UPLOAD_SIZE,
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_REGION: process.env.S3_REGION,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  S3_BUCKET: process.env.S3_BUCKET,
  S3_ACL: process.env.S3_ACL,
  RESIZE_ORIGIN: process.env.RESIZE_ORIGIN,
  ENTRI_APPLICATION_ID: process.env.ENTRI_APPLICATION_ID,
  ENTRI_SECRET: process.env.ENTRI_SECRET,
  PUBLISHER_HOST: process.env.PUBLISHER_HOST,
  STAGING_USERNAME: process.env.STAGING_USERNAME,
  STAGING_PASSWORD: process.env.STAGING_PASSWORD,
  FEATURE_FLAGS: process.env.FEATURE_FLAGS,
  DATABASE_URL: process.env.DATABASE_URL,
  AUTH_WS_CLIENT_ID: process.env.AUTH_WS_CLIENT_ID,
  AUTH_WS_CLIENT_SECRET: process.env.AUTH_WS_CLIENT_SECRET,
  VERCEL: process.env.VERCEL,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_URL: process.env.VERCEL_URL,
};

const parseResult = environment.safeParse(rawEnv);

if (!parseResult.success) {
  console.error("Invalid environment variables:", parseResult.error.format());
  throw new Error(
    `Environment validation failed: ${parseResult.error.message}`
  );
}

const env = {
  ...parseResult.data,
  SECURE_COOKIE: true,
};

// Reject default OAuth secrets in production.
if (
  env.DEPLOYMENT_ENVIRONMENT === "production" &&
  (env.AUTH_WS_CLIENT_ID === "12345" ||
    env.AUTH_WS_CLIENT_SECRET === "12345678")
) {
  throw new Error(
    "AUTH_WS_CLIENT_ID and AUTH_WS_CLIENT_SECRET must be set in production"
  );
}

// selfhost: Better Auth signs its tokens with BETTER_AUTH_SECRET.
if (
  env.AUTH_USERNAME_LOGIN === "true" &&
  (process.env.NODE_ENV === "production" ||
    env.DEPLOYMENT_ENVIRONMENT === "production") &&
  (env.BETTER_AUTH_SECRET === undefined || env.BETTER_AUTH_SECRET.length < 32)
) {
  throw new Error(
    "BETTER_AUTH_SECRET (32+ characters) must be set to use username sign-in in production"
  );
}

// selfhost: e2e runs (a production build) sign in far more often than the rate limit
// allows, so only a production deployment refuses to turn it off.
if (env.AUTH_RATE_LIMIT === "false") {
  if (env.DEPLOYMENT_ENVIRONMENT === "production") {
    throw new Error("AUTH_RATE_LIMIT=false must not be used in production");
  }
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "AUTH_RATE_LIMIT=false: sign-in attempts are not rate-limited"
    );
  }
}

// selfhost: mail needs a sender.
if (env.SMTP_HOST !== undefined && env.SMTP_FROM === undefined) {
  throw new Error("SMTP_FROM must be set with SMTP_HOST");
}

export type ServerEnv = typeof env;

// https://vercel.com/docs/concepts/projects/environment-variables#system-environment-variables
if (process.env.VERCEL !== undefined) {
  if (env.DEPLOYMENT_ENVIRONMENT === undefined) {
    env.DEPLOYMENT_ENVIRONMENT = process.env.VERCEL_ENV as
      | "development"
      | "preview"
      | "production"
      | undefined;
  }
  if (env.DEPLOYMENT_URL === undefined) {
    env.DEPLOYMENT_URL = process.env.VERCEL_URL;
  }
}

export default env;
