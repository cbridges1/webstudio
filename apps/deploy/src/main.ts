import { createAdapters } from "./adapters";
import { loadEnv } from "./env";
import { createPublisher } from "./publisher";
import { createDeployerServer } from "./server";

const env = loadEnv();
const adapters = createAdapters({ sitesDir: env.DEPLOY_SITES_DIR });

const publisher = createPublisher({
  adapters,
  webstudioDir: env.WEBSTUDIO_DIR,
  credentialsDir: env.DEPLOY_CREDENTIALS_DIR,
  jobsDir: env.jobsDir,
  logsDir: env.logsDir,
  jobTimeoutMs: env.JOB_TIMEOUT_MS,
  keepFailedWorkdirs: env.KEEP_FAILED_WORKDIRS,
});

const server = createDeployerServer({ publisher, apiKey: env.DEPLOY_API_KEY });

server.listen(env.PORT, env.HOST, () => {
  console.info(`Deployer listening on http://${env.HOST}:${env.PORT}`);
  console.info(`Hosts: ${[...adapters.keys()].join(", ")}`);
  console.info(`Credentials: ${env.DEPLOY_CREDENTIALS_DIR}`);
});

const shutdown = (signal: string) => {
  console.info(`${signal}: no new requests; waiting for running jobs`);
  server.close();
  void publisher.idle().then(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
