<img width="1512" alt="builder-screenshot" src="https://github.com/webstudio-is/.github/blob/main/assets/builder-screenshot.png?raw=true">
<br /><br />

<section align="center">
  Webstudio is an Open Source Visual Development Platform for developers, designers, and cross-functional teams. You own the data, components, and infrastructure. You can use the hosted version or roll out your own.
</section>
<br /><br />

## This fork

This fork stores everything with Drizzle in plain Postgres, signs in with a username and password
(no Google or GitHub app needed), has no pricing model (every feature is available) and shows
each project's real published address.

It isn't run on its own: **knowbra-webstudio** (checked out next to this repository) runs it.
`npm run setup`, `npm run cli` and `npm run dev` work here too; they run the same commands there. That repository holds the stack
(Postgres and RustFS in Docker, the builder, Drizzle Studio and the deploy service) and the
commands for it, all plain Node so they work on macOS, Linux and Windows:

```sh
npm run setup   # in knowbra-webstudio: install and build this checkout, start the containers
npm run cli     # add users, Drizzle Studio, stop/reset/destroy the containers
npm run dev     # the builder, Drizzle Studio and the deploy service
```

This repository keeps the code, its tests and the e2e runner:

```sh
npm run test:selfhost      # tests for this fork's changes
npm run e2e:builder        # Playwright e2e against a disposable database (Docker)
npm run migrations         # apply migrations to DATABASE_URL
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
