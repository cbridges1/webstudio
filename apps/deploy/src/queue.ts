// The job queue in the builder's database (DeployJob, DeployWorker), as this service sees it.
// Its database login may read DeployJob, update its progress columns and write DeployWorker.
import {
  deployJob,
  deployWorker,
  eq,
  sql,
  type Db,
  type Json,
} from "@webstudio-is/db";
import type { HostInfo } from "@webstudio-is/deploy-protocol";

export type JobKind = (typeof deployJob.kind.enumValues)[number];

export type ClaimedJob = {
  id: string;
  kind: JobKind;
  projectId: string;
  buildId: string | null;
  request: unknown;
  attempts: number;
};

/** A job is given up after this many runs that a worker died during. */
export const MAX_ATTEMPTS = 3;

export const createQueue = ({
  db,
  workerId,
  queue = "default",
}: {
  db: Db;
  workerId: string;
  /** Only this queue's jobs (DEPLOY_QUEUE). */
  queue?: string;
}) => ({
  /** Takes the oldest queued job of these kinds, or undefined; other workers skip it. */
  async claim(kinds: JobKind[]): Promise<ClaimedJob | undefined> {
    const { rows } = await db.execute<ClaimedJob>(sql`
      UPDATE "DeployJob"
      SET "status" = 'running', "workerId" = ${workerId}, "attempts" = "attempts" + 1,
        "startedAt" = now(), "heartbeatAt" = now()
      WHERE "id" = (
        SELECT "id" FROM "DeployJob"
        WHERE "queue" = ${queue}
          AND "status" = 'queued'
          AND "kind" IN (${sql.join(
            kinds.map((kind) => sql`${kind}`),
            sql`, `
          )})
        ORDER BY "createdAt"
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "kind", "projectId", "buildId", "request", "attempts"
    `);
    return rows[0];
  },

  /** Keeps a running job ours (see recoverStale). */
  async heartbeat(jobId: string) {
    await db
      .update(deployJob)
      .set({ heartbeatAt: sql`now()` })
      .where(eq(deployJob.id, jobId));
  },

  async finish(
    jobId: string,
    outcome:
      | { status: "succeeded"; result?: Json }
      | { status: "failed"; error: string }
  ) {
    await db
      .update(deployJob)
      .set({
        status: outcome.status,
        error: outcome.status === "failed" ? outcome.error : null,
        result:
          outcome.status === "succeeded" ? (outcome.result ?? null) : null,
        finishedAt: sql`now()`,
      })
      .where(eq(deployJob.id, jobId));
  },

  /**
   * Running jobs whose worker stopped heartbeating (it crashed or was killed): queued again,
   * or failed after MAX_ATTEMPTS. Returns the failed ones, for reporting.
   */
  async recoverStale(staleMs: number) {
    const { rows } = await db.execute<ClaimedJob & { status: string }>(sql`
      UPDATE "DeployJob"
      SET "status" = (CASE WHEN "attempts" >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END)::"DeployJobStatus",
        "error" = CASE WHEN "attempts" >= ${MAX_ATTEMPTS}
          THEN 'The deploy service stopped while running this job, ' || "attempts" || ' times'
          ELSE "error" END,
        "finishedAt" = CASE WHEN "attempts" >= ${MAX_ATTEMPTS} THEN now() ELSE NULL END,
        "workerId" = NULL
      WHERE "queue" = ${queue}
        AND "status" = 'running'
        AND "heartbeatAt" < now() - make_interval(secs => ${staleMs / 1000})
      RETURNING "id", "kind", "projectId", "buildId", "request", "attempts", "status"
    `);
    return rows.filter((row) => row.status === "failed");
  },

  /** Registers this worker and its hosts, and marks it as seen. */
  async register(hosts: HostInfo[]) {
    await db
      .insert(deployWorker)
      .values({ id: workerId, queue, hosts: hosts as Json })
      .onConflictDoUpdate({
        target: deployWorker.id,
        set: { queue, hosts: hosts as Json, seenAt: sql`now()` },
      });
    // Workers gone for a long time (renamed, removed) would only confuse the builder.
    await db.execute(
      sql`DELETE FROM "DeployWorker" WHERE "seenAt" < now() - interval '30 days'`
    );
  },

  async touch() {
    await db
      .update(deployWorker)
      .set({ seenAt: sql`now()` })
      .where(eq(deployWorker.id, workerId));
  },
});

export type Queue = ReturnType<typeof createQueue>;
