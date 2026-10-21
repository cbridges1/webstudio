<img width="1512" alt="builder-screenshot" src="https://github.com/webstudio-is/.github/blob/main/assets/builder-screenshot.png?raw=true">
<br /><br />

<section align="center">
  Webstudio is an Open Source Visual Development Platform for developers, designers, and cross-functional teams. You own the data, components, and infrastructure. You can use the hosted version or roll out your own.
</section>
<br /><br />

## Running this fork locally

This fork adds email/password sign-in (no Google or GitHub app needed) and shows each project's
real published address. Everything needed to run it locally is in this repository.

**You need:** Docker Desktop, Node 22 and pnpm 9 (`corepack enable`).

```sh
pnpm run bootstrap   # install dependencies and build the workspace packages the dev server loads
pnpm run dev         # Postgres + PostgREST in Docker, migrations, then the builder
```

In a second terminal, create an account. There is no public sign-up.

```sh
pnpm run users add you@example.com   # prompts for a password (12+ characters)
```

Then open the `Network` address the dev server prints (usually https://wstd.dev:5173) and sign in.
`wstd.dev` resolves to 127.0.0.1 and the certificate in `https/` covers it. The builder needs
HTTPS even locally.

### Accounts

```sh
pnpm run users list
pnpm run users set-password you@example.com      # also clears a lockout
pnpm run users remove-password you@example.com   # disables sign-in
```

Add `--password-stdin` to read the password from stdin instead of prompting. An account locks for
15 minutes after 10 wrong passwords.

### Settings

Local settings are in `apps/builder/.env`. Put overrides in `apps/builder/.env.development`
(gitignored).

| Variable                                   | Purpose                                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_PASSWORD_LOGIN=true`                 | Email/password sign-in                                                                                                                       |
| `DEV_LOGIN=true`                           | Upstream's local-only "Login with Secret" (uses `AUTH_SECRET`). The builder refuses to start with it in production                           |
| `TRPC_SERVER_URL`, `TRPC_SERVER_API_TOKEN` | Optional deploy service for **Publish**. Without one, Publish shows upstream's "use the Webstudio CLI" message, which is fine for local work |
| `STAGING_USERNAME=`, `STAGING_PASSWORD=`   | Set both empty when using a deploy service, so published links don't include basic-auth credentials                                          |

### Existing databases

`pnpm run dev` only sets up an empty database. After pulling new migrations, apply them with:

```sh
pnpm run migrations migrate
```

Then restart `pnpm run dev` so PostgREST picks up the new tables.

### Tests for this fork's changes

```sh
pnpm run test:selfhost
```

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
