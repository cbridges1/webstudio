import { z } from "zod";

const environment = z.object({
  // Authentication
  DEV_LOGIN: z.string().optional(),
  // selfhost: username/password sign-in (Better Auth)
  AUTH_USERNAME_LOGIN: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  GH_CLIENT_ID: z.string().optional(),
  GH_CLIENT_SECRET: z.string().optional(),
  GITHUB_ISSUE_REPORT_APP_ID: z.string().optional(),
  GITHUB_ISSUE_REPORT_PRIVATE_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Secret session key, context encode
  AUTH_SECRET: z.string().optional(),

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

  // Plan definitions for local dev/staging (JSON array of {name, features})
  PLANS: z
    .string()
    .default("[]")
    .refine((val) => {
      try {
        JSON.parse(val);
        return true;
      } catch {
        return false;
      }
    }, "PLANS must be valid JSON"),

  DATABASE_URL: z.string().default("postgresql://localhost:5432/webstudio"),

  // Payment worker configuration
  PAYMENT_WORKER_URL: z.string().optional(),
  PAYMENT_WORKER_TOKEN: z.string().optional(),

  // Used for project oauth login flow
  AUTH_WS_CLIENT_ID: z.string().default("12345"),
  AUTH_WS_CLIENT_SECRET: z.string().default("12345678"),

  // Vercel system variables
  VERCEL: z.string().optional(),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
  VERCEL_URL: z.string().optional(),
});

const rawEnv = {
  DEV_LOGIN: process.env.DEV_LOGIN,
  AUTH_USERNAME_LOGIN: process.env.AUTH_USERNAME_LOGIN,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  GH_CLIENT_ID: process.env.GH_CLIENT_ID,
  GH_CLIENT_SECRET: process.env.GH_CLIENT_SECRET,
  GITHUB_ISSUE_REPORT_APP_ID: process.env.GITHUB_ISSUE_REPORT_APP_ID,
  GITHUB_ISSUE_REPORT_PRIVATE_KEY: process.env.GITHUB_ISSUE_REPORT_PRIVATE_KEY,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  AUTH_SECRET: process.env.AUTH_SECRET,
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
  PLANS: process.env.PLANS,
  DATABASE_URL: process.env.DATABASE_URL,
  PAYMENT_WORKER_URL: process.env.PAYMENT_WORKER_URL,
  PAYMENT_WORKER_TOKEN: process.env.PAYMENT_WORKER_TOKEN,
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

// selfhost: dev login signs anyone in with AUTH_SECRET; never allow it in production.
if (
  env.DEV_LOGIN === "true" &&
  (process.env.NODE_ENV === "production" ||
    env.DEPLOYMENT_ENVIRONMENT === "production")
) {
  throw new Error("DEV_LOGIN must not be enabled in production");
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
