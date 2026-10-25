// Runs one job (worker.ts picks them from the builder's database): builds and deploys a
// publish and reports it to the builder, removes an unpublished site, or checks a target.
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  deployReportPath,
  type DeployReport,
  type DeployResult,
  type PublishJobRequest,
} from "@webstudio-is/deploy-protocol";
import type { AnyHostAdapter, Log } from "./adapters/types";
import { buildStaticSite } from "@webstudio-is/deploy-protocol/site-build";
import { describeHosts, resolveTarget, TargetError } from "./targets";
import type { LoadCredentials, LoadTarget } from "./store";

export type PublisherOptions = {
  adapters: Map<string, AnyHostAdapter>;
  webstudioDir: string;
  /** Read a project's saved target and credentials from the builder's database. */
  loadTarget: LoadTarget;
  loadCredentials: LoadCredentials;
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

export type PublishJob = {
  projectId: string;
  buildId: string;
  request: PublishJobRequest;
};

export type PublishOutcome =
  | { success: true; url: string }
  | { success: false; error: string };

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

  const resolve = (projectId: string) =>
    resolveTarget({
      projectId,
      adapters,
      loadTarget: options.loadTarget,
      loadCredentials: options.loadCredentials,
    });

  /** Target problems go back to the builder; anything else is a bug. */
  const validate = async (projectId: string): Promise<DeployResult> => {
    try {
      await resolve(projectId);
      return { success: true };
    } catch (error) {
      if (error instanceof TargetError) {
        return { success: false, error: error.message };
      }
      throw error;
    }
  };

  const report = async (job: PublishJob, body: DeployReport, log: Log) => {
    const url = new URL(
      deployReportPath(job.buildId),
      job.request.builderOrigin
    );
    for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt += 1) {
      try {
        const response = await request(url, {
          method: "POST",
          headers: {
            Authorization: job.request.token,
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

  const jobLog = (buildId: string) => (line: string) =>
    consoleLog(`[${buildId}] ${line}`);

  const publish = async (job: PublishJob): Promise<PublishOutcome> => {
    await mkdir(options.logsDir, { recursive: true });
    const logFile = createWriteStream(
      join(options.logsDir, `${job.buildId}.log`),
      { flags: "a" }
    );
    const log: Log = (line) => {
      logFile.write(`${new Date().toISOString()} ${line}\n`);
      jobLog(job.buildId)(line);
    };
    const workDir = join(options.jobsDir, job.buildId);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(`timed out after ${options.jobTimeoutMs} ms`),
      options.jobTimeoutMs
    );
    let outcome: PublishOutcome;
    try {
      log(`Publishing ${job.request.label ?? "build"} (build ${job.buildId})`);
      // Fail before the build when the target can't work.
      const checked = await validate(job.projectId);
      if (checked.success === false) {
        throw new TargetError(checked.error);
      }
      await rm(workDir, { recursive: true, force: true });
      await mkdir(options.jobsDir, { recursive: true });
      const buildDir = await buildSite({
        webstudioDir: options.webstudioDir,
        workDir,
        buildId: job.buildId,
        builderOrigin: job.request.builderOrigin,
        builderToken: job.request.token,
        log,
        signal: controller.signal,
      });
      // Only now, after the build has run the project's code: read the target and the
      // credentials again (they may also have changed during the build).
      const { adapter, config, credentials } = await resolve(job.projectId);
      log(`Deploying to ${adapter.label}`);
      const { url } = await adapter.deploy({
        buildDir,
        config,
        credentials,
        log,
      });
      log(`Published ${url}`);
      outcome = { success: true, url };
      await report(job, { status: "PUBLISHED", url }, log);
    } catch (error) {
      const message = errorMessage(error);
      log(`FAILED: ${message}`);
      outcome = { success: false, error: message };
      await report(job, { status: "FAILED", error: message }, log);
    } finally {
      clearTimeout(timeout);
      await new Promise<void>((done) => logFile.end(done));
    }
    if (outcome.success || options.keepFailedWorkdirs === false) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
    return outcome;
  };

  return {
    hosts: () => describeHosts(adapters),

    validate,

    publish,

    /** Tells the builder a publish failed without running it (e.g. a worker died on it). */
    reportFailure: (job: PublishJob, error: string) =>
      report(job, { status: "FAILED", error }, jobLog(job.buildId)),

    async unpublish(projectId: string): Promise<DeployResult> {
      const log: Log = (line) => consoleLog(`[unpublish ${projectId}] ${line}`);
      try {
        const { adapter, config, credentials } = await resolve(projectId);
        await adapter.remove({ config, credentials, log });
        return { success: true };
      } catch (error) {
        const message = errorMessage(error);
        log(`FAILED: ${message}`);
        return { success: false, error: message };
      }
    },
  };
};

export type Publisher = ReturnType<typeof createPublisher>;
