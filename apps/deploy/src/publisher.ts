import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deployReportPath,
  publishRequest,
  type DeployReport,
  type DeployResult,
  type PublishRequest,
  type TargetRequest,
} from "@webstudio-is/deploy-protocol";
import type { AnyHostAdapter, Log } from "./adapters/types";
import { buildStaticSite } from "@webstudio-is/deploy-protocol/site-build";
import { describeHosts, resolveTarget, TargetError } from "./targets";
import type { LoadCredentials } from "./credentials";

export type PublisherOptions = {
  adapters: Map<string, AnyHostAdapter>;
  webstudioDir: string;
  /** Reads a project's saved credentials from the builder's database. */
  loadCredentials: LoadCredentials;
  jobsDir: string;
  logsDir: string;
  /** Queued publishes, one file each, so a restart picks them up again (resume). */
  queueDir: string;
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

  const resolve = ({ projectId, target }: TargetRequest) =>
    resolveTarget({
      projectId,
      target,
      adapters,
      loadCredentials: options.loadCredentials,
    });

  /** Validation problems go back to the caller; anything else is a bug. */
  const check = async (request: TargetRequest): Promise<DeployResult> => {
    try {
      await resolve(request);
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
      // Only now, after the build has run the project's code: read the credentials (they may
      // also have changed while the job waited).
      const { adapter, config, credentials } = await resolve(job);
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
      await rm(queueFile(job.buildId), { force: true }).catch(() => {});
      queued.delete(job.buildId);
      running = undefined;
    }
  };

  const queueFile = (buildId: string) =>
    join(options.queueDir, `${encodeURIComponent(buildId)}.json`);

  const enqueue = (job: PublishRequest) => {
    queued.add(job.buildId);
    chain = chain
      .then(() => runJob(job))
      .catch((error) => {
        consoleLog(`[${job.buildId}] job crashed: ${String(error)}`);
        queued.delete(job.buildId);
        running = undefined;
      });
  };

  return {
    status: () => ({ running, queued: queued.size }),

    hosts: () => describeHosts(adapters),

    validate: check,

    /** Checks the target right away, so problems show in the Publish dialog, then queues. */
    async publish(job: PublishRequest): Promise<DeployResult> {
      const result = await check(job);
      if (result.success === false) {
        consoleLog(`[${job.buildId}] rejected: ${result.error}`);
        return result;
      }
      if (queued.has(job.buildId)) {
        return { success: true };
      }
      // Holds the builder's publish token, so only this service's user can read it.
      await mkdir(options.queueDir, { recursive: true, mode: 0o700 });
      await writeFile(queueFile(job.buildId), JSON.stringify(job), {
        mode: 0o600,
      });
      enqueue(job);
      return { success: true };
    },

    /**
     * Queues the publishes a previous run accepted but didn't finish (a restart or a crash).
     * They run again from the start; one whose publish token has expired fails and the builder
     * times it out.
     */
    async resume() {
      const files = await readdir(options.queueDir).catch(() => []);
      let resumed = 0;
      for (const file of files
        .filter((name) => name.endsWith(".json"))
        .sort()) {
        const path = join(options.queueDir, file);
        let json: unknown;
        try {
          json = JSON.parse(await readFile(path, "utf8"));
        } catch {
          json = undefined;
        }
        const parsed = publishRequest.safeParse(json);
        if (parsed.success === false) {
          consoleLog(`Dropping unreadable queued publish ${file}`);
          await rm(path, { force: true });
          continue;
        }
        if (queued.has(parsed.data.buildId) === false) {
          consoleLog(`[${parsed.data.buildId}] resuming a queued publish`);
          enqueue(parsed.data);
          resumed += 1;
        }
      }
      return resumed;
    },

    async unpublish(request: TargetRequest): Promise<DeployResult> {
      const log: Log = (line) => consoleLog(`[unpublish] ${line}`);
      try {
        const { adapter, config, credentials } = await resolve(request);
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
