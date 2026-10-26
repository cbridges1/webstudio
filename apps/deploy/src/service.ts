// The deploy service's worker: takes jobs from the builder's database (LISTEN/NOTIFY and
// polling) and runs them. main.ts runs it as its own service, with an HTTP server for /healthz
// and /wake; the builder runs it in its own process when its deployer mode is "builtin".
import { createDb, listen, type Db } from "@webstudio-is/db";
import { DEPLOY_JOBS_CHANNEL } from "@webstudio-is/deploy-protocol";
import { createAdapters } from "./adapters";
import { createPublisher } from "./publisher";
import { createQueue } from "./queue";
import { createCredentialsLoader, createTargetLoader } from "./store";
import { createWorker } from "./worker";

export type DeployServiceOptions = {
  databaseUrl: string;
  /** A database client to use instead of opening one (the builder shares its own). */
  db?: Db;
  credentialsKey?: string;
  workerId: string;
  queue: string;
  pollIntervalMs: number;
  /** The Webstudio checkout whose CLI and packages build the sites. */
  webstudioDir: string;
  jobsDir: string;
  logsDir: string;
  /** Root for the "directory" host; without it that host is off. */
  sitesDir?: string;
  jobTimeoutMs: number;
  keepFailedWorkdirs: boolean;
};

export const createDeployService = (options: DeployServiceOptions) => {
  const adapters = createAdapters({ sitesDir: options.sitesDir });
  // Its own client when not given one, closed on stop.
  const ownDb =
    options.db === undefined
      ? createDb(options.databaseUrl, { max: 3 })
      : undefined;
  const db: Db = options.db ?? ownDb!;

  const publisher = createPublisher({
    adapters,
    webstudioDir: options.webstudioDir,
    loadTarget: createTargetLoader(db),
    loadCredentials: createCredentialsLoader({
      db,
      key: options.credentialsKey,
    }),
    jobsDir: options.jobsDir,
    logsDir: options.logsDir,
    jobTimeoutMs: options.jobTimeoutMs,
    keepFailedWorkdirs: options.keepFailedWorkdirs,
  });

  const worker = createWorker({
    queue: createQueue({
      db,
      workerId: options.workerId,
      queue: options.queue,
    }),
    publisher,
    pollIntervalMs: options.pollIntervalMs,
  });

  let listener: ReturnType<typeof listen> | undefined;

  return {
    hosts: () => [...adapters.keys()],

    wake: worker.wake,

    status: worker.status,

    /** Registers this worker in the database and starts taking jobs. */
    async start() {
      listener = listen({
        url: options.databaseUrl,
        channel: DEPLOY_JOBS_CHANNEL,
        onNotify: () => worker.wake(),
        // Catch up on jobs queued while the connection was down.
        onConnect: () => {
          console.info(`Listening for jobs on "${DEPLOY_JOBS_CHANNEL}"`);
          worker.wake();
        },
      });
      await worker.start();
    },

    /** Takes no new jobs and resolves when the running ones have finished. */
    async stop() {
      await listener?.close();
      await worker.stop();
      await ownDb?.$client.end();
    },
  };
};

export type DeployService = ReturnType<typeof createDeployService>;
