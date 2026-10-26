# @webstudio-is/deploy

The deploy service for our self-hosted Webstudio (selfhost). It makes the builder's **Publish**
button work: it builds a published build as a static site and uploads it to a host.

It shares the builder's database and takes its work from there: no builder address, no API
key. The builder queues jobs (publish, unpublish, and checking a target when a project admin
saves it) in `DeployJob` and sends `NOTIFY deploy_jobs`; this service `LISTEN`s, also polls
(`DEPLOY_POLL_INTERVAL_MS`), and records each job's outcome. It registers itself and its hosts in
`DeployWorker`, which is how the builder knows it's running and which hosts to offer in
**Project settings → Deploy**. Optionally the builder also calls a wake URL whenever it queues a
job (`DEPLOYER_WAKE_URL`, or the dashboard's profile menu → **Deployer**), e.g. this service's
`POST /wake` on a platform that stops it when idle.

It's a separate process from the builder, since site builds run project code (HTML embeds). It
lives in this workspace only to build sites with this checkout's CLI and SSG packages, so it
always matches the builder.

## Jobs

`@webstudio-is/deploy-protocol` (`packages/deploy-protocol`) has the shared shapes; the tables
are in `@webstudio-is/db`. Another deploy service only has to follow the same
contract: claim jobs from `DeployJob`, register in `DeployWorker` and report publishes to the
builder.

- **Claiming.** The oldest queued job of this service's queue (`DEPLOY_QUEUE`) is taken with
  `FOR UPDATE SKIP LOCKED`, so several instances never run the same job. Publishes and unpublishes
  run one at a time; target checks run beside them, so saving a target doesn't wait for a build.
- **Notifications are hints.** One sent while the connection was down is lost; the next poll,
  and the catch-up after reconnecting, find the job anyway.
- **Crashes.** A running job's heartbeat is written every 30 s. A job without one for 5 minutes
  belonged to an instance that died: it's queued again, and failed (and reported) after three
  tries.
- **HTTP.** `GET /healthz` (status) and `POST /wake` (look for jobs now; `DEPLOY_WAKE_TOKEN`, if
  set, must come as `Authorization: Bearer <token>`), under any path prefix.

## What happens on Publish

1. The builder creates a production build (status `PENDING`) and queues a publish job with
   `{ builderOrigin, token, label }`. `token` is signed by the builder for this publish: it can
   read that one project and report this publish, and expires after two hours. A newer publish
   of the same project replaces one still waiting.
2. This service takes the job and checks the project's saved target (unknown host, invalid
   settings, missing credentials), failing early when it can't work.
3. It builds in `.data/jobs/<buildId>` (deleted afterwards):
   - `pnpm deploy` the checkout's `ssg-cloudflare-pages` fixture (its dependencies are the
     checkout's own SSG packages, hardlinked from the pnpm store);
   - `webstudio sync --buildId … --origin <builderOrigin> --authToken <token>`;
   - `webstudio build --template ssg --template internal`, then `npm run build`;
   - only now are the project's target and credentials read again, and the host adapter uploads
     `dist/client`.
4. It reports to `POST <builderOrigin>/rest/deployments/<buildId>` with the token:
   `{ status: "PUBLISHED", url }` or `{ status: "FAILED", error }`, retrying a few times, and
   records the outcome on the job. The builder marks the build and saves `url` as the project's
   published link. Each job's log is in `.data/logs/<buildId>.log`.

Build commands get only what pnpm, npm and the CLI need from the environment (`PATH`, `HOME`, …),
never this service's database login or keys.

## Hosts

| Host        | Settings                                                                                                                                                                                                                                                                                              | Credentials                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `directory` | `site` (a folder name under `DEPLOY_SITES_DIR`), `url` (where a web server serves it)                                                                                                                                                                                                                 | none                                                                |
| `firebase`  | `site` (Hosting site name; the Firebase project ID goes in front unless it's already there, `blog` → `<project>-blog`; created on the first publish when missing); optional `project` (where to create it, default the service account's), `url` (when not `https://<site>.web.app`), `hostingConfig` | A service-account JSON key with the **Firebase Hosting Admin** role |

Settings come from the builder, so no host takes a path: `directory` writes only under
`DEPLOY_SITES_DIR` (and is off without it). Credentials are entered per project in the builder,
which stores them encrypted; this service reads them from the builder's database
(`ProjectDeployTarget`) and decrypts them with the shared `DEPLOY_CREDENTIALS_KEY`, keeping them
in memory for the job only.

To add a host, write an adapter (`src/adapters/types.ts`: `label`, `configSchema` with
`.describe()`d fields, optional `credentialsSchema`, `deploy`, `remove`) and register it in
`src/adapters/index.ts`. The builder's settings form is built from the schema.

## Environment

| Variable                  | Default             | Purpose                                                                        |
| ------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL`            | required            | The builder's database, with a login limited to what this service does (below) |
| `DEPLOY_CREDENTIALS_KEY`  | unset               | The builder's key for projects' credentials (32+ characters)                   |
| `DEPLOY_POLL_INTERVAL_MS` | `15000`             | How often to look for jobs besides notifications                               |
| `DEPLOY_QUEUE`            | `default`           | Takes only this queue's jobs (the builder's `DEPLOYER_QUEUE`)                  |
| `DEPLOY_WORKER_ID`        | the host name       | Names this instance in `DeployWorker`                                          |
| `DEPLOY_WAKE_TOKEN`       | unset               | Required on `POST /wake` when set                                              |
| `HOST`, `PORT`            | `127.0.0.1`, `3001` | Listen address for `/healthz` and `/wake`                                      |
| `DEPLOY_SITES_DIR`        | unset               | Root for the `directory` host; unset turns that host off                       |
| `WEBSTUDIO_DIR`           | this checkout       | The Webstudio checkout whose CLI and packages build sites                      |
| `DEPLOYER_DATA_DIR`       | `.data`             | Job directories and logs                                                       |
| `JOB_TIMEOUT_MS`          | 15 minutes          | Per-job limit                                                                  |
| `KEEP_FAILED_WORKDIRS`    | `false`             | Keep a failed job's directory for debugging                                    |

The service must reach the builder at the `builderOrigin` of each job. When it can't (a private
network, containers), set the builder's `DEPLOYER_BUILDER_URL` (or **Builder address** in its
Deployer dialog).

### The database login

Give it a login of its own. `packages/db/scripts/deployer-role.mjs` creates or updates it
(run after the migrations, as the database owner); by hand:

```sql
CREATE ROLE webstudio_deployer LOGIN PASSWORD '…';
GRANT USAGE ON SCHEMA public TO webstudio_deployer;
GRANT SELECT ("projectId", "host", "config", "credentials") ON "ProjectDeployTarget" TO webstudio_deployer;
GRANT SELECT ON "DeployJob" TO webstudio_deployer;
GRANT UPDATE ("status", "error", "result", "attempts", "workerId", "startedAt", "heartbeatAt", "finishedAt")
  ON "DeployJob" TO webstudio_deployer;
GRANT SELECT, INSERT, UPDATE, DELETE ON "DeployWorker" TO webstudio_deployer;
```

### Neon

- Use the **direct** connection string (the host without `-pooler`). Neon's pooler runs PgBouncer
  in transaction mode, which accepts `LISTEN` but never delivers notifications; the service warns
  and falls back to polling when it sees a `-pooler` host. The builder can keep the pooled one.
- **Scale to zero ends listeners**, and polling (and the service's heartbeat) keeps the compute
  awake anyway. For a service that runs all the time, turn scale to zero off (paid plans). The
  listener reconnects after Neon restarts the compute and looks for jobs it missed.
- A service that should only run when needed: stop it when idle and set the builder's wake URL
  to something that starts it (its own `/wake` on Cloud Run, a platform hook, …). A queued job
  waits in the database until it's up.

## Run

`pnpm start` runs it directly with the environment above. As an image: this checkout's
`Dockerfile`, target `deploy` (data in `/data`), which CI publishes as
`ghcr.io/<owner>/webstudio-deploy`.

Tests: `pnpm --filter @webstudio-is/deploy test` (typecheck: `… typecheck`).

## Limits

- A job interrupted by a crash runs again from the start once its heartbeat is stale (5 minutes).
  A publish whose token has expired (two hours) fails, and the builder times it out.
- The publish token is passed to the CLI as an argument (it has no environment variable for it),
  so it's visible to other processes on the same machine. Run the service in its own container.
- Untrusted project code (HTML embeds) runs during `vite build` as this service's user. Its
  environment holds none of this service's settings, and the credentials are read only after the
  build, but the build can still read this service's data directory. Run the service in its own
  container (the Dockerfile's `deploy` target) with the limited database login above.
