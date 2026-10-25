import { createDb, listen } from "@webstudio-is/db";
import { DEPLOY_JOBS_CHANNEL } from "@webstudio-is/deploy-protocol";
import { createAdapters } from "./adapters";
import { isPooledNeonUrl, loadEnv } from "./env";
import { createPublisher } from "./publisher";
import { createQueue } from "./queue";
import { createDeployerServer } from "./server";
import { createCredentialsLoader, createTargetLoader } from "./store";
import { createWorker } from "./worker";

const env = loadEnv();
const adapters = createAdapters({ sitesDir: env.DEPLOY_SITES_DIR });
const db = createDb(env.DATABASE_URL, { max: 3 });

const publisher = createPublisher({
  adapters,
  webstudioDir: env.WEBSTUDIO_DIR,
  loadTarget: createTargetLoader(db),
  loadCredentials: createCredentialsLoader({
    db,
    key: env.DEPLOY_CREDENTIALS_KEY,
  }),
  jobsDir: env.jobsDir,
  logsDir: env.logsDir,
  jobTimeoutMs: env.JOB_TIMEOUT_MS,
  keepFailedWorkdirs: env.KEEP_FAILED_WORKDIRS,
});

const worker = createWorker({
  queue: createQueue({ db, workerId: env.workerId, queue: env.DEPLOY_QUEUE }),
  publisher,
  pollIntervalMs: env.DEPLOY_POLL_INTERVAL_MS,
});

if (isPooledNeonUrl(env.DATABASE_URL)) {
  console.warn(
    "DATABASE_URL is Neon's pooled connection, which doesn't deliver notifications: jobs start on the next poll. Use the direct connection string (without -pooler)."
  );
}

const listener = listen({
  url: env.DATABASE_URL,
  channel: DEPLOY_JOBS_CHANNEL,
  onNotify: () => worker.wake(),
  // Catch up on jobs queued while the connection was down.
  onConnect: () => {
    console.info(`Listening for jobs on "${DEPLOY_JOBS_CHANNEL}"`);
    worker.wake();
  },
});

const server = createDeployerServer({
  wake: worker.wake,
  status: worker.status,
  wakeToken: env.DEPLOY_WAKE_TOKEN,
});

server.listen(env.PORT, env.HOST, () => {
  console.info(
    `Deployer ${env.workerId} (queue ${env.DEPLOY_QUEUE}) on http://${env.HOST}:${env.PORT} (GET /healthz, POST /wake)`
  );
  console.info(`Hosts: ${[...adapters.keys()].join(", ")}`);
  worker.start().catch((error) => {
    console.error(`Can't register in the database: ${String(error)}`);
    process.exit(1);
  });
});

const shutdown = (signal: string) => {
  console.info(`${signal}: no new jobs; waiting for running ones`);
  server.close();
  void listener
    .close()
    .then(() => worker.stop())
    .then(() => db.$client.end())
    .then(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
