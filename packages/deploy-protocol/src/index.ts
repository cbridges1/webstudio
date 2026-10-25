// selfhost: what the builder and a deploy service (apps/deploy) share.
//
// They share the builder's database. The builder queues jobs (DeployJob: publish, unpublish,
// validate) and sends NOTIFY on DEPLOY_JOBS_CHANNEL; the deploy service LISTENs, also polls
// for notifications it missed, claims each job with FOR UPDATE SKIP LOCKED and records the
// outcome on it. It registers itself and its hosts (hostInfo) in DeployWorker. The builder can
// also POST to a wake URL whenever it queues a job, e.g. the deploy service's own
// deployPaths.wake, to start a stopped service.
//
// A project's target (ProjectDeployTarget: host, config and credentials) is read by the deploy
// service from the database when the job runs. Credentials are stored encrypted (see
// ./credentials) and decrypted with DEPLOY_CREDENTIALS_KEY; the deploy service keeps them in
// memory for the job only and never logs, stores or returns them.
//
// A publish downloads the build from the builder (`builderOrigin`, with the job's token) and
// reports the result to `builderOrigin` + deployReportPath, `Authorization: <token>`.
import { z } from "zod";

/** The Postgres channel the builder notifies when it queues a job (the payload is its ID). */
export const DEPLOY_JOBS_CHANNEL = "deploy_jobs";

/** A host's credentials, e.g. a Firebase service account key. A secret. */
export const deployCredentials = z.record(z.string(), z.unknown());
export type DeployCredentials = z.infer<typeof deployCredentials>;

/** Where a project deploys: a host on the deploy service and that host's settings. */
export const deployTarget = z.object({
  host: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
});
export type DeployTarget = z.infer<typeof deployTarget>;

export const deployResult = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: z.string() }),
]);
export type DeployResult = z.infer<typeof deployResult>;

export const hostInfo = z.object({
  id: z.string(),
  label: z.string(),
  /** JSON Schema of the host's `config`. */
  config: z.record(z.string(), z.unknown()),
  /** JSON Schema of the host's credentials, or null when it needs none. */
  credentials: z.record(z.string(), z.unknown()).nullable(),
});
export type HostInfo = z.infer<typeof hostInfo>;

/** DeployJob.request of a publish. */
export const publishJobRequest = z.object({
  /** Where the deploy service downloads the build and reports the result. */
  builderOrigin: z.string().url(),
  /** Read access to the project, and permission to report this publish. */
  token: z.string().min(1),
  /** For the deploy service's logs only. */
  label: z.string().optional(),
});
export type PublishJobRequest = z.infer<typeof publishJobRequest>;

/** DeployJob.result of a publish. */
export const publishJobResult = z.object({ url: z.string().url() });

/** Sent by the deploy service when a publish finishes. */
export const deployReport = z.discriminatedUnion("status", [
  z.object({ status: z.literal("PUBLISHED"), url: z.string().url() }),
  z.object({ status: z.literal("FAILED"), error: z.string() }),
]);
export type DeployReport = z.infer<typeof deployReport>;

/** The deploy service's HTTP endpoints. */
export const deployPaths = {
  health: "/healthz",
  /** POST: look for queued jobs now. */
  wake: "/wake",
} as const;

/** The builder's endpoint for reports, relative to `builderOrigin`. */
export const deployReportPath = (buildId: string) =>
  `/rest/deployments/${encodeURIComponent(buildId)}`;
