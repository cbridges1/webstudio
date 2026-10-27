// selfhost: the builder's Better Auth instance and the messages its sign-in shows.
import { getDb } from "@webstudio-is/db";
import env from "~/env/env.server";
import { createBetterAuth, type BetterAuth } from "./better-auth.server";
import { builderOrigin, passwordResetEmail, sendEmail } from "./email.server";

export const INVALID_CREDENTIALS = "Invalid email or password";
export const TOO_MANY_ATTEMPTS = "Too many attempts, try again in a minute";

let betterAuth: BetterAuth | undefined;

export const getBetterAuth = () => {
  betterAuth ??= createBetterAuth({
    db: getDb(env.DATABASE_URL),
    secret: env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET ?? "",
    baseURL: builderOrigin(),
    rateLimit: env.AUTH_RATE_LIMIT !== "false",
    // Not awaited: how long a request takes mustn't tell whether the email has an account.
    // Without email set up the link isn't shown, and sendEmail sends nothing.
    sendResetPassword: async ({ user, token }) => {
      void sendEmail(
        getDb(env.DATABASE_URL),
        passwordResetEmail({ to: user.email, token })
      );
    },
  });
  return betterAuth;
};
