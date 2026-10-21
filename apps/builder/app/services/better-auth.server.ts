// selfhost: username/password sign-in with Better Auth.
//
// Better Auth only checks credentials (and rate-limits attempts). The builder's own
// cookie session (remix-auth) stays the only session the app uses, so the builder
// subdomain hop and logout work as upstream wrote them. Better Auth's HTTP handler is
// never routed: the builder calls it in-process for sign-in, and the account script
// uses its server API.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, username } from "better-auth/plugins";
import {
  authAccount,
  authRateLimit,
  authSession,
  authVerification,
  user,
  type Db,
} from "@webstudio-is/db";

export const minPasswordLength = 12;
export const maxPasswordLength = 128;

const basePath = "/api/auth";

export const createBetterAuth = ({
  db,
  secret,
  baseURL,
}: {
  db: Db;
  secret: string;
  /** The builder's public origin. */
  baseURL: string;
}) =>
  betterAuth({
    secret,
    baseURL,
    basePath,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        User: user,
        AuthSession: authSession,
        AuthAccount: authAccount,
        AuthVerification: authVerification,
        AuthRateLimit: authRateLimit,
      },
    }),
    // One user table: Better Auth's users are Webstudio's users.
    user: { modelName: "User", fields: { name: "username" } },
    session: { modelName: "AuthSession" },
    account: { modelName: "AuthAccount" },
    verification: { modelName: "AuthVerification" },
    emailAndPassword: {
      // Required by the username plugin; email sign-in itself is disabled below.
      enabled: true,
      // Accounts come from the account script only.
      disableSignUp: true,
      minPasswordLength,
      maxPasswordLength,
    },
    plugins: [
      username({
        minUsernameLength: 3,
        maxUsernameLength: 32,
        schema: { user: { fields: { username: "loginName" } } },
      }),
      admin(),
    ],
    disabledPaths: ["/sign-in/email", "/sign-up/email"],
    rateLimit: {
      enabled: true,
      // Survives restarts and is shared by every builder instance.
      storage: "database",
      modelName: "AuthRateLimit",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/username": { window: 60, max: 5 },
      },
    },
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      // The builder runs behind the deployment's proxy.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    telemetry: { enabled: false },
  });

export type BetterAuth = ReturnType<typeof createBetterAuth>;

export const normalizeUsername = (value: string) => value.trim().toLowerCase();

export type UsernameSignInResult =
  | { status: "ok"; userId: string }
  | { status: "invalid" }
  | { status: "rate-limited" };

/**
 * Checks a username and password. Goes through Better Auth's request handler (not
 * its server API) so its rate limiting applies, keyed by the client's IP address.
 * The Better Auth session it creates is deleted right away.
 */
export const signInWithUsername = async (
  auth: BetterAuth,
  {
    username,
    password,
    request,
  }: { username: string; password: string; request: Request }
): Promise<UsernameSignInResult> => {
  const headers = new Headers({ "Content-Type": "application/json" });
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor !== null) {
    headers.set("x-forwarded-for", forwardedFor);
  }
  const response = await auth.handler(
    new Request(new URL(`${basePath}/sign-in/username`, auth.options.baseURL), {
      method: "POST",
      headers,
      body: JSON.stringify({ username: normalizeUsername(username), password }),
    })
  );
  if (response.status === 429) {
    return { status: "rate-limited" };
  }
  if (response.ok === false) {
    return { status: "invalid" };
  }
  const body = (await response.json()) as {
    token?: string;
    user?: { id?: string };
  };
  if (typeof body.user?.id !== "string") {
    return { status: "invalid" };
  }
  if (typeof body.token === "string") {
    const context = await auth.$context;
    await context.internalAdapter.deleteSession(body.token);
  }
  return { status: "ok", userId: body.user.id };
};
