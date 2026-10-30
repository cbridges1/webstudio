// selfhost: app admins manage accounts in Settings → Users, as the account script
// (scripts/users.ts) does: there is no public sign-up. An admin either sets a new user's
// password or invites them: the user gets a link (by email when email is set up, and shown
// to the admin to share either way) and chooses their own password.
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
  inviteLinkMaxAge,
  normalizeEmail,
} from "./user-accounts.server";
import { getBetterAuth } from "./username-auth.server";
import {
  accountInviteEmail,
  isEmailEnabled,
  sendEmail,
  setPasswordUrl,
} from "./email.server";

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
      .select({ email: user.email, name: user.username })
      .from(user)
      .where(eq(user.id, context.authorization.userId))
  );
  return { email: row?.email ?? null, name: row?.name || row?.email || "" };
};

const accounts = (context: AppContext) =>
  createUserAccounts({ db: context.db, auth: getBetterAuth() });

export const listUsers = async (context: AppContext) => {
  const { email: self } = await assertAppAdmin(context);
  const users = await accounts(context).list();
  return users.map((account) => ({
    ...account,
    isSelf: account.email === self,
  }));
};

export type UserList = Awaited<ReturnType<typeof listUsers>>;

export type InviteLink = {
  email: string;
  /** The set-password link, for the admin to share when it wasn't emailed. */
  url: string;
  emailed: boolean;
  /** Why it wasn't emailed. */
  emailError?: string;
};

/** Makes a set-password link for an invited user and emails it when email is set up. */
const invite = async (
  email: string,
  inviter: string,
  context: AppContext
): Promise<InviteLink> => {
  const token = await accounts(context).createSetPasswordToken(email);
  const url = setPasswordUrl(token);
  const to = normalizeEmail(email);
  if ((await isEmailEnabled(context.db)) === false) {
    return { email: to, url, emailed: false, emailError: "Email isn't set up" };
  }
  const result = await sendEmail(
    context.db,
    accountInviteEmail({
      to,
      inviter,
      url,
      days: inviteLinkMaxAge / (24 * 60 * 60),
    })
  );
  return result.sent
    ? { email: to, url, emailed: true }
    : { email: to, url, emailed: false, emailError: result.error };
};

export const addUserInput = z.object({
  name: z.string(),
  email: z.string(),
  /** Leave it out to invite the user to choose their own. */
  password: z.string().optional(),
  admin: z.boolean().optional(),
});

export const addUser = async (
  input: z.infer<typeof addUserInput>,
  context: AppContext
) => {
  const { name: inviter } = await assertAppAdmin(context);
  const created = await accounts(context).add({
    name: input.name,
    email: input.email,
    password: input.password,
  });
  if (input.admin) {
    await accounts(context).setAdmin(created.email, true);
  }
  return {
    users: await listUsers(context),
    invite:
      input.password === undefined
        ? await invite(created.email, inviter, context)
        : undefined,
  };
};

export const resendInviteInput = z.object({ email: z.string() });

/** A new set-password link for a user who hasn't chosen a password yet. */
export const resendInvite = async (
  input: z.infer<typeof resendInviteInput>,
  context: AppContext
) => {
  const { name: inviter } = await assertAppAdmin(context);
  const email = normalizeEmail(input.email);
  const account = (await accounts(context).list()).find(
    (row) => row.email === email
  );
  if (account === undefined) {
    throw new AccountError(`No user ${email}`);
  }
  if (account.invited === false) {
    throw new AccountError(`${email} has already chosen a password`);
  }
  return await invite(email, inviter, context);
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
  const { email: self } = await assertAppAdmin(context);
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
