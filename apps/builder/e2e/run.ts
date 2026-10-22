// Builder E2E runner: starts a disposable database, bootstraps its schema, builds the
// builder and runs Playwright. Node port of the former e2e/run.sh.
//
//   tsx e2e/run.ts [run|dev-backend|dev|schema-cache|ci-shard] [-- playwright args...]
//
// Each step has a timeout (E2E_*_TIMEOUT_SECONDS); a step that runs over is stopped
// with everything it started.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createBackend,
  isBackendMode,
  killTree,
  pnpm,
  rootDir,
  run,
  runChecked,
  runningChildren,
  stopRunningChildren,
  enableProcessGroups,
  type Env,
} from "../backend/backend";

const builderDir = join(rootDir, "apps/builder");
const env = process.env;

const [mode = "run", ...rest] = process.argv.slice(2);
const playwrightArgs = rest[0] === "--" ? rest.slice(1) : rest;

const modeDefaults: Record<string, Record<string, string>> = {
  run: {},
  "dev-backend": {
    E2E_SKIP_CLEANUP: "true",
    E2E_RUN_TESTS: "false",
    E2E_DB_BOOTSTRAP: "if-empty",
    E2E_INSTALL_PLAYWRIGHT: "false",
  },
  dev: {
    E2E_SKIP_CLEANUP: "true",
    E2E_DB_BOOTSTRAP: "if-empty",
    E2E_INSTALL_PLAYWRIGHT: "false",
    E2E_BUILDER_URL: env.E2E_BUILDER_URL || "http://localhost:3000",
  },
  "schema-cache": {
    E2E_DB_BOOTSTRAP: "migrations",
    E2E_WRITE_SCHEMA_SNAPSHOT: "true",
    E2E_RUN_TESTS: "false",
  },
  "ci-shard": {
    E2E_BACKEND_MODE: "snapshot",
    E2E_BUILD_DATABASE_IMAGE: "false",
    E2E_SKIP_BUILDER_BUILD: "true",
    E2E_SKIP_CLEANUP: "true",
  },
};
const defaults = modeDefaults[mode];
if (defaults === undefined) {
  console.error(`Unknown Builder E2E mode: ${mode}`);
  process.exit(1);
}
// Mode settings win, as the shell runner's exports did.
Object.assign(env, defaults);

const setting = (name: string, fallback: string) => {
  env[name] ||= fallback;
  return env[name];
};
const seconds = (name: string, fallback: number) =>
  Number(setting(name, String(fallback)));

env.PGPORT = env.E2E_PGPORT || "55434";
env.POSTGRES_DB = env.E2E_POSTGRES_DB || "webstudio";
env.POSTGRES_USER = env.E2E_POSTGRES_USER || "webstudio";
env.POSTGRES_PASSWORD = env.E2E_POSTGRES_PASSWORD || "pass";
env.DATABASE_URL =
  env.E2E_DATABASE_URL ||
  `postgresql://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@localhost:${env.PGPORT}/${env.POSTGRES_DB}`;
env.DIRECT_URL = env.E2E_DIRECT_URL || env.DATABASE_URL;
// Every test signs in with a username and password; turn off the sign-in rate limit.
setting("AUTH_RATE_LIMIT", "false");
// Tests store assets as files: empty S3_* values override apps/builder/.env's RustFS.
for (const name of [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
]) {
  env[name] ??= "";
}

const backendMode = setting("E2E_BACKEND_MODE", "test");
if (isBackendMode(backendMode) === false) {
  console.error(`Unknown Builder E2E backend mode: ${backendMode}`);
  process.exit(1);
}
const backend = createBackend({ mode: backendMode, env });

const dbBootstrap = setting("E2E_DB_BOOTSTRAP", "auto");
const buildDatabaseImage =
  setting("E2E_BUILD_DATABASE_IMAGE", "false") === "true";
const dockerPullTimeout = seconds("E2E_DOCKER_PULL_TIMEOUT_SECONDS", 300);
const dockerTimeout = seconds("E2E_DOCKER_TIMEOUT_SECONDS", 60);
const migrationsTimeout = seconds("E2E_MIGRATIONS_TIMEOUT_SECONDS", 300);
const installPlaywright = setting("E2E_INSTALL_PLAYWRIGHT", "auto");
const playwrightInstallTimeout = seconds(
  "E2E_PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS",
  600
);
const runTests = setting("E2E_RUN_TESTS", "true") === "true";
const builderBuildTimeout = seconds("E2E_BUILDER_BUILD_TIMEOUT_SECONDS", 600);
const testCommandTimeout = seconds("E2E_TEST_COMMAND_TIMEOUT_SECONDS", 900);
const testSelectionTimeout = seconds("E2E_TEST_SELECTION_TIMEOUT_SECONDS", 60);
const writeSchemaSnapshot =
  setting("E2E_WRITE_SCHEMA_SNAPSHOT", "false") === "true";
const terminationGrace = seconds("RUN_STEP_TERMINATION_GRACE_SECONDS", 10);

enableProcessGroups();

const cleanup = async () => {
  if (env.E2E_SKIP_CLEANUP === "true") {
    return;
  }
  await backend.down("--volumes", "--remove-orphans").catch((error: Error) => {
    console.error(error.message);
  });
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    stopRunningChildren();
    await cleanup();
    process.exit(130);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class StepTimeout extends Error {}

/** Runs one step with a timeout, stopping everything it started when it runs over. */
const runStep = async (
  name: string,
  timeoutSeconds: number,
  step: () => Promise<unknown>
) => {
  console.info(`▶ ${name}`);
  const startedAt = Date.now();
  const duration = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StepTimeout()), timeoutSeconds * 1000);
  });
  try {
    await Promise.race([step(), timeout]);
    console.info(`✓ ${name} (${duration()})`);
  } catch (error) {
    if (error instanceof StepTimeout) {
      console.error(`Timed out after ${timeoutSeconds}s: ${name}`);
      const children = [...runningChildren];
      children.forEach((child) => killTree(child, "SIGTERM"));
      await sleep(terminationGrace * 1000);
      children.forEach((child) => killTree(child, "SIGKILL"));
    } else {
      console.error(`✗ ${name} (${duration()})`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const playwrightCli = join(builderDir, "node_modules/@playwright/test/cli.js");

/** `pnpm e2e:ci`: Playwright with the builder's env files. */
const e2eCi = (args: string[], extraEnv: Env = {}) =>
  runChecked(
    process.execPath,
    [
      "--env-file=.env",
      "--env-file-if-exists=.env.development",
      "--conditions=webstudio",
      playwrightCli,
      "test",
      "--config=playwright.config.ts",
      ...args,
    ],
    { cwd: builderDir, env: { ...env, ...extraEnv } }
  );

const bootstrapDatabase = async () => {
  if (dbBootstrap === "if-empty") {
    await backend.bootstrapIfEmpty();
  } else if (
    dbBootstrap === "auto" ||
    dbBootstrap === "schema" ||
    dbBootstrap === "migrations"
  ) {
    await backend.bootstrap(dbBootstrap);
  } else {
    throw new Error(`Unknown database bootstrap mode: ${dbBootstrap}`);
  }
  if (writeSchemaSnapshot) {
    await backend.writeSchemaSnapshot();
  }
};

const installPlaywrightBrowser = async () => {
  // selfhost: tests run in Google Chrome by default (see playwright.config.ts).
  const browser = env.E2E_BROWSER_CHANNEL || "chrome";
  const install = () =>
    runChecked(
      process.execPath,
      [playwrightCli, "install", "--with-deps", browser],
      { cwd: builderDir, env }
    );
  const browserExists = async () =>
    (
      await run(
        process.execPath,
        [
          "-e",
          `require("@playwright/test").chromium
            .launch({ channel: process.env.E2E_BROWSER_CHANNEL })
            .then((instance) => instance.close())
            .then(() => process.exit(0), () => process.exit(1));`,
        ],
        {
          cwd: builderDir,
          env: { ...env, E2E_BROWSER_CHANNEL: browser },
          quiet: true,
        }
      )
    ).code === 0;

  if (installPlaywright === "true") {
    await install();
  } else if (installPlaywright === "auto") {
    if (await browserExists()) {
      console.info(
        `Skipping Playwright browser install; ${browser} is already installed`
      );
    } else {
      await install();
    }
  } else if (installPlaywright === "false") {
    console.info("Skipping Playwright Chromium install");
  } else {
    throw new Error(
      `Unknown E2E_INSTALL_PLAYWRIGHT value: ${installPlaywright}`
    );
  }
};

const verifyBuilderBuilt = async () => {
  if (
    existsSync(join(builderDir, "build/server")) === false ||
    existsSync(join(builderDir, "build/client/assets")) === false
  ) {
    throw new Error(
      "E2E_SKIP_BUILDER_BUILD requires prebuilt Builder artifacts"
    );
  }
};

try {
  if (runTests) {
    await runStep(
      "validate builder e2e test selection",
      testSelectionTimeout,
      () =>
        e2eCi(["--list", ...playwrightArgs], {
          E2E_BUILDER_URL: env.E2E_BUILDER_URL || "http://localhost:3000",
        })
    );
  }
  await runStep("prepare e2e database image", dockerPullTimeout, () =>
    buildDatabaseImage ? backend.buildDb() : backend.pullDb()
  );
  await runStep("start e2e database", dockerTimeout, () => backend.start());
  await runStep("wait for e2e database", dockerTimeout, () =>
    backend.waitForDb(dockerTimeout)
  );
  await runStep(
    "bootstrap database schema",
    migrationsTimeout,
    bootstrapDatabase
  );

  if (runTests) {
    await runStep(
      "install playwright chromium",
      playwrightInstallTimeout,
      installPlaywrightBrowser
    );
    if (!env.E2E_BUILDER_URL) {
      if (env.E2E_SKIP_BUILDER_BUILD === "true") {
        await runStep(
          "verify prebuilt builder artifacts",
          builderBuildTimeout,
          verifyBuilderBuilt
        );
      } else {
        await runStep(
          "build builder and generated preview dependencies",
          builderBuildTimeout,
          () => pnpm(["--dir", rootDir, "e2e:builder:build"], { env })
        );
      }
    }
    await runStep("run builder e2e tests", testCommandTimeout, () =>
      e2eCi(playwrightArgs)
    );
  }
} catch (error) {
  if (error instanceof Error && error.message !== "") {
    console.error(error.message);
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}
