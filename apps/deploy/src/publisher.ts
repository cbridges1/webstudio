import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AnyHostAdapter, Log } from "./adapters/types";
import type { Database } from "./database";
import { buildStaticSite } from "./site-build";
import { resolveTarget, TargetError } from "./targets";

export type PublisherOptions = {
  db: Database;
  adapters: Map<string, AnyHostAdapter>;
  webstudioDir: string;
  serviceToken: string;
  /**
   * The builder's private address for `webstudio sync`. When unset, the public origin
   * the builder sends with each publish is used.
   */
  builderUrl?: string;
  publisherHost: string;
  configPath: string;
  credentialsDir: string;
  jobsDir: string;
  logsDir: string;
  jobTimeoutMs: number;
  keepFailedWorkdirs: boolean;
  buildSite?: typeof buildStaticSite;
  consoleLog?: (line: string) => void;
};

type Job = { buildId: string; projectId: string; builderOrigin: string };

type Result = { success: true } | { success: false; error: string };

export const createPublisher = (options: PublisherOptions) => {
  const {
    db,
    adapters,
    buildSite = buildStaticSite,
    consoleLog = (line) => console.info(line),
  } = options;
  const queued = new Set<string>();
  let chain = Promise.resolve();
  let running: string | undefined;

  const target = (projectId: string) =>
    resolveTarget({
      projectId,
      configPath: options.configPath,
      credentialsDir: options.credentialsDir,
      adapters,
    });

  const fail = async (buildId: string, error: string): Promise<Result> => {
    // The builder created this build as PENDING before calling us; don't leave it hanging.
    await db.setPublishStatus(buildId, "FAILED").catch((dbError) => {
      consoleLog(
        `[${buildId}] could not mark build FAILED: ${String(dbError)}`
      );
    });
    consoleLog(`[${buildId}] rejected: ${error}`);
    return { success: false, error };
  };

  const runJob = async (job: Job) => {
    running = job.buildId;
    await mkdir(options.logsDir, { recursive: true });
    const logFile = createWriteStream(
      join(options.logsDir, `${job.buildId}.log`),
      {
        flags: "a",
      }
    );
    const log: Log = (line) => {
      logFile.write(`${new Date().toISOString()} ${line}\n`);
      consoleLog(`[${job.buildId}] ${line}`);
    };
    const workDir = join(options.jobsDir, job.buildId);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(`timed out after ${options.jobTimeoutMs} ms`),
      options.jobTimeoutMs
    );
    let failed = false;
    try {
      log(`Publishing project ${job.projectId} (build ${job.buildId})`);
      // Read again: the config may have changed while the job waited.
      const { adapter, config, credentials } = await target(job.projectId);
      await rm(workDir, { recursive: true, force: true });
      await mkdir(options.jobsDir, { recursive: true });
      const buildDir = await buildSite({
        webstudioDir: options.webstudioDir,
        workDir,
        buildId: job.buildId,
        builderOrigin: job.builderOrigin,
        serviceToken: options.serviceToken,
        log,
        signal: controller.signal,
      });
      log(`Deploying with ${adapter.id}`);
      const { url } = await adapter.deploy({
        buildDir,
        config,
        credentials,
        log,
      });
      await db.setPublishedUrl(job.projectId, url);
      await db.setPublishStatus(job.buildId, "PUBLISHED");
      log(`Published ${url}`);
    } catch (error) {
      failed = true;
      log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
      await db.setPublishStatus(job.buildId, "FAILED").catch((dbError) => {
        log(`Could not mark build FAILED: ${String(dbError)}`);
      });
    } finally {
      clearTimeout(timeout);
      if (failed === false || options.keepFailedWorkdirs === false) {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
      await new Promise<void>((resolve) => logFile.end(resolve));
      queued.delete(job.buildId);
      running = undefined;
    }
  };

  return {
    status: () => ({ running, queued: queued.size }),

    /** Validates synchronously so configuration problems show in the Publish dialog. */
    async publish(input: {
      buildId: string;
      builderOrigin: string;
      destination: "saas" | "static";
    }): Promise<Result> {
      if (input.destination === "static") {
        return fail(
          input.buildId,
          "Static download isn't supported here. Use Publish instead."
        );
      }
      const build = await db.getBuild(input.buildId);
      if (build === undefined) {
        return { success: false, error: `Build ${input.buildId} not found` };
      }
      // Upstream marks a publish to only the project's own domain as "staging" and one that
      // includes a custom domain as "production". Each project has exactly one host here, so
      // both go to the same place.
      try {
        await target(build.projectId);
      } catch (error) {
        if (error instanceof TargetError) {
          return fail(input.buildId, error.message);
        }
        throw error;
      }
      if (queued.has(input.buildId)) {
        return { success: true };
      }
      queued.add(input.buildId);
      const job = {
        buildId: input.buildId,
        projectId: build.projectId,
        builderOrigin: options.builderUrl ?? input.builderOrigin,
      };
      chain = chain
        .then(() => runJob(job))
        .catch((error) => {
          consoleLog(`[${job.buildId}] job crashed: ${String(error)}`);
          queued.delete(job.buildId);
          running = undefined;
        });
      return { success: true };
    },

    async unpublish({ domain }: { domain: string }): Promise<Result> {
      const suffix = `.${options.publisherHost}`;
      if (domain.endsWith(suffix) === false) {
        // Custom domains are managed by users at their host.
        return { success: true };
      }
      const projectDomain = domain.slice(0, -suffix.length);
      const projectId = await db.findProjectIdByDomain(projectDomain);
      if (projectId === undefined) {
        return {
          success: false,
          error: `No project with domain ${projectDomain}`,
        };
      }
      try {
        const { adapter, config, credentials } = await target(projectId);
        const log: Log = (line) =>
          consoleLog(`[unpublish ${projectId}] ${line}`);
        await adapter.remove({ config, credentials, log });
        await db.clearPublishedUrl(projectId);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        consoleLog(`[unpublish ${projectId}] FAILED: ${message}`);
        return { success: false, error: message };
      }
    },

    /** Resolves when every queued job has finished (tests and shutdown). */
    idle: () => chain,
  };
};

export type Publisher = ReturnType<typeof createPublisher>;
