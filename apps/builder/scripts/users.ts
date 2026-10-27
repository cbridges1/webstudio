// selfhost: manages email/password accounts from the command line, for scripts and
// automation, such as a self-hosting project's commands. App admins can do the same in the
// dashboard (Settings → Users).
// There is no public sign-up: an admin creates every account. Passwords are hashed and
// checked by Better Auth, with the same configuration the builder uses
// (app/services/better-auth.server.ts).
//
// Usage (from apps/builder): pnpm users <command>
//   add <email> [--name <name>] [--admin]
//                                     Create a user (name: the email's part before "@"), its
//                                     default workspace and a password (--admin: an app admin)
//   set-password <email>              Replace the password and sign the user out of Better Auth
//   set-name <email> --name <name>    Change the name the builder shows
//   set-email <email> --new-email <new>
//                                     Change the sign-in email
//   disable <email>                   Block sign-in
//   enable <email>                    Allow sign-in again
//   make-admin <email>                Make an app admin (dashboard Settings: users, deployer,
//                                     email)
//   remove-admin <email>              Make a regular user again
//   local-admin                       Create the local test admin (localAdmin below) when it's
//                                     missing; never changes an existing account. Refused in
//                                     production
//   list                              List accounts: name, email, whether they can sign in and
//                                     which are admins (tab-separated)
// The password is prompted for without echo, read from stdin with --password-stdin, or read
// from an environment variable with --password-env <name> (for a job that gets it from a
// secret store).
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import {
  AccountError,
  normalizeEmail,
  validateEmail,
  validatePassword,
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
  if (passwordEnv !== undefined) {
    password = process.env[passwordEnv] ?? "";
  } else if (passwordStdin) {
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
const valueOptions = ["--name", "--new-email", "--password-env"];
const flags = ["--password-stdin", "--admin"];
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const passwordStdin = args.includes("--password-stdin");
const makeAdmin = args.includes("--admin");
const name = option("--name");
const newEmail = option("--new-email");
const passwordEnv = option("--password-env");
const [command, rawEmail] = args.filter(
  (arg, index) =>
    flags.includes(arg) === false &&
    valueOptions.includes(arg) === false &&
    valueOptions.includes(args[index - 1]) === false
);

const { accounts, close } = openAccounts();

/**
 * The test admin for running locally, documented in the README ("This fork"). Only for local
 * development databases: `local-admin` refuses in production.
 */
const localAdmin = {
  name: "Local admin",
  email: "admin@localhost.test",
  password: "webstudio-local-admin",
};

const main = async () => {
  if (command === "local-admin") {
    if (
      process.env.NODE_ENV === "production" ||
      process.env.DEPLOYMENT_ENVIRONMENT === "production"
    ) {
      return die("local-admin is for local development only");
    }
    if (await accounts.exists(localAdmin.email)) {
      console.info(`${localAdmin.email} already exists; left unchanged.`);
      return;
    }
    await accounts.add(localAdmin);
    await accounts.setAdmin(localAdmin.email, true);
    console.info(
      `Created ${localAdmin.email} (password: ${localAdmin.password}), an admin.`
    );
    return;
  }

  if (command === "list") {
    for (const row of await accounts.list()) {
      console.info(
        `${row.name}\t${row.email}\t${row.disabled ? "disabled" : "active"}${row.admin ? "\tadmin" : ""}`
      );
    }
    return;
  }

  if (rawEmail === undefined) {
    die(
      "usage: users <add|set-password|set-name|set-email|disable|enable|make-admin|remove-admin> <email> [--name <name>] [--new-email <email>] [--admin] | users list"
    );
  }
  const email = normalizeEmail(rawEmail);
  const problem = validateEmail(email);
  if (problem !== undefined) {
    die(problem);
  }

  switch (command) {
    case "add":
      if (await accounts.exists(email)) {
        die(
          `${email} already has an account (use set-password to change the password)`
        );
      }
      await accounts.add({
        name: name ?? email.split("@")[0],
        email,
        password: await readPassword(passwordStdin),
      });
      if (makeAdmin) {
        await accounts.setAdmin(email, true);
      }
      console.info(`Created ${email}${makeAdmin ? ", an admin" : ""}.`);
      return;
    case "set-password":
      if ((await accounts.exists(email)) === false) {
        die(`no user ${email}`);
      }
      await accounts.setPassword(email, await readPassword(passwordStdin));
      console.info(`Password updated for ${email}.`);
      return;
    case "set-name":
      if (name === undefined) {
        return die("set-name needs --name <name>");
      }
      await accounts.setName(email, name);
      console.info(`Renamed ${email}.`);
      return;
    case "set-email":
      if (newEmail === undefined) {
        return die("set-email needs --new-email <email>");
      }
      await accounts.setEmail(email, newEmail);
      console.info(`${email} now signs in as ${normalizeEmail(newEmail)}.`);
      return;
    case "disable":
      await accounts.disable(email);
      console.info(`Disabled ${email}; they can no longer sign in.`);
      return;
    case "enable":
      await accounts.enable(email);
      console.info(`Enabled ${email}.`);
      return;
    case "make-admin":
      await accounts.setAdmin(email, true);
      console.info(`${email} is now an admin.`);
      return;
    case "remove-admin":
      await accounts.setAdmin(email, false);
      console.info(`${email} is no longer an admin.`);
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
