// selfhost: manages username/password accounts. There is no public sign-up: an admin
// creates every account. Passwords are hashed and checked by Better Auth, with the
// same configuration the builder uses (app/services/better-auth.server.ts).
//
// Usage: pnpm --filter @webstudio-is/builder users <command>
//   add <username> [--email <email>]  Create a user, its default workspace and a password
//   set-password <username>           Replace the password and sign the user out of Better Auth
//   disable <username>                Block sign-in
//   enable <username>                 Allow sign-in again
//   list                              List username accounts and whether they can sign in
// The password is prompted for without echo, or read from stdin with --password-stdin.
// Users who will be invited to workspaces need a real email: invites match it exactly.
//
// Reads DATABASE_URL and BETTER_AUTH_SECRET like the builder: the environment first,
// then apps/builder/.env.development, then apps/builder/.env.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import {
  and,
  asc,
  createDb,
  eq,
  isNotNull,
  maybeOne,
  user,
  workspace,
} from "@webstudio-is/db";
import {
  createBetterAuth,
  maxPasswordLength,
  minPasswordLength,
  normalizeUsername,
} from "../app/services/better-auth.server";

// loadEnvFile never overrides variables that are already set.
for (const file of [".env.development", ".env"]) {
  const path = join(import.meta.dirname, "..", file);
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

const die = (message: string): never => {
  console.error(`error: ${message}`);
  process.exit(1);
};

const databaseUrl = process.env.DATABASE_URL ?? die("DATABASE_URL is not set");
const db = createDb(databaseUrl, { max: 1 });
const auth = createBetterAuth({
  db,
  secret: process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET ?? "",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost",
});

const readHidden = (prompt: string): Promise<string> =>
  new Promise((resolve) => {
    let muted = false;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (muted === false) {
          process.stdout.write(chunk);
        }
        callback();
      },
    });
    const rl = createInterface({
      input: process.stdin,
      output,
      terminal: true,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });

const readStdin = async () => {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data.replace(/\r?\n$/, "");
};

const readPassword = async (passwordStdin: boolean) => {
  let password: string;
  if (passwordStdin) {
    password = await readStdin();
  } else {
    if (process.stdin.isTTY !== true) {
      die("no terminal to prompt for a password; use --password-stdin");
    }
    password = await readHidden("Password: ");
    const again = await readHidden("Repeat password: ");
    if (password !== again) {
      die("passwords don't match");
    }
  }
  if (password.length < minPasswordLength) {
    die(`the password must have at least ${minPasswordLength} characters`);
  }
  if (password.length > maxPasswordLength) {
    die(`the password must have at most ${maxPasswordLength} characters`);
  }
  return password;
};

const findUser = async (username: string) =>
  maybeOne(
    await db
      .select({ id: user.id, banned: user.banned })
      .from(user)
      .where(eq(user.loginName, username))
  );

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

const signOut = async (userId: string) => {
  const context = await auth.$context;
  await context.internalAdapter.deleteUserSessions(userId);
};

const add = async (
  username: string,
  email: string | undefined,
  passwordStdin: boolean
) => {
  if ((await findUser(username)) !== null) {
    die(`${username} already exists (use set-password to change the password)`);
  }
  const password = await readPassword(passwordStdin);
  // Better Auth needs an email; accounts without one get a placeholder that can't
  // receive mail or match an invite.
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
  console.info(`Created ${username}.`);
};

const setPassword = async (userId: string, password: string) => {
  const context = await auth.$context;
  const hash = await context.password.hash(password);
  const accounts = await context.internalAdapter.findAccounts(userId);
  if (accounts.some((account) => account.providerId === "credential")) {
    await context.internalAdapter.updatePassword(userId, hash);
  } else {
    await context.internalAdapter.linkAccount({
      userId,
      providerId: "credential",
      accountId: userId,
      password: hash,
    });
  }
  await signOut(userId);
};

const main = async () => {
  const args = process.argv.slice(2);
  const passwordStdin = args.includes("--password-stdin");
  const emailIndex = args.indexOf("--email");
  const email =
    emailIndex === -1 ? undefined : args[emailIndex + 1]?.trim().toLowerCase();
  const [command, rawUsername] = args.filter(
    (arg, index) =>
      arg !== "--password-stdin" &&
      (emailIndex === -1 || (index !== emailIndex && index !== emailIndex + 1))
  );

  if (command === "list") {
    const users = await db
      .select({
        loginName: user.loginName,
        email: user.email,
        banned: user.banned,
      })
      .from(user)
      .where(isNotNull(user.loginName))
      .orderBy(asc(user.loginName));
    for (const row of users) {
      console.info(
        `${row.loginName}\t${row.email ?? "(no email)"}\t${row.banned ? "disabled" : "active"}`
      );
    }
    return;
  }

  if (rawUsername === undefined) {
    die(
      "usage: users <add|set-password|disable|enable> <username> [--email <email>] | users list"
    );
  }
  const username = normalizeUsername(rawUsername);
  if (/^[a-z0-9_.-]{3,32}$/.test(username) === false) {
    die("usernames have 3–32 letters, digits, '.', '_' or '-'");
  }
  if (email !== undefined && email.includes("@") === false) {
    die(`invalid email: ${email}`);
  }

  if (command === "add") {
    await add(username, email, passwordStdin);
    return;
  }

  const found = (await findUser(username)) ?? die(`no user ${username}`);

  if (command === "set-password") {
    await setPassword(found.id, await readPassword(passwordStdin));
    console.info(`Password updated for ${username}.`);
    return;
  }
  if (command === "disable") {
    await db
      .update(user)
      .set({ banned: true, banReason: "Disabled by an administrator" })
      .where(eq(user.id, found.id));
    await signOut(found.id);
    console.info(`Disabled ${username}; they can no longer sign in.`);
    return;
  }
  if (command === "enable") {
    await db
      .update(user)
      .set({ banned: false, banReason: null, banExpires: null })
      .where(eq(user.id, found.id));
    console.info(`Enabled ${username}.`);
    return;
  }
  die(`unknown command: ${command}`);
};

try {
  await main();
} finally {
  await db.$client.end();
}
