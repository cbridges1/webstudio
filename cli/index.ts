// selfhost: interactive dev CLI (`npm run cli`). Pick an action from the menu to set
// up the local database or manage sign-in accounts.
//
// Account actions use the database in DATABASE_URL: the environment first, then
// apps/builder/.env.development, then apps/builder/.env (the same as the builder).
// Setup, Reset and Destroy manage the local development Postgres that `npm run dev`
// uses (apps/builder/backend). WEBSTUDIO_CLI_DATABASE_ACTIONS=false hides them, for
// stacks that run their own database (webstudio-selfhost's `selfhost.sh cli`).
// Drizzle Studio opens the same database in the browser.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  password,
  select,
  spinner,
  text,
} from "@clack/prompts";
import {
  AccountError,
  validateEmail,
  validatePassword,
  validateUsername,
  type AccountSummary,
} from "../apps/builder/app/services/user-accounts.server";
import {
  loadBuilderEnv,
  openAccounts,
} from "../apps/builder/scripts/accounts-context";

const rootDir = join(import.meta.dirname, "..");
const hasDatabaseActions =
  process.env.WEBSTUDIO_CLI_DATABASE_ACTIONS !== "false";

loadBuilderEnv();

/** Stops the CLI when a prompt is cancelled (Ctrl+C or Esc). */
const answer = <Value>(value: Value | symbol): Value => {
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value;
};

/** Runs functions from apps/builder/backend/lib.sh, as `npm run dev` does. */
const backend = (...steps: string[]) => {
  const script = [
    "set -euo pipefail",
    'source "$ROOT_DIR/apps/builder/backend/lib.sh"',
    "builder_backend_init development",
    "builder_backend_init_schema_snapshot",
    ...steps,
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, ROOT_DIR: rootDir },
  });
  if (result.status !== 0) {
    throw new Error("The database command failed (see the output above).");
  }
};

const setup = () => {
  log.step("Starting Postgres and applying migrations…");
  backend(
    "builder_backend_start_db",
    "builder_backend_wait_for_db",
    "builder_backend_bootstrap_if_empty",
    "builder_backend_migrate"
  );
  log.success("Database ready. Start the builder with: npm run dev");
};

/** host:port of DATABASE_URL, for messages (never the password). */
const databaseAddress = () => {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return `${url.hostname}:${url.port || "5432"}`;
  } catch {
    return "DATABASE_URL";
  }
};

const isConnectionRefused = (error: unknown) =>
  ((error as { cause?: { code?: string } })?.cause?.code ??
    (error as { code?: string })?.code) === "ECONNREFUSED";

/**
 * Opens Drizzle Studio on DATABASE_URL until Ctrl+C, then returns to the menu.
 * DRIZZLE_STUDIO_PORT picks the port (4984, so it doesn't clash with other apps'
 * Studio on drizzle-kit's default 4983).
 */
const studio = () => {
  const port = process.env.DRIZZLE_STUDIO_PORT ?? "4984";
  log.step(`Opening Drizzle Studio for ${databaseAddress()}. Ctrl+C to stop.`);
  // Ctrl+C reaches Studio too; the CLI ignores it while Studio runs.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    spawnSync(
      "npx",
      [
        "--no-install",
        "drizzle-kit",
        "studio",
        "--port",
        port,
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: join(rootDir, "packages/db"),
        stdio: "inherit",
        // drizzle.config.ts prefers DIRECT_URL; open the account actions' database.
        env: { ...process.env, DIRECT_URL: process.env.DATABASE_URL },
      }
    );
  } finally {
    process.off("SIGINT", ignore);
  }
};

const destroy = async () => {
  const sure = answer(
    await confirm({
      message:
        "Delete the local development database, with every user and project?",
      initialValue: false,
    })
  );
  if (sure === false) {
    return false;
  }
  log.step("Stopping Postgres and deleting its data…");
  backend("builder_backend_down --volumes --remove-orphans");
  log.success("Database deleted.");
  return true;
};

/**
 * Opens the account database for one action. When the local dev database isn't
 * running, offers to start it and tries again.
 */
const withAccounts = async (
  run: (accounts: ReturnType<typeof openAccounts>["accounts"]) => Promise<void>,
  retry = true
): Promise<void> => {
  const { accounts, close } = openAccounts();
  try {
    await run(accounts);
    return;
  } catch (error) {
    if (isConnectionRefused(error) === false) {
      throw error;
    }
  } finally {
    await close();
  }
  if (hasDatabaseActions === false) {
    throw new Error(
      `Can't reach the database at ${databaseAddress()}. Start it with: scripts/selfhost.sh up`
    );
  }
  log.warn(`The database at ${databaseAddress()} isn't running.`);
  const start =
    retry &&
    answer(
      await confirm({
        message: "Start the local database now?",
        initialValue: true,
      })
    );
  if (start === false) {
    throw new Error(
      "Can't reach the database. Run Setup (or npm run dev), or check DATABASE_URL."
    );
  }
  setup();
  await withAccounts(run, false);
};

const askPassword = async (message = "Password") => {
  const first = answer(
    await password({ message, validate: (value) => validatePassword(value) })
  );
  answer(
    await password({
      message: "Repeat the password",
      validate: (value) =>
        value === first ? undefined : "The passwords don't match",
    })
  );
  return first;
};

const pickUser = async (
  accounts: AccountSummary[],
  message: string
): Promise<string | undefined> => {
  if (accounts.length === 0) {
    log.warn("No matching users.");
    return;
  }
  return answer(
    await select({
      message,
      options: accounts.map((account) => ({
        value: account.username,
        label: account.username,
        hint: account.email ?? undefined,
      })),
    })
  );
};

const addUser = () =>
  withAccounts(async (accounts) => {
    const username = answer(
      await text({
        message: "Username",
        placeholder: "jane",
        validate: (value) => validateUsername(value),
      })
    );
    const email = answer(
      await text({
        message: "Email (optional, needed to accept workspace invites)",
        placeholder: "jane@example.com",
        validate: (value) =>
          value.trim() === "" ? undefined : validateEmail(value),
      })
    );
    const secret = await askPassword();
    const s = spinner();
    s.start("Creating user…");
    try {
      const created = await accounts.add({ username, email, password: secret });
      s.stop(`Created ${created.username}.`);
    } catch (error) {
      s.stop("Not created.");
      throw error;
    }
  });

const listUsers = () =>
  withAccounts(async (accounts) => {
    const rows = await accounts.list();
    if (rows.length === 0) {
      log.info("No users yet. Pick “Add user” to create one.");
      return;
    }
    const width = Math.max(...rows.map((row) => row.username.length));
    note(
      rows
        .map(
          (row) =>
            `${row.username.padEnd(width)}  ${row.disabled ? "disabled" : "active  "}  ${row.email ?? ""}`
        )
        .join("\n"),
      `${rows.length} user${rows.length === 1 ? "" : "s"}`
    );
  });

const setUserPassword = () =>
  withAccounts(async (accounts) => {
    const username = await pickUser(
      await accounts.list(),
      "Whose password should change?"
    );
    if (username === undefined) {
      return;
    }
    const secret = await askPassword("New password");
    await accounts.setPassword(username, secret);
    log.success(`Password updated for ${username}.`);
  });

const disableUser = () =>
  withAccounts(async (accounts) => {
    const active = (await accounts.list()).filter((row) => !row.disabled);
    const username = await pickUser(active, "Which user should be disabled?");
    if (username === undefined) {
      return;
    }
    await accounts.disable(username);
    log.success(`Disabled ${username}; they can no longer sign in.`);
  });

const enableUser = () =>
  withAccounts(async (accounts) => {
    const disabled = (await accounts.list()).filter((row) => row.disabled);
    const username = await pickUser(disabled, "Which user should be enabled?");
    if (username === undefined) {
      return;
    }
    await accounts.enable(username);
    log.success(`Enabled ${username}.`);
  });

const main = async () => {
  intro("Webstudio dev CLI");

  while (true) {
    const action = answer(
      await select({
        message: "Pick an action.",
        options: [
          ...(hasDatabaseActions
            ? [
                {
                  value: "setup",
                  label: "Setup — start Postgres and run migrations",
                },
                { value: "reset", label: "Reset — destroy and re-setup" },
                {
                  value: "destroy",
                  label: "Destroy — delete the local database",
                },
              ]
            : []),
          { value: "studio", label: "Drizzle Studio — browse the database" },
          { value: "user:add", label: "─── Users — add a user" },
          { value: "user:list", label: "    List users" },
          { value: "user:password", label: "    Set a password" },
          { value: "user:disable", label: "    Disable a user" },
          { value: "user:enable", label: "    Enable a user" },
          { value: "exit", label: "Exit" },
        ],
      })
    );

    try {
      switch (action) {
        case "setup":
          setup();
          break;
        case "reset":
          if (await destroy()) {
            setup();
          }
          break;
        case "destroy":
          await destroy();
          break;
        case "studio":
          studio();
          break;
        case "user:add":
          await addUser();
          break;
        case "user:list":
          await listUsers();
          break;
        case "user:password":
          await setUserPassword();
          break;
        case "user:disable":
          await disableUser();
          break;
        case "user:enable":
          await enableUser();
          break;
        case "exit":
          return;
      }
    } catch (error) {
      log.error(
        error instanceof AccountError || error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }
};

await main();
