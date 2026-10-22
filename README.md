<img width="1512" alt="builder-screenshot" src="https://github.com/webstudio-is/.github/blob/main/assets/builder-screenshot.png?raw=true">
<br /><br />

<section align="center">
  Webstudio is an Open Source Visual Development Platform for developers, designers, and cross-functional teams. You own the data, components, and infrastructure. You can use the hosted version or roll out your own.
</section>
<br /><br />

## Running this fork locally

This fork stores everything with Drizzle in plain Postgres, signs in with a username and password
(no Google or GitHub app needed) and shows each project's real published address. Everything
needed to run it locally is in this repository.

**You need:** Docker Desktop and Node 22 with npm. You don't need to install pnpm: the repository
is a pnpm workspace, and `npm run bootstrap` fetches the pinned version for you. Use the
`npm run` commands below rather than `npm install`.

```sh
npm run bootstrap   # install dependencies and build the workspace packages the dev server loads
npm run dev         # Postgres in Docker, migrations, then the builder and Drizzle Studio
```

In a second terminal, create an account. There is no public sign-up.

```sh
npm run cli   # pick "Users — add a user"; passwords need 12+ characters
```

Then open http://localhost:5173 and sign in with that username and password. `npm run dev` also
starts Drizzle Studio on the same database at https://local.drizzle.studio?port=4984
(`DRIZZLE_STUDIO_PORT` changes the port; `LOCAL_DEV_STUDIO=false` skips it). Ctrl+C stops both. Everything is plain
HTTP: TLS and domain mapping belong to whatever hosts the builder.

### Dev CLI

`npm run cli` opens an interactive menu:

| Action                  | What it does                                                               |
| ----------------------- | -------------------------------------------------------------------------- |
| Setup                   | Starts the local Postgres in Docker and applies migrations                 |
| Reset                   | Deletes the local database, then runs Setup                                |
| Destroy                 | Stops Postgres and deletes the local database, with every user and project |
| Drizzle Studio          | Browses the database in Drizzle Studio until Ctrl+C                        |
| Users — add a user      | Creates an account with its default workspace                              |
| List users              | Shows each account, its email and whether it can sign in                   |
| Set a password          | Replaces a user's password                                                 |
| Disable / Enable a user | Blocks or allows sign-in; the user's projects stay                         |

An email is optional, but only accounts with one can accept workspace invites. Sign-in allows 5
attempts per minute from one address. If the local database isn't running, the account actions
offer to start it (Setup) first. The account actions and Drizzle Studio use `DATABASE_URL` (the environment
first, then `apps/builder/.env.development`, then `apps/builder/.env`).

For scripts, the same account actions are available without prompts:

```sh
npm run users -- add you --email you@example.com --password-stdin < password.txt
npm run users -- list
npm run users -- set-password you
npm run users -- disable you   # enable undoes it
```

The `--` passes the options through npm.

### Settings

Local settings are in `apps/builder/.env`. Put overrides in `apps/builder/.env.development`
(gitignored).

| Variable                                   | Purpose                                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_USERNAME_LOGIN=true`                 | Username/password sign-in                                                                                                                    |
| `BETTER_AUTH_SECRET`                       | Signs sign-in requests. The checked-in value is for local use only; production needs its own random 32+ character secret                     |
| `AUTH_SECRET`                              | Signs the builder's session cookies                                                                                                          |
| `TRPC_SERVER_URL`, `TRPC_SERVER_API_TOKEN` | Optional deploy service for **Publish**. Without one, Publish shows upstream's "use the Webstudio CLI" message, which is fine for local work |
| `STAGING_USERNAME=`, `STAGING_PASSWORD=`   | Set both empty when using a deploy service, so published links don't include basic-auth credentials                                          |

### Existing databases

`npm run dev` applies new migrations when it starts. To apply them to another database, set
`DATABASE_URL` and run:

```sh
npm run migrations
```

### Tests for this fork's changes

```sh
npm run test:selfhost
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
