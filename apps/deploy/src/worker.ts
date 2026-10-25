// Takes jobs from the builder's database and runs them. Two lanes: publishes and unpublishes
// one at a time (builds are heavy, and a project's publish and unpublish must not overlap),
// and target checks, which are quick, beside them so a save doesn't wait behind a build.
//
// It looks for jobs when woken (a NOTIFY, POST /wake) and every pollIntervalMs, so a missed
// notification only delays a job.
import {
  publishJobRequest,
  type DeployResult,
} from "@webstudio-is/deploy-protocol";
import type { Publisher } from "./publisher";
import type { ClaimedJob, JobKind, Queue } from "./queue";

export type WorkerOptions = {
  queue: Queue;
  publisher: Publisher;
  pollIntervalMs: number;
  /** How often a running job's heartbeat is written. */
  heartbeatMs?: number;
  /** A running job without a heartbeat for this long belonged to a worker that died. */
  staleMs?: number;
  consoleLog?: (line: string) => void;
};

const lanes: Record<string, JobKind[]> = {
  deploy: ["publish", "unpublish"],
  check: ["validate"],
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const createWorker = (options: WorkerOptions) => {
  const {
    queue,
    publisher,
    heartbeatMs = 30_000,
    staleMs = 5 * 60_000,
    consoleLog = (line) => console.info(line),
  } = options;
  const draining = new Map<string, Promise<void>>();
  const again = new Set<string>();
  let running: string | undefined;
  let stopped = false;
  let poller: NodeJS.Timeout | undefined;

  const run = async (job: ClaimedJob) => {
    const beat = setInterval(() => {
      queue.heartbeat(job.id).catch((error) => {
        consoleLog(
          `Heartbeat for job ${job.id} failed: ${errorMessage(error)}`
        );
      });
    }, heartbeatMs);
    try {
      if (job.kind === "publish") {
        const request = publishJobRequest.safeParse(job.request);
        if (request.success === false || job.buildId === null) {
          await queue.finish(job.id, {
            status: "failed",
            error: "Invalid publish job",
          });
          return;
        }
        running = job.buildId;
        const outcome = await publisher.publish({
          projectId: job.projectId,
          buildId: job.buildId,
          request: request.data,
        });
        await queue.finish(
          job.id,
          outcome.success
            ? { status: "succeeded", result: { url: outcome.url } }
            : { status: "failed", error: outcome.error }
        );
        return;
      }
      const result: DeployResult =
        job.kind === "unpublish"
          ? await publisher.unpublish(job.projectId)
          : await publisher.validate(job.projectId);
      await queue.finish(
        job.id,
        result.success
          ? { status: "succeeded" }
          : { status: "failed", error: result.error }
      );
    } catch (error) {
      consoleLog(`Job ${job.id} (${job.kind}) crashed: ${errorMessage(error)}`);
      await queue
        .finish(job.id, { status: "failed", error: errorMessage(error) })
        .catch(() => {});
    } finally {
      clearInterval(beat);
      running = undefined;
    }
  };

  /** Runs the lane's queued jobs until there are none; one drain per lane at a time. */
  const drain = (lane: string) => {
    if (stopped) {
      return;
    }
    if (draining.has(lane)) {
      // Look once more when the current drain finishes: the wake may be for a new job.
      again.add(lane);
      return;
    }
    const work = (async () => {
      do {
        again.delete(lane);
        while (stopped === false) {
          const job = await queue.claim(lanes[lane]);
          if (job === undefined) {
            break;
          }
          await run(job);
        }
      } while (again.has(lane) && stopped === false);
    })()
      .catch((error) => {
        consoleLog(`Can't read the job queue: ${errorMessage(error)}`);
      })
      .finally(() => draining.delete(lane));
    draining.set(lane, work);
  };

  const wake = () => {
    for (const lane of Object.keys(lanes)) {
      drain(lane);
    }
  };

  /** Recovers dead workers' jobs, marks this worker as seen and looks for jobs. */
  const tick = async () => {
    try {
      for (const job of await queue.recoverStale(staleMs)) {
        consoleLog(`Job ${job.id} (${job.kind}) failed: its worker kept dying`);
        const request = publishJobRequest.safeParse(job.request);
        if (job.kind === "publish" && request.success && job.buildId) {
          await publisher.reportFailure(
            {
              projectId: job.projectId,
              buildId: job.buildId,
              request: request.data,
            },
            "The deploy service stopped while running this publish"
          );
        }
      }
      await queue.touch();
    } catch (error) {
      consoleLog(`Can't reach the database: ${errorMessage(error)}`);
    }
    wake();
  };

  return {
    async start() {
      await queue.register(publisher.hosts());
      poller = setInterval(() => void tick(), options.pollIntervalMs);
      await tick();
    },

    wake,

    status: () => ({ running, lanes: [...draining.keys()] }),

    /** Takes no new jobs and resolves when the running ones have finished. */
    async stop() {
      stopped = true;
      clearInterval(poller);
      await Promise.all(draining.values());
    },

    /** Resolves when nothing is running (tests). */
    idle: async () => {
      while (draining.size > 0) {
        await Promise.all(draining.values());
      }
    },
  };
};

export type Worker = ReturnType<typeof createWorker>;
