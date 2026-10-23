import { createAdapters } from "./adapters";
import { createDb } from "@webstudio-is/db";
import { createDatabase } from "./database";
import { loadEnv } from "./env";
import { createPublisher } from "./publisher";
import { createDeployerServer } from "./server";

const env = loadEnv();

const publisher = createPublisher({
  db: createDatabase(createDb(env.DATABASE_URL, { max: 4 })),
  adapters: createAdapters(),
  webstudioDir: env.WEBSTUDIO_DIR,
  serviceToken: env.TRPC_SERVER_API_TOKEN,
  builderUrl: env.BUILDER_INTERNAL_URL,
  publisherHost: env.PUBLISHER_HOST,
  configPath: env.DEPLOY_CONFIG,
  credentialsDir: env.DEPLOY_CREDENTIALS_DIR,
  jobsDir: env.jobsDir,
  logsDir: env.logsDir,
  jobTimeoutMs: env.JOB_TIMEOUT_MS,
  keepFailedWorkdirs: env.KEEP_FAILED_WORKDIRS,
});

const server = createDeployerServer({
  publisher,
  token: env.TRPC_SERVER_API_TOKEN,
});

server.listen(env.PORT, env.HOST, () => {
  console.info(`Deployer listening on http://${env.HOST}:${env.PORT}`);
  console.info(`Deploy targets: ${env.DEPLOY_CONFIG}`);
});

const shutdown = (signal: string) => {
  console.info(`${signal}: no new requests; waiting for running jobs`);
  server.close();
  void publisher.idle().then(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
