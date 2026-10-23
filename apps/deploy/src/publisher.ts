import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  deployReportPath,
  type DeployReport,
  type DeployResult,
  type DeployTarget,
  type PublishRequest,
} from "@webstudio-is/deploy-protocol";
import type { AnyHostAdapter, Log } from "./adapters/types";
import { buildStaticSite } from "./site-build";
import { describeHosts, resolveTarget, TargetError } from "./targets";

export type PublisherOptions = {
  adapters: Map<string, AnyHostAdapter>;
  webstudioDir: string;
  credentialsDir: string;
  jobsDir: string;
  logsDir: string;
  jobTimeoutMs: number;
  keepFailedWorkdirs: boolean;
  buildSite?: typeof buildStaticSite;
  /** Sends reports to the builder. */
  fetch?: typeof globalThis.fetch;
  /** Waits between report attempts (tests skip it). */
  reportRetryDelayMs?: number;
  consoleLog?: (line: string) => void;
};

const REPORT_ATTEMPTS = 5;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const createPublisher = (options: PublisherOptions) => {
  const {
    adapters,
    buildSite = buildStaticSite,
    fetch: request = globalThis.fetch,
    reportRetryDelayMs = 2000,
    consoleLog = (line) => console.info(line),
  } = options;
  const queued = new Set<string>();
  let chain = Promise.resolve();
  let running: string | undefined;

  const resolve = (target: DeployTarget) =>
    resolveTarget({
      target,
      credentialsDir: options.credentialsDir,
      adapters,
    });

  /** Validation problems go back to the caller; anything else is a bug. */
  const check = async (target: DeployTarget): Promise<DeployResult> => {
    try {
      await resolve(target);
      return { success: true };
    } catch (error) {
      if (error instanceof TargetError) {
        return { success: false, error: error.message };
      }
      throw error;
    }
  };

  const report = async (job: PublishRequest, body: DeployReport, log: Log) => {
    const url = new URL(deployReportPath(job.buildId), job.builder.origin);
    for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt += 1) {
      try {
        const response = await request(url, {
          method: "POST",
          headers: {
            Authorization: job.builder.token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        if (response.ok) {
          return;
        }
        log(
          `Report ${body.status} rejected by the builder (${response.status})`
        );
        if (response.status < 500) {
          return;
        }
      } catch (error) {
        log(`Report ${body.status} failed: ${errorMessage(error)}`);
      }
      if (attempt < REPORT_ATTEMPTS) {
        await new Promise((done) =>
          setTimeout(done, reportRetryDelayMs * attempt)
        );
      }
    }
    log(
      `Gave up reporting ${body.status}; the builder will time the publish out`
    );
  };

  const runJob = async (job: PublishRequest) => {
    running = job.buildId;
    await mkdir(options.logsDir, { recursive: true });
    const logFile = createWriteStream(
      join(options.logsDir, `${job.buildId}.log`),
      { flags: "a" }
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
      log(`Publishing ${job.label ?? "build"} (build ${job.buildId})`);
      // Again: the credentials may have changed while the job waited.
      const { adapter, config, credentials } = await resolve(job.target);
      await rm(workDir, { recursive: true, force: true });
      await mkdir(options.jobsDir, { recursive: true });
      const buildDir = await buildSite({
        webstudioDir: options.webstudioDir,
        workDir,
        buildId: job.buildId,
        builderOrigin: job.builder.origin,
        builderToken: job.builder.token,
        log,
        signal: controller.signal,
      });
      log(`Deploying to ${adapter.label}`);
      const { url } = await adapter.deploy({
        buildDir,
        config,
        credentials,
        log,
      });
      log(`Published ${url}`);
      await report(job, { status: "PUBLISHED", url }, log);
    } catch (error) {
      failed = true;
      const message = errorMessage(error);
      log(`FAILED: ${message}`);
      await report(job, { status: "FAILED", error: message }, log);
    } finally {
      clearTimeout(timeout);
      if (failed === false || options.keepFailedWorkdirs === false) {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
      await new Promise<void>((done) => logFile.end(done));
      queued.delete(job.buildId);
      running = undefined;
    }
  };

  return {
    status: () => ({ running, queued: queued.size }),

    hosts: () =>
      describeHosts({ credentialsDir: options.credentialsDir, adapters }),

    validate: check,

    /** Checks the target right away, so problems show in the Publish dialog, then queues. */
    async publish(job: PublishRequest): Promise<DeployResult> {
      const result = await check(job.target);
      if (result.success === false) {
        consoleLog(`[${job.buildId}] rejected: ${result.error}`);
        return result;
      }
      if (queued.has(job.buildId)) {
        return { success: true };
      }
      queued.add(job.buildId);
      chain = chain
        .then(() => runJob(job))
        .catch((error) => {
          consoleLog(`[${job.buildId}] job crashed: ${String(error)}`);
          queued.delete(job.buildId);
          running = undefined;
        });
      return { success: true };
    },

    async unpublish(target: DeployTarget): Promise<DeployResult> {
      const log: Log = (line) => consoleLog(`[unpublish] ${line}`);
      try {
        const { adapter, config, credentials } = await resolve(target);
        await adapter.remove({ config, credentials, log });
        return { success: true };
      } catch (error) {
        const message = errorMessage(error);
        log(`FAILED: ${message}`);
        return { success: false, error: message };
      }
    },

    /** Resolves when every queued job has finished (tests and shutdown). */
    idle: () => chain,
  };
};

export type Publisher = ReturnType<typeof createPublisher>;
