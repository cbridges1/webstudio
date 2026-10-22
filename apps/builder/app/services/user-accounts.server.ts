// selfhost: username/password account management. There is no public sign-up: an
// admin creates every account, with the account script (scripts/users.ts), the
// interactive CLI (knowbra-webstudio's `npm run cli`) or, in e2e runs, the test flows.
import {
  and,
  asc,
  eq,
  isNotNull,
  maybeOne,
  user,
  workspace,
  type Db,
} from "@webstudio-is/db";
import {
  maxPasswordLength,
  minPasswordLength,
  normalizeUsername,
  usernamePattern,
  type BetterAuth,
} from "./better-auth.server";

export { normalizeUsername };

/** A problem the operator can fix, with a message to show them. */
export class AccountError extends Error {}

/** Returns why the username can't be used, or undefined when it's fine. */
export const validateUsername = (value: string) => {
  if (usernamePattern.test(normalizeUsername(value)) === false) {
    return "Usernames have 3–32 letters, digits, '.', '_' or '-'";
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

/** Returns why the email can't be used, or undefined when it's fine. */
export const validateEmail = (value: string) => {
  if (value.trim().includes("@") === false) {
    return "Enter a valid email address";
  }
};

export type AccountSummary = {
  username: string;
  email: string | null;
  disabled: boolean;
};

export const createUserAccounts = ({
  db,
  auth,
}: {
  db: Db;
  auth: BetterAuth;
}) => {
  const findUser = async (username: string) =>
    maybeOne(
      await db
        .select({ id: user.id, banned: user.banned })
        .from(user)
        .where(eq(user.loginName, normalizeUsername(username)))
    );

  const getUser = async (username: string) => {
    const found = await findUser(username);
    if (found === null) {
      throw new AccountError(`No user ${normalizeUsername(username)}`);
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
    exists: async (username: string) => (await findUser(username)) !== null,

    list: async (): Promise<AccountSummary[]> => {
      const rows = await db
        .select({
          loginName: user.loginName,
          email: user.email,
          banned: user.banned,
        })
        .from(user)
        .where(isNotNull(user.loginName))
        .orderBy(asc(user.loginName));
      return rows.map((row) => ({
        username: row.loginName ?? "",
        email: row.email,
        disabled: row.banned === true,
      }));
    },

    /**
     * Creates a user with its default workspace. Users who will be invited to
     * workspaces need a real email: invites match it exactly.
     */
    add: async ({
      username: rawUsername,
      email: rawEmail,
      password,
    }: {
      username: string;
      email?: string;
      password: string;
    }) => {
      const username = normalizeUsername(rawUsername);
      const email = rawEmail?.trim().toLowerCase() || undefined;
      check(validateUsername(username));
      check(email === undefined ? undefined : validateEmail(email));
      check(validatePassword(password));
      if ((await findUser(username)) !== null) {
        throw new AccountError(`${username} already exists`);
      }
      // Better Auth needs an email; accounts without one get a placeholder that
      // can't receive mail or match an invite.
      const { user: created } = await auth.api.createUser({
        body: {
          email: email ?? `${username}@users.invalid`,
          password,
          name: username,
          data: { username },
        },
      });
      await db
        .update(user)
        .set({
          provider: "username",
          // Invites match User.email, so keep placeholders out of it.
          email: email ?? null,
        })
        .where(eq(user.id, created.id));
      await ensureDefaultWorkspace(created.id);
      return { id: created.id, username };
    },

    /** Replaces the password and signs the user out of Better Auth. */
    setPassword: async (username: string, password: string) => {
      check(validatePassword(password));
      const { id } = await getUser(username);
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

    /** Blocks sign-in. Projects and data stay. */
    disable: async (username: string) => {
      const { id } = await getUser(username);
      await db
        .update(user)
        .set({ banned: true, banReason: "Disabled by an administrator" })
        .where(eq(user.id, id));
      await signOut(id);
    },

    enable: async (username: string) => {
      const { id } = await getUser(username);
      await db
        .update(user)
        .set({ banned: false, banReason: null, banExpires: null })
        .where(eq(user.id, id));
    },
  };
};

export type UserAccounts = ReturnType<typeof createUserAccounts>;
