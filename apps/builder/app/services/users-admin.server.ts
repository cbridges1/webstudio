// selfhost: app admins manage accounts in Settings → Users, as the account script
// (scripts/users.ts) does: there is no public sign-up.
import { z } from "zod";
import { eq, maybeOne, user } from "@webstudio-is/db";
import {
  AuthorizationError,
  type AppContext,
} from "@webstudio-is/trpc-interface/index.server";
import { isAppAdmin } from "./deployers.server";
import { AccountError, createUserAccounts } from "./user-accounts.server";
import { getBetterAuth } from "./username-auth.server";

/** The signed-in admin's username; only app admins get past it. */
const assertAppAdmin = async (context: AppContext) => {
  if (
    context.authorization.type !== "user" ||
    (await isAppAdmin(context.db, context.authorization.userId)) === false
  ) {
    throw new AuthorizationError("Only admins can manage users");
  }
  const row = maybeOne(
    await context.db
      .select({ loginName: user.loginName })
      .from(user)
      .where(eq(user.id, context.authorization.userId))
  );
  return row?.loginName ?? null;
};

const accounts = (context: AppContext) =>
  createUserAccounts({ db: context.db, auth: getBetterAuth() });

export const listUsers = async (context: AppContext) => {
  const self = await assertAppAdmin(context);
  const users = await accounts(context).list();
  return users.map((account) => ({
    ...account,
    isSelf: account.username === self,
  }));
};

export type UserList = Awaited<ReturnType<typeof listUsers>>;

export const addUserInput = z.object({
  username: z.string(),
  /** Empty: none (the user can't reset a forgotten password or be invited by email). */
  email: z.string().optional(),
  password: z.string(),
  admin: z.boolean().optional(),
});

export const addUser = async (
  input: z.infer<typeof addUserInput>,
  context: AppContext
) => {
  await assertAppAdmin(context);
  const created = await accounts(context).add({
    username: input.username,
    email: input.email,
    password: input.password,
  });
  if (input.admin) {
    await accounts(context).setAdmin(created.username, true);
  }
  return await listUsers(context);
};

export const updateUserInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("password"),
    username: z.string(),
    password: z.string(),
  }),
  z.object({
    action: z.enum(["disable", "enable", "admin", "unadmin"]),
    username: z.string(),
  }),
]);

export const updateUser = async (
  input: z.infer<typeof updateUserInput>,
  context: AppContext
) => {
  const self = await assertAppAdmin(context);
  const users = accounts(context);
  // An admin locking themselves out would leave nobody to undo it.
  if (
    input.username === self &&
    (input.action === "disable" || input.action === "unadmin")
  ) {
    throw new AccountError(
      input.action === "disable"
        ? "You can't disable your own account"
        : "You can't remove your own admin role"
    );
  }
  switch (input.action) {
    case "password":
      await users.setPassword(input.username, input.password);
      break;
    case "disable":
      await users.disable(input.username);
      break;
    case "enable":
      await users.enable(input.username);
      break;
    case "admin":
      await users.setAdmin(input.username, true);
      break;
    case "unadmin":
      await users.setAdmin(input.username, false);
      break;
  }
  return await listUsers(context);
};
