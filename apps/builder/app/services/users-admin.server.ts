// selfhost: app admins manage accounts in Settings → Users, as the account script
// (scripts/users.ts) does: there is no public sign-up.
import { z } from "zod";
import { eq, maybeOne, user } from "@webstudio-is/db";
import {
  AuthorizationError,
  type AppContext,
} from "@webstudio-is/trpc-interface/index.server";
import { isAppAdmin } from "./deployers.server";
import {
  AccountError,
  createUserAccounts,
  normalizeEmail,
} from "./user-accounts.server";
import { getBetterAuth } from "./username-auth.server";

/** The signed-in admin's email; only app admins get past it. */
const assertAppAdmin = async (context: AppContext) => {
  if (
    context.authorization.type !== "user" ||
    (await isAppAdmin(context.db, context.authorization.userId)) === false
  ) {
    throw new AuthorizationError("Only admins can manage users");
  }
  const row = maybeOne(
    await context.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, context.authorization.userId))
  );
  return row?.email ?? null;
};

const accounts = (context: AppContext) =>
  createUserAccounts({ db: context.db, auth: getBetterAuth() });

export const listUsers = async (context: AppContext) => {
  const self = await assertAppAdmin(context);
  const users = await accounts(context).list();
  return users.map((account) => ({
    ...account,
    isSelf: account.email === self,
  }));
};

export type UserList = Awaited<ReturnType<typeof listUsers>>;

export const addUserInput = z.object({
  name: z.string(),
  email: z.string(),
  password: z.string(),
  admin: z.boolean().optional(),
});

export const addUser = async (
  input: z.infer<typeof addUserInput>,
  context: AppContext
) => {
  await assertAppAdmin(context);
  const created = await accounts(context).add({
    name: input.name,
    email: input.email,
    password: input.password,
  });
  if (input.admin) {
    await accounts(context).setAdmin(created.email, true);
  }
  return await listUsers(context);
};

export const updateUserInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("password"),
    email: z.string(),
    password: z.string(),
  }),
  z.object({ action: z.literal("name"), email: z.string(), name: z.string() }),
  z.object({
    action: z.literal("email"),
    email: z.string(),
    newEmail: z.string(),
  }),
  z.object({
    action: z.enum(["disable", "enable", "admin", "unadmin"]),
    email: z.string(),
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
    normalizeEmail(input.email) === self &&
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
      await users.setPassword(input.email, input.password);
      break;
    case "name":
      await users.setName(input.email, input.name);
      break;
    case "email":
      await users.setEmail(input.email, input.newEmail);
      break;
    case "disable":
      await users.disable(input.email);
      break;
    case "enable":
      await users.enable(input.email);
      break;
    case "admin":
      await users.setAdmin(input.email, true);
      break;
    case "unadmin":
      await users.setAdmin(input.email, false);
      break;
  }
  return await listUsers(context);
};
