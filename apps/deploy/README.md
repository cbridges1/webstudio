# @webstudio-is/deploy

The deploy service for our self-hosted Webstudio (selfhost). It's a separate process from the
builder, since site builds run project code, but part of this workspace: it uses this checkout's
`@webstudio-is/db`, CLI and SSG packages, so it always matches the builder.
knowbra-webstudio runs it (`npm run dev` there starts it with the builder).

Makes the builder's **Publish** button work. The builder sends `deployment.*` and `domain.*` calls to
`TRPC_SERVER_URL`; this service answers them, builds the published build as a static site, and
deploys it to the host configured for that project. Each project can use a different host and
account.

## What happens on Publish

1. The builder creates a production build (status `PENDING`) and calls `deployment.publish`.
2. The service checks the request right away: the static-download button is refused, and so is a
   project with no deploy target or an invalid one. These failures show in the Publish dialog and
   mark the build `FAILED`. Otherwise the job is queued and the call returns `{ success: true }`.
3. Jobs run one at a time, each in `.data/jobs/<buildId>` (deleted afterwards):
   - `pnpm deploy` the Webstudio checkout's `ssg-cloudflare-pages` fixture (its dependencies are
     the checkout's own SSG packages, hardlinked from the pnpm store);
   - `webstudio sync --buildId … --origin <builder> --authToken <token>` downloads the build and
     its assets from the builder;
   - `webstudio build --template ssg --template internal`, then `npm run build`;
   - the project's host adapter uploads `dist/client`.
4. On success the service saves the site's URL in `Project.publishedUrl` (the builder and
   dashboard show it as the published link) and marks the build `PUBLISHED`. Failures mark it `FAILED`. Each job's log is in
   `.data/logs/<buildId>.log`.

Unpublish maps `<project domain>.<PUBLISHER_HOST>` back to the project, calls the adapter's
`remove`, and clears `Project.publishedUrl`. Custom-domain calls (`domain.*`) return
"Custom domains aren't managed here".

Because the CLI and packages come from the same checkout as the builder, the bundle contract
always matches. `src/contract.test.ts` also compares this router with the checkout's
`sharedRouter`, so an upstream contract change fails the tests.

## Deploy targets

`deploy-targets.json` (path in `DEPLOY_CONFIG`), keyed by Webstudio project ID. It's read on every
publish, so edits apply without a restart. Example: [deploy-targets.example.json](deploy-targets.example.json).

| Host        | `config`                                                                                                                           | `credentials`                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `firebase`  | `site` (Hosting site ID); optional `url` (when not `https://<site>.web.app`), `hostingConfig` (headers, redirects, `cleanUrls`, …) | A service-account JSON key with the **Firebase Hosting Admin** role |
| `directory` | `path` (directory a web server serves), `url`                                                                                      | none                                                                |

`credentials` names a file, `<DEPLOY_CREDENTIALS_DIR>/<name>.json`, one per account. Mount these
from the host's secret manager; never put secrets in `deploy-targets.json`.

To add a host, write an adapter (`src/adapters/types.ts`: `configSchema`, optional
`credentialsSchema`, `deploy`, `remove`) and register it in `src/adapters/index.ts`.

## Environment

| Variable                 | Default               | Purpose                                                                                                                         |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `TRPC_SERVER_API_TOKEN`  | required              | Shared with the builder (32+ characters)                                                                                        |
| `DATABASE_URL`           | required              | The builder's Postgres. Queries go through `@webstudio-is/db` (`packages/db`)                                                   |
| `BUILDER_INTERNAL_URL`   | unset                 | The builder's private address for `webstudio sync` (e.g. `http://builder:3000`); unset uses the public origin the builder sends |
| `WEBSTUDIO_DIR`          | this checkout         | The Webstudio checkout, installed and built (knowbra-webstudio's `npm run setup`)                                               |
| `PUBLISHER_HOST`         | `wstd.work`           | Must match the builder's                                                                                                        |
| `HOST`, `PORT`           | `127.0.0.1`, `3001`   | Listen address. Keep it private: only the builder calls it                                                                      |
| `DEPLOY_CONFIG`          | `deploy-targets.json` | Deploy targets file                                                                                                             |
| `DEPLOY_CREDENTIALS_DIR` | `credentials`         | Credential files                                                                                                                |
| `DEPLOYER_DATA_DIR`      | `.data`               | Job directories and logs                                                                                                        |
| `JOB_TIMEOUT_MS`         | 15 minutes            | Per-job limit                                                                                                                   |
| `KEEP_FAILED_WORKDIRS`   | `false`               | Keep a failed job's directory for debugging                                                                                     |

`GET /healthz` (no token) reports the running and queued jobs.

## Run

Locally, knowbra-webstudio runs it with everything set from its `.env`: `npm run dev` there starts
it with the builder, and `npm run selfhost -- deployer --bg` runs it on its own. Its deploy targets
and credentials are knowbra-webstudio's `deploy-targets.json` and `credentials/`. `pnpm start`
here runs it directly with the environment above.

Tests: `pnpm --filter @webstudio-is/deploy test` (typecheck: `… typecheck`).

## Limits

- Jobs are kept in memory. If the service restarts mid-build, that build stays `PENDING` until the
  builder's own timeout; publish again.
- The service token is passed to the CLI as an argument (it has no environment variable for it),
  so it's visible to other processes on the same machine. Run the service in its own container.
- Untrusted project code (HTML embeds) runs during `vite build`. Run the service in a container
  with only the credentials it needs.
