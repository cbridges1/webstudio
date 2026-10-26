import { isPooledNeonUrl, loadEnv } from "./env";
import { createDeployerServer } from "./server";
import { createDeployService } from "./service";

const env = loadEnv();

const service = createDeployService({
  databaseUrl: env.DATABASE_URL,
  credentialsKey: env.DEPLOY_CREDENTIALS_KEY,
  workerId: env.workerId,
  queue: env.DEPLOY_QUEUE,
  pollIntervalMs: env.DEPLOY_POLL_INTERVAL_MS,
  webstudioDir: env.WEBSTUDIO_DIR,
  jobsDir: env.jobsDir,
  logsDir: env.logsDir,
  sitesDir: env.DEPLOY_SITES_DIR,
  jobTimeoutMs: env.JOB_TIMEOUT_MS,
  keepFailedWorkdirs: env.KEEP_FAILED_WORKDIRS,
});

if (isPooledNeonUrl(env.DATABASE_URL)) {
  console.warn(
    "DATABASE_URL is Neon's pooled connection, which doesn't deliver notifications: jobs start on the next poll. Use the direct connection string (without -pooler)."
  );
}

const server = createDeployerServer({
  wake: service.wake,
  status: service.status,
  wakeToken: env.DEPLOY_WAKE_TOKEN,
});

server.listen(env.PORT, env.HOST, () => {
  console.info(
    `Deployer ${env.workerId} (queue ${env.DEPLOY_QUEUE}) on http://${env.HOST}:${env.PORT} (GET /healthz, POST /wake)`
  );
  console.info(`Hosts: ${service.hosts().join(", ")}`);
  service.start().catch((error) => {
    console.error(`Can't register in the database: ${String(error)}`);
    process.exit(1);
  });
});

const shutdown = (signal: string) => {
  console.info(`${signal}: no new jobs; waiting for running ones`);
  server.close();
  void service.stop().then(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
