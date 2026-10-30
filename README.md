<img width="1512" alt="builder-screenshot" src="https://github.com/webstudio-is/.github/blob/main/assets/builder-screenshot.png?raw=true">
<br /><br />

<section align="center">
  Webstudio is an Open Source Visual Development Platform for developers, designers, and cross-functional teams. You own the data, components, and infrastructure. You can use the hosted version or roll out your own.
</section>
<br /><br />

## This fork

This fork stores everything with Drizzle in plain Postgres, signs in with an email and password
(no Google or GitHub app needed), has no pricing model (every feature is available) and shows
each project's real published address.

It isn't run on its own: a separate self-hosting project, checked out next to this repository,
runs it (its package.json has `"webstudioSelfhost": true`; or set `WEBSTUDIO_SELFHOST_DIR`).
`npm run setup`, `npm run dev`, `npm run cli` and `npm run mcp` work here too; they run the same
commands there.

This repository keeps the code, its tests and the e2e runner, and CI publishes the builder and
deploy service images (`.github/workflows/selfhost-images.yml`, to
`ghcr.io/<owner>/webstudio-builder` and `ghcr.io/<owner>/webstudio-deploy`, tagged `latest`, the
branch and `sha-<commit>`). The deploy service that makes Publish work is `apps/deploy`. By default the
builder runs it itself; with `DEPLOYER_MODE=separate` (or the dashboard's Settings → Deployer) it
runs as its own process. App admins manage users, the deployer and email in the
dashboard's Settings.

Projects open at `<builder address>/p/<projectId>/`, so the builder needs one address and no
wildcard domain. The builder's server (`apps/builder/server.mjs` in production, the Vite dev
server locally) maps those paths onto the per-project origins the app tells projects apart by
(`apps/builder/project-paths.mjs`). Upstream gives each project its own subdomain instead, which
also keeps a project's canvas off the dashboard's origin; here they share one, so code in a
project can act as whoever has it open.

```sh
npm run test:selfhost      # tests for this fork's changes
npm run e2e:builder        # Playwright e2e against a disposable database (Docker)
npm run migrations         # apply migrations to DATABASE_URL
```

### Signing in locally

Everyone signs in with an email and password; there is no public sign-up. For local development,
`pnpm --filter @webstudio-is/builder users local-admin` (the self-hosting project's setup runs
it) creates a test admin on the builder's database:

| Email                  | Password                |
| ---------------------- | ----------------------- |
| `admin@localhost.test` | `webstudio-local-admin` |

It's created only when missing (a changed password stays changed), and the command refuses in
production. Admins add other accounts in the dashboard's **Settings → Users**, or with
`pnpm --filter @webstudio-is/builder users add <email> --name <name>`
(`apps/builder/scripts/users.ts` lists every command). To let someone choose their own
password, invite them (**Add user** → **Let them choose their own password**, or `users invite
<email>`): they get a set-password link, valid once for 7 days, by email when email is set up,
and the admin gets it to share.

## Learning Resources

- [Blog](https://webstudio.is/blog)
- [Documentation](https://docs.webstudio.is/)
- [Contributing](https://docs.webstudio.is/contributing/contributions)
- [Builder Issues Tracker](https://github.com/webstudio-is/webstudio/issues)
- [Roadmap](https://github.com/orgs/webstudio-is/projects/11)

## Social Media

- [Twitter](https://twitter.com/getwebstudio)
- [Youtube](https://www.youtube.com/@getwebstudio)
- [Discord](https://wstd.us/community)

## License

- **Webstudio core** (all functionality in this repository) is free/open-source under AGPL-3.0-or-later.
- **sdk-components-animation** package (optional) is proprietary. You must accept the Webstudio, Inc. EULA located in [sdk-components-animation/LICENSE](./packages/sdk-components-animation/LICENSE) before using it.
