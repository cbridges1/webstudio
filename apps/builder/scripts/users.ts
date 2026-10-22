// selfhost: manages username/password accounts from the command line, for scripts
// (selfhost.sh) and automation. `npm run cli` offers the same actions interactively.
// There is no public sign-up: an admin creates every account. Passwords are hashed and
// checked by Better Auth, with the same configuration the builder uses
// (app/services/better-auth.server.ts).
//
// Usage (from the repository root): npm run users -- <command>
//   add <username> [--email <email>]  Create a user, its default workspace and a password
//   set-password <username>           Replace the password and sign the user out of Better Auth
//   disable <username>                Block sign-in
//   enable <username>                 Allow sign-in again
//   list                              List username accounts and whether they can sign in
// The password is prompted for without echo, or read from stdin with --password-stdin.
// Users who will be invited to workspaces need a real email: invites match it exactly.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import {
  AccountError,
  normalizeUsername,
  validatePassword,
  validateUsername,
} from "../app/services/user-accounts.server";
import { openAccounts } from "./accounts-context";

const die = (message: string): never => {
  console.error(`error: ${message}`);
  process.exit(1);
};

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
  const problem = validatePassword(password);
  if (problem !== undefined) {
    die(problem);
  }
  return password;
};

const args = process.argv.slice(2);
const passwordStdin = args.includes("--password-stdin");
const emailIndex = args.indexOf("--email");
const email = emailIndex === -1 ? undefined : args[emailIndex + 1];
const [command, rawUsername] = args.filter(
  (arg, index) =>
    arg !== "--password-stdin" &&
    (emailIndex === -1 || (index !== emailIndex && index !== emailIndex + 1))
);

const { accounts, close } = openAccounts();

const main = async () => {
  if (command === "list") {
    for (const row of await accounts.list()) {
      console.info(
        `${row.username}\t${row.email ?? "(no email)"}\t${row.disabled ? "disabled" : "active"}`
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
  const problem = validateUsername(username);
  if (problem !== undefined) {
    die(problem);
  }

  switch (command) {
    case "add":
      if (await accounts.exists(username)) {
        die(
          `${username} already exists (use set-password to change the password)`
        );
      }
      await accounts.add({
        username,
        email,
        password: await readPassword(passwordStdin),
      });
      console.info(`Created ${username}.`);
      return;
    case "set-password":
      if ((await accounts.exists(username)) === false) {
        die(`no user ${username}`);
      }
      await accounts.setPassword(username, await readPassword(passwordStdin));
      console.info(`Password updated for ${username}.`);
      return;
    case "disable":
      await accounts.disable(username);
      console.info(`Disabled ${username}; they can no longer sign in.`);
      return;
    case "enable":
      await accounts.enable(username);
      console.info(`Enabled ${username}.`);
      return;
  }
  die(`unknown command: ${command}`);
};

try {
  await main();
} catch (error) {
  if (error instanceof AccountError) {
    die(error.message);
  }
  throw error;
} finally {
  await close();
}
