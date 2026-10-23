# @webstudio-is/deploy

The deploy service for our self-hosted Webstudio (selfhost). It makes the builder's **Publish**
button work: it builds a published build as a static site and uploads it to a host.

It knows nothing about any builder. It has no database, no builder address and no builder
secret. Workspace admins add it in the builder (dashboard: workspace menu → **Deployers**, with
its URL and API key), and each project picks a deployer and a target in **Project settings →
Deploy**. One deploy service can serve several builders and workspaces; one workspace can use
several deploy services.

It's a separate process from the builder, since site builds run project code (HTML embeds). It
lives in this workspace only to build sites with this checkout's CLI and SSG packages, so it
always matches the builder. knowbra-webstudio runs it (`npm run dev` there starts it with the
builder).

## API

Defined in `@webstudio-is/deploy-protocol` (`packages/deploy-protocol`), which the builder uses
to call it. Every request carries `Authorization: Bearer <DEPLOY_API_KEY>`; the service can sit
behind a path prefix.

| Request              | Does                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `GET /v1/hosts`      | The hosts it offers: each one's settings (JSON Schema) and the credentials it holds for it |
| `POST /v1/validate`  | Checks a target (`{ host, config, credentials? }`); the builder calls it before saving one |
| `POST /v1/publish`   | Queues a publish (below)                                                                   |
| `POST /v1/unpublish` | Removes a target's site                                                                    |
| `GET /healthz`       | Running and queued jobs (no key)                                                           |

## What happens on Publish

1. The builder creates a production build (status `PENDING`) and sends `POST /v1/publish` with
   the build ID, the project's target, and `builder: { origin, token }`. `token` is a token the
   builder signs for this publish: it can read that one project and report this publish, and
   expires after two hours.
2. The service checks the target right away (unknown host, invalid settings, missing
   credentials). Problems show in the Publish dialog and the builder marks the build `FAILED`.
   Otherwise the job is queued and the call returns `{ success: true }`.
3. Jobs run one at a time, each in `.data/jobs/<buildId>` (deleted afterwards):
   - `pnpm deploy` the checkout's `ssg-cloudflare-pages` fixture (its dependencies are the
     checkout's own SSG packages, hardlinked from the pnpm store);
   - `webstudio sync --buildId … --origin <builder.origin> --authToken <builder.token>`;
   - `webstudio build --template ssg --template internal`, then `npm run build`;
   - the host adapter uploads `dist/client`.
4. The service reports the result to `POST <builder.origin>/rest/deployments/<buildId>` with the
   token: `{ status: "PUBLISHED", url }` or `{ status: "FAILED", error }`, retrying a few times.
   The builder marks the build and saves `url` as the project's published link. Each job's log
   is in `.data/logs/<buildId>.log`.

Build commands get only what pnpm, npm and the CLI need from the environment (`PATH`, `HOME`, …),
never this service's key.

## Hosts

| Host        | Settings                                                                                      | Credentials                                                         |
| ----------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `directory` | `site` (a folder name under `DEPLOY_SITES_DIR`), `url` (where a web server serves it)         | none                                                                |
| `firebase`  | `site` (Hosting site ID); optional `url` (when not `https://<site>.web.app`), `hostingConfig` | A service-account JSON key with the **Firebase Hosting Admin** role |

Settings come from the builder, so no host takes a path: `directory` writes only under
`DEPLOY_SITES_DIR` (and is off without it). Credentials are files,
`<DEPLOY_CREDENTIALS_DIR>/<name>.json`, one per account, mounted from the host's secret manager;
a target only names one, and anyone with this service's key can use any of them.

To add a host, write an adapter (`src/adapters/types.ts`: `label`, `configSchema` with
`.describe()`d fields, optional `credentialsSchema`, `deploy`, `remove`) and register it in
`src/adapters/index.ts`. The builder's settings form is built from the schema.

## Environment

| Variable                 | Default             | Purpose                                                   |
| ------------------------ | ------------------- | --------------------------------------------------------- |
| `DEPLOY_API_KEY`         | required            | The key builders call it with (32+ characters)            |
| `HOST`, `PORT`           | `127.0.0.1`, `3001` | Listen address. Only builders need to reach it            |
| `DEPLOY_CREDENTIALS_DIR` | `credentials`       | Credential files                                          |
| `DEPLOY_SITES_DIR`       | unset               | Root for the `directory` host; unset turns that host off  |
| `WEBSTUDIO_DIR`          | this checkout       | The Webstudio checkout whose CLI and packages build sites |
| `DEPLOYER_DATA_DIR`      | `.data`             | Job directories and logs                                  |
| `JOB_TIMEOUT_MS`         | 15 minutes          | Per-job limit                                             |
| `KEEP_FAILED_WORKDIRS`   | `false`             | Keep a failed job's directory for debugging               |

The service must reach each builder at the `origin` it sends. When it can't (a private network,
containers), set the deployer's **Builder address** in the builder's Deployers dialog.

## Run

knowbra-webstudio runs it with its own settings: `npm run dev` there starts it with the builder,
and `npm run selfhost -- deployer --bg` runs it on its own. `pnpm start` here runs it directly with
the environment above.

Tests: `pnpm --filter @webstudio-is/deploy test` (typecheck: `… typecheck`).

## Limits

- Jobs are kept in memory. If the service restarts mid-build, that build stays `PENDING` until
  the builder's own timeout; publish again.
- The publish token is passed to the CLI as an argument (it has no environment variable for it),
  so it's visible to other processes on the same machine. Run the service in its own container.
- Untrusted project code (HTML embeds) runs during `vite build`. Run the service in a container
  with only the credentials it needs.
