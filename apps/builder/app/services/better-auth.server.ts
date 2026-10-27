// selfhost: email/password sign-in with Better Auth.
//
// Better Auth only checks credentials (and rate-limits attempts). The builder's own
// cookie session (remix-auth) stays the only session the app uses, so the builder
// subdomain hop and logout work as upstream wrote them. Better Auth's HTTP handler is
// never routed: the builder calls it in-process for sign-in and password resets, and the
// account script uses its server API.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
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

export type ResetPasswordMail = (input: {
  user: { email: string; name: string };
  token: string;
}) => Promise<void>;

export const createBetterAuth = ({
  db,
  secret,
  baseURL,
  rateLimit = true,
  sendResetPassword,
}: {
  db: Db;
  secret: string;
  /** The builder's public origin. */
  baseURL: string;
  /** Limits sign-in attempts per client address. Only e2e runs turn it off. */
  rateLimit?: boolean;
  /** Emails a password reset link (see email.server.ts); resets are off without it. */
  sendResetPassword?: ResetPasswordMail;
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
    // One user table: Better Auth's users are Webstudio's users; its `name` is the display
    // name (User.username, upstream's column).
    user: { modelName: "User", fields: { name: "username" } },
    session: { modelName: "AuthSession" },
    account: { modelName: "AuthAccount" },
    verification: { modelName: "AuthVerification" },
    emailAndPassword: {
      enabled: true,
      // Accounts come from the account script only.
      disableSignUp: true,
      minPasswordLength,
      maxPasswordLength,
      // selfhost: users with an email can reset their password from the sign-in page.
      sendResetPassword:
        sendResetPassword === undefined
          ? undefined
          : ({ user, token }) => sendResetPassword({ user, token }),
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
    },
    plugins: [admin()],
    disabledPaths: ["/sign-up/email"],
    rateLimit: {
      enabled: rateLimit,
      // Survives restarts and is shared by every builder instance.
      storage: "database",
      modelName: "AuthRateLimit",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
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

/** Emails are the sign-in name: compared and stored trimmed and lowercased. */
export const normalizeEmail = (value: string) => value.trim().toLowerCase();

export type SignInResult =
  | { status: "ok"; userId: string }
  | { status: "invalid" }
  | { status: "rate-limited" };

/**
 * Checks an email and password. Goes through Better Auth's request handler (not its server
 * API) so its rate limiting applies, keyed by the client's IP address. The Better Auth
 * session it creates is deleted right away.
 */
export const signInWithEmail = async (
  auth: BetterAuth,
  {
    email,
    password,
    request,
  }: { email: string; password: string; request: Request }
): Promise<SignInResult> => {
  const headers = new Headers({ "Content-Type": "application/json" });
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor !== null) {
    headers.set("x-forwarded-for", forwardedFor);
  }
  const response = await auth.handler(
    new Request(new URL(`${basePath}/sign-in/email`, auth.options.baseURL), {
      method: "POST",
      headers,
      body: JSON.stringify({ email: normalizeEmail(email), password }),
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

/** Calls one of Better Auth's endpoints through its handler, so its rate limits apply. */
const callAuth = (
  auth: BetterAuth,
  path: string,
  body: unknown,
  request: Request
) => {
  const headers = new Headers({ "Content-Type": "application/json" });
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor !== null) {
    headers.set("x-forwarded-for", forwardedFor);
  }
  return auth.handler(
    new Request(new URL(`${basePath}${path}`, auth.options.baseURL), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  );
};

/**
 * Emails a reset link when an account has this email. The answer is the same either way,
 * so it doesn't tell who has an account.
 */
export const requestPasswordReset = async (
  auth: BetterAuth,
  { email, request }: { email: string; request: Request }
): Promise<"sent" | "rate-limited"> => {
  const response = await callAuth(
    auth,
    "/request-password-reset",
    { email: email.trim().toLowerCase() },
    request
  );
  return response.status === 429 ? "rate-limited" : "sent";
};

export type PasswordResetResult =
  | { status: "ok" }
  | { status: "invalid-token" }
  | { status: "rate-limited" }
  | { status: "invalid-password"; message: string };

/** Sets a new password with a reset link's token; signs the user out of Better Auth. */
export const resetPassword = async (
  auth: BetterAuth,
  {
    token,
    password,
    request,
  }: { token: string; password: string; request: Request }
): Promise<PasswordResetResult> => {
  const response = await callAuth(
    auth,
    "/reset-password",
    { token, newPassword: password },
    request
  );
  if (response.ok) {
    return { status: "ok" };
  }
  if (response.status === 429) {
    return { status: "rate-limited" };
  }
  const body = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
  };
  if (body.code === "PASSWORD_TOO_SHORT" || body.code === "PASSWORD_TOO_LONG") {
    return {
      status: "invalid-password",
      message: body.message ?? "Choose another password",
    };
  }
  return { status: "invalid-token" };
};
