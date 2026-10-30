// selfhost: email/password account management. There is no public sign-up: an admin
// creates every account, in the dashboard (Settings → Users), with the account script
// (scripts/users.ts), a self-hosting project's CLI or, in e2e runs, the test flows. An
// account is a name (shown in the builder) and an email (its sign-in name, lowercased).
//
// An account added without a password is invited: it has a password account with no
// password yet, so it can't sign in until the user follows a set-password link (the
// password reset page with a longer-lived token) and chooses their own.
import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  eq,
  maybeOne,
  authAccount,
  user,
  workspace,
  type Db,
} from "@webstudio-is/db";
import {
  maxPasswordLength,
  minPasswordLength,
  normalizeEmail,
  type BetterAuth,
} from "./better-auth.server";

export { normalizeEmail };

/** A problem the operator can fix, with a message to show them. */
export class AccountError extends Error {}

/** Returns why the email can't be used, or undefined when it's fine. */
export const validateEmail = (value: string) => {
  const email = normalizeEmail(value);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) === false) {
    return "Enter a valid email address";
  }
};

/** Returns why the name can't be used, or undefined when it's fine. */
export const validateName = (value: string) => {
  const name = value.trim();
  if (name.length === 0) {
    return "Enter a name";
  }
  if (name.length > 64) {
    return "Names can have at most 64 characters";
  }
};

/** Returns why the password can't be used, or undefined when it's fine. */
export const validatePassword = (value: string) => {
  if (value.length < minPasswordLength) {
    return `Passwords need at least ${minPasswordLength} characters`;
  }
  if (value.length > maxPasswordLength) {
    return `Passwords can have at most ${maxPasswordLength} characters`;
  }
};

export type AccountSummary = {
  name: string;
  email: string;
  disabled: boolean;
  /** Better Auth's admin role: manages users, the deployer and email. */
  admin: boolean;
  /** Added without a password and hasn't chosen one yet. */
  invited: boolean;
};

/** How long a set-password link for a new account works. */
export const inviteLinkMaxAge = 7 * 24 * 60 * 60;

/** The builder page where an invited user chooses their password (createSetPasswordToken). */
export const setPasswordPath = (token: string) =>
  `/login/reset-password?${new URLSearchParams({ token, invite: "1" })}`;

const hasAdminRole = (role: string | null) =>
  (role ?? "").split(",").some((name) => name.trim() === "admin");

export const createUserAccounts = ({
  db,
  auth,
}: {
  db: Db;
  auth: BetterAuth;
}) => {
  const findUser = async (email: string) =>
    maybeOne(
      await db
        .select({ id: user.id, banned: user.banned })
        .from(user)
        .where(eq(user.email, normalizeEmail(email)))
    );

  const getUser = async (email: string) => {
    const found = await findUser(email);
    if (found === null) {
      throw new AccountError(`No user ${normalizeEmail(email)}`);
    }
    return found;
  };

  const check = (problem: string | undefined) => {
    if (problem !== undefined) {
      throw new AccountError(problem);
    }
  };

  const signOut = async (userId: string) => {
    const context = await auth.$context;
    await context.internalAdapter.deleteUserSessions(userId);
  };

  /** Every user gets a default workspace, as the builder's genericCreateAccount does. */
  const ensureDefaultWorkspace = async (userId: string) => {
    const existing = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(and(eq(workspace.userId, userId), eq(workspace.isDefault, true)));
    if (existing.length === 0) {
      await db
        .insert(workspace)
        .values({ name: "My workspace", isDefault: true, userId });
    }
  };

  return {
    exists: async (email: string) => (await findUser(email)) !== null,

    /** Accounts that sign in with a password. */
    list: async (): Promise<AccountSummary[]> => {
      const rows = await db
        .select({
          name: user.username,
          email: user.email,
          banned: user.banned,
          role: user.role,
          password: authAccount.password,
        })
        .from(user)
        .innerJoin(
          authAccount,
          and(
            eq(authAccount.userId, user.id),
            eq(authAccount.providerId, "credential")
          )
        )
        .orderBy(asc(user.email));
      return rows.map((row) => ({
        name: row.name ?? "",
        email: row.email ?? "",
        disabled: row.banned === true,
        admin: hasAdminRole(row.role),
        invited: row.password === null,
      }));
    },

    /**
     * Creates a user with its default workspace. Without a password the user is invited:
     * they choose a password with a set-password link (createSetPasswordToken).
     */
    add: async ({
      name: rawName,
      email: rawEmail,
      password,
    }: {
      name: string;
      email: string;
      password?: string;
    }) => {
      const name = rawName.trim();
      const email = normalizeEmail(rawEmail);
      check(validateName(name));
      check(validateEmail(email));
      if (password !== undefined) {
        check(validatePassword(password));
      }
      if ((await findUser(email)) !== null) {
        throw new AccountError(`${email} already has an account`);
      }
      const { user: created } = await auth.api.createUser({
        body: { email, password, name },
      });
      if (password === undefined) {
        // A password account without a password: listed as invited, and sign-in fails
        // until a set-password link fills it in.
        const context = await auth.$context;
        await context.internalAdapter.linkAccount({
          userId: created.id,
          providerId: "credential",
          accountId: created.id,
        });
      }
      await db
        .update(user)
        .set({ provider: "password" })
        .where(eq(user.id, created.id));
      await ensureDefaultWorkspace(created.id);
      return { id: created.id, email };
    },

    /** Replaces the password and signs the user out of Better Auth. */
    setPassword: async (email: string, password: string) => {
      check(validatePassword(password));
      const { id } = await getUser(email);
      const context = await auth.$context;
      const hash = await context.password.hash(password);
      const accounts = await context.internalAdapter.findAccounts(id);
      if (accounts.some((account) => account.providerId === "credential")) {
        await context.internalAdapter.updatePassword(id, hash);
      } else {
        await context.internalAdapter.linkAccount({
          userId: id,
          providerId: "credential",
          accountId: id,
          password: hash,
        });
      }
      await signOut(id);
    },

    /**
     * A one-time token for the password reset page (/login/reset-password?token=…), which
     * lets the user choose their own password. Used for invites, so it lasts longer than a
     * reset link the user asks for themselves.
     */
    createSetPasswordToken: async (
      email: string,
      maxAge = inviteLinkMaxAge
    ) => {
      const { id } = await getUser(email);
      const token = randomBytes(24).toString("base64url");
      const context = await auth.$context;
      // Better Auth's reset-password endpoint reads this row (its own resets store the same).
      await context.internalAdapter.createVerificationValue({
        identifier: `reset-password:${token}`,
        value: id,
        expiresAt: new Date(Date.now() + maxAge * 1000),
      });
      return token;
    },

    /** Renames the user (the name the builder shows). */
    setName: async (email: string, rawName: string) => {
      const name = rawName.trim();
      check(validateName(name));
      const { id } = await getUser(email);
      await db.update(user).set({ username: name }).where(eq(user.id, id));
    },

    /** Changes the sign-in email (workspace invites match it too). */
    setEmail: async (email: string, rawNewEmail: string) => {
      const newEmail = normalizeEmail(rawNewEmail);
      check(validateEmail(newEmail));
      const { id } = await getUser(email);
      const taken = await findUser(newEmail);
      if (taken !== null && taken.id !== id) {
        throw new AccountError(`${newEmail} already has an account`);
      }
      await db.update(user).set({ email: newEmail }).where(eq(user.id, id));
    },

    /** Blocks sign-in. Projects and data stay. */
    disable: async (email: string) => {
      const { id } = await getUser(email);
      await db
        .update(user)
        .set({ banned: true, banReason: "Disabled by an administrator" })
        .where(eq(user.id, id));
      await signOut(id);
    },

    enable: async (email: string) => {
      const { id } = await getUser(email);
      await db
        .update(user)
        .set({ banned: false, banReason: null, banExpires: null })
        .where(eq(user.id, id));
    },

    /** Gives or takes Better Auth's admin role. */
    setAdmin: async (email: string, admin: boolean) => {
      const { id } = await getUser(email);
      await db
        .update(user)
        .set({ role: admin ? "admin" : "user" })
        .where(eq(user.id, id));
    },
  };
};

export type UserAccounts = ReturnType<typeof createUserAccounts>;
