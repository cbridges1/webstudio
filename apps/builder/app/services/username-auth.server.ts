// selfhost: the builder's Better Auth instance and the messages its sign-in shows.
import { getDb } from "@webstudio-is/db";
import env from "~/env/env.server";
import { createBetterAuth, type BetterAuth } from "./better-auth.server";

export const INVALID_CREDENTIALS = "Invalid username or password";
export const TOO_MANY_ATTEMPTS = "Too many attempts, try again in a minute";

let betterAuth: BetterAuth | undefined;

export const getBetterAuth = () => {
  betterAuth ??= createBetterAuth({
    db: getDb(env.DATABASE_URL),
    secret: env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET ?? "",
    baseURL:
      env.BETTER_AUTH_URL ??
      env.DEPLOYMENT_URL ??
      `http://localhost:${env.PORT}`,
  });
  return betterAuth;
};
