// selfhost: the deployer mode, and the deploy service's worker when this builder runs it itself.
//
// "builtin" (the default): this builder runs the deploy service's worker
// (@webstudio-is/deploy/service) in its own process, so nothing else needs to be deployed.
// Publishes then use this process's CPU and memory, so on a platform that throttles CPU between
// requests (Cloud Run's default) it must be always allocated. Builds run project code (child
// processes get only createBuildEnv's variables, but the same user and machine as the
// builder), so this mode trusts everyone who can publish. "separate": a deploy service
// (apps/deploy) runs on its own and takes jobs from this builder's database.
//
// The mode is what an app admin saved in Settings → Deployer, else DEPLOYER_MODE, else
// "builtin". Every builder process applies it when it queues or lists jobs, and once a minute,
// so a change reaches every instance.
import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deploySettings, getDb, maybeOne, type Db } from "@webstudio-is/db";
import {
  createDeployService,
  type DeployService,
} from "@webstudio-is/deploy/service";
import env from "~/env/env.server";

export const deployerModes = ["separate", "builtin"] as const;
export type DeployerMode = (typeof deployerModes)[number];

export type ResolvedDeployerMode = {
  mode: DeployerMode;
  /** Where it comes from: Settings → Deployer, DEPLOYER_MODE, or neither. */
  source: "app" | "env" | "default";
  /** DEPLOYER_MODE, what the mode falls back to without an app setting. */
  envMode: DeployerMode | null;
};

const isMode = (value: unknown): value is DeployerMode =>
  deployerModes.includes(value as DeployerMode);

export const resolveDeployerMode = async (
  db: Db
): Promise<ResolvedDeployerMode> => {
  const envMode = env.DEPLOYER_MODE ?? null;
  const saved = maybeOne(
    await db.select({ mode: deploySettings.mode }).from(deploySettings)
  )?.mode;
  if (isMode(saved)) {
    return { mode: saved, source: "app", envMode };
  }
  if (envMode !== null) {
    return { mode: envMode, source: "env", envMode };
  }
  return { mode: "builtin", source: "default", envMode };
};

/** The checkout the builder runs from: its CLI and packages build the sites. */
const findCheckout = () => {
  let dir = resolve(process.cwd());
  while (existsSync(join(dir, "pnpm-workspace.yaml")) === false) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        "The builder isn't running from a Webstudio checkout, so it can't build sites itself"
      );
    }
    dir = parent;
  }
  return dir;
};

type State = {
  service?: DeployService;
  /** Starting or stopping; applied one at a time. */
  change?: Promise<void>;
  timer?: NodeJS.Timeout;
};

declare global {
  // Kept across dev-server reloads, so a reload doesn't start a second worker.
  // eslint-disable-next-line no-var
  var webstudioBuiltinDeployer: State | undefined;
}

const state = (globalThis.webstudioBuiltinDeployer ??= {});

const start = async (db: Db) => {
  const dataDir = resolve(
    env.DEPLOYER_DATA_DIR ?? join(tmpdir(), "webstudio-deployer")
  );
  const service = createDeployService({
    databaseUrl: env.DATABASE_URL,
    db,
    credentialsKey: env.DEPLOY_CREDENTIALS_KEY,
    // Named per queue: builders sharing a machine and database (a dev server and a container)
    // each register their own.
    workerId: `builder-${hostname()}${env.DEPLOYER_QUEUE ? `-${env.DEPLOYER_QUEUE}` : ""}`,
    queue: env.DEPLOYER_QUEUE ?? "default",
    pollIntervalMs: 15_000,
    webstudioDir: findCheckout(),
    jobsDir: join(dataDir, "jobs"),
    logsDir: join(dataDir, "logs"),
    sitesDir:
      env.DEPLOY_SITES_DIR === undefined
        ? undefined
        : resolve(env.DEPLOY_SITES_DIR),
    jobTimeoutMs: 15 * 60 * 1000,
    keepFailedWorkdirs: false,
  });
  await service.start();
  state.service = service;
  console.info(
    `Built-in deployer started (hosts: ${service.hosts().join(", ")})`
  );
};

const stop = async () => {
  const service = state.service;
  state.service = undefined;
  if (service !== undefined) {
    console.info("Built-in deployer stopping; running jobs finish first");
    await service.stop();
  }
};

/**
 * Starts or stops the built-in worker to match the mode. Returns the mode. Never throws: a
 * worker that can't start is logged, and publishes then report that no deploy service runs.
 */
export const applyDeployerMode = async (
  db: Db = getDb(env.DATABASE_URL)
): Promise<ResolvedDeployerMode | undefined> => {
  state.timer ??= setInterval(() => {
    void applyDeployerMode(db);
  }, 60_000).unref();
  let resolved: ResolvedDeployerMode;
  try {
    resolved = await resolveDeployerMode(db);
  } catch (error) {
    console.warn(`Can't read the deployer mode: ${String(error)}`);
    return;
  }
  const change = (state.change ?? Promise.resolve()).then(async () => {
    const running = state.service !== undefined;
    if (resolved.mode === "builtin" && running === false) {
      await start(db);
    } else if (resolved.mode === "separate" && running) {
      await stop();
    }
  });
  state.change = change.catch((error) => {
    console.error(`Built-in deployer: ${String(error)}`);
  });
  await state.change;
  return resolved;
};

/**
 * Applies the mode now and then every minute, once per process; later calls do nothing. So a
 * restarted builder takes queued jobs without waiting for a publish.
 */
export const watchDeployerMode = () => {
  if (state.timer === undefined) {
    void applyDeployerMode();
  }
};

/** Looks for queued jobs now, when the built-in worker runs. */
export const wakeBuiltinDeployer = () => {
  state.service?.wake();
};
