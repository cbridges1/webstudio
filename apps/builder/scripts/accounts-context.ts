// selfhost: connects the account tools (scripts/users.ts, and a self-hosting project's
// `npm run cli`) to the database the builder uses, with the same Better Auth configuration.
//
// Reads DATABASE_URL and BETTER_AUTH_SECRET like the builder: the environment first,
// then apps/builder/.env.development, then apps/builder/.env.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "@webstudio-is/db";
import { createBetterAuth } from "../app/services/better-auth.server";
import { createUserAccounts } from "../app/services/user-accounts.server";

export const builderDir = join(import.meta.dirname, "..");

/** Loads the builder's .env files; loadEnvFile never overrides variables already set. */
export const loadBuilderEnv = () => {
  for (const file of [".env.development", ".env"]) {
    const path = join(builderDir, file);
    if (existsSync(path)) {
      process.loadEnvFile(path);
    }
  }
};

export const openAccounts = () => {
  loadBuilderEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL is not set");
  }
  const db = createDb(databaseUrl, { max: 1 });
  const auth = createBetterAuth({
    db,
    secret: process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET ?? "",
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost",
  });
  return {
    accounts: createUserAccounts({ db, auth }),
    /** The builder's public address, as email.server.ts's builderOrigin finds it. */
    origin: process.env.BETTER_AUTH_URL ?? process.env.DEPLOYMENT_URL,
    close: () => db.$client.end(),
  };
};
