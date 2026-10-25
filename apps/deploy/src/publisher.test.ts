import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { DeployReport, DeployTarget } from "@webstudio-is/deploy-protocol";
import { createAdapters } from "./adapters";
import {
  createPublisher,
  type PublishJob,
  type PublisherOptions,
} from "./publisher";
import { createBuildEnv } from "@webstudio-is/deploy-protocol/site-build";

let root: string;
let sitesDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "deployer-test-"));
  sitesDir = join(root, "sites");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fake builder that records reports. */
const createBuilder = (status = 200) => {
  const reports: { url: string; auth: string | null; body: DeployReport }[] =
    [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    reports.push({
      url: String(input),
      auth: new Headers(init.headers).get("Authorization"),
      body: JSON.parse(String(init.body)),
    });
    return new Response(null, { status });
  };
  return { fetch, reports };
};

const setup = (overrides: Partial<PublisherOptions> = {}) => {
  const builder = createBuilder();
  const calls: {
    buildId: string;
    builderOrigin: string;
    builderToken: string;
  }[] = [];
  const logs: string[] = [];
  const publisher = createPublisher({
    adapters: createAdapters({ sitesDir }),
    webstudioDir: "/unused",
    loadTarget: async () => savedTarget,
    loadCredentials: async () => savedCredentials,
    jobsDir: join(root, "jobs"),
    logsDir: join(root, "logs"),
    jobTimeoutMs: 60_000,
    keepFailedWorkdirs: false,
    fetch: builder.fetch,
    reportRetryDelayMs: 0,
    consoleLog: (line) => logs.push(line),
    buildSite: async ({
      workDir,
      buildId,
      builderOrigin,
      builderToken,
      log,
    }) => {
      calls.push({ buildId, builderOrigin, builderToken });
      log("building");
      const out = join(workDir, "dist", "client");
      await mkdir(out, { recursive: true });
      await writeFile(join(out, "index.html"), `<h1>${buildId}</h1>`);
      return out;
    },
    ...overrides,
  });
  return { publisher, calls, logs, reports: builder.reports };
};

/** What the builder's database holds for the project (stands in for store.ts). */
let savedTarget: DeployTarget | undefined;
let savedCredentials: Record<string, unknown> | undefined;

beforeEach(() => {
  savedTarget = {
    host: "directory",
    config: { site: "p1", url: "https://p1.example.com/" },
  };
  savedCredentials = undefined;
});

const job = (overrides: Partial<PublishJob> = {}): PublishJob => ({
  projectId: "project-1",
  buildId: "build-1",
  request: {
    builderOrigin: "https://builder.example.com",
    token: "publish-token",
    label: "Project 1",
  },
  ...overrides,
});

describe("publisher", () => {
  test("builds, deploys and reports the URL to the builder", async () => {
    const { publisher, calls, reports } = setup();

    expect(await publisher.publish(job())).toEqual({
      success: true,
      url: "https://p1.example.com/",
    });

    expect(calls).toEqual([
      {
        buildId: "build-1",
        builderOrigin: "https://builder.example.com",
        builderToken: "publish-token",
      },
    ]);
    expect(await readFile(join(sitesDir, "p1", "index.html"), "utf8")).toBe(
      "<h1>build-1</h1>"
    );
    expect(reports).toEqual([
      {
        url: "https://builder.example.com/rest/deployments/build-1",
        auth: "publish-token",
        body: { status: "PUBLISHED", url: "https://p1.example.com/" },
      },
    ]);
    // The job directory is cleaned up.
    await expect(stat(join(root, "jobs", "build-1"))).rejects.toThrow();
  });

  test("fails an unknown host before building", async () => {
    savedTarget = { host: "nope", config: {} };
    const { publisher, calls, reports } = setup();
    const outcome = await publisher.publish(job());
    expect(outcome).toEqual({
      success: false,
      error: expect.stringContaining('no "nope" host'),
    });
    expect(calls).toEqual([]);
    expect(reports.map((report) => report.body)).toEqual([
      { status: "FAILED", error: expect.stringContaining('no "nope" host') },
    ]);
  });

  test("fails a project without a target", async () => {
    savedTarget = undefined;
    const { publisher } = setup();
    expect(await publisher.validate("project-1")).toEqual({
      success: false,
      error: expect.stringContaining("no deploy target"),
    });
  });

  test("rejects invalid settings", async () => {
    savedTarget = { host: "directory", config: { site: "../etc", url: "x" } };
    const { publisher } = setup();
    expect((await publisher.validate("project-1")).success).toBe(false);
  });

  test("has no directory host without a sites directory", async () => {
    const { publisher } = setup({ adapters: createAdapters({}) });
    expect((await publisher.validate("project-1")).success).toBe(false);
  });

  test("checks the saved credentials fit the host, without quoting them", async () => {
    const { publisher } = setup();
    savedTarget = { host: "firebase", config: { site: "my-site" } };
    expect(await publisher.validate("project-1")).toEqual({
      success: false,
      error:
        "Firebase Hosting needs credentials: add them in Project settings → Deploy",
    });
    savedCredentials = {
      client_email: "not-an-email-secret",
      private_key: "",
    };
    const result = await publisher.validate("project-1");
    expect(result).toEqual({
      success: false,
      error:
        "The credentials aren't valid for Firebase Hosting (check client_email, private_key)",
    });
    expect(JSON.stringify(result)).not.toContain("not-an-email-secret");
    savedCredentials = {
      client_email: "deploy@project.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----",
    };
    expect(await publisher.validate("project-1")).toEqual({ success: true });
  });

  test("reports a failed site build", async () => {
    const { publisher, reports } = setup({
      buildSite: async () => {
        throw new Error("vite exploded");
      },
    });
    expect(await publisher.publish(job())).toEqual({
      success: false,
      error: "vite exploded",
    });
    expect(reports.map((report) => report.body)).toEqual([
      { status: "FAILED", error: "vite exploded" },
    ]);
  });

  test("retries a report the builder couldn't take", async () => {
    let attempts = 0;
    const { publisher } = setup({
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: attempts < 3 ? 503 : 200 });
      },
    });
    await publisher.publish(job());
    expect(attempts).toBe(3);
  });

  test("reads the target and credentials again after the site build", async () => {
    const events: string[] = [];
    savedTarget = { host: "fake", config: {} };
    const { publisher } = setup({
      adapters: new Map([
        [
          "fake",
          {
            id: "fake",
            label: "Fake",
            configSchema: z.object({}),
            credentialsSchema: z.object({ token: z.string() }),
            deploy: async ({
              credentials,
            }: {
              credentials: { token: string };
            }) => {
              events.push(`deploy with ${credentials.token}`);
              return { url: "https://fake.example.com/" };
            },
            remove: async () => {},
          },
        ],
      ]),
      loadCredentials: async () => {
        events.push("credentials");
        return { token: "t" };
      },
      buildSite: async ({ workDir }) => {
        events.push("build");
        const out = join(workDir, "dist", "client");
        await mkdir(out, { recursive: true });
        return out;
      },
    });
    await publisher.publish(job());
    // The check before building, then the build, then the deploy's own read.
    expect(events).toEqual([
      "credentials",
      "build",
      "credentials",
      "deploy with t",
    ]);
  });

  test("unpublish removes the site", async () => {
    const { publisher } = setup();
    await publisher.publish(job());
    expect(await publisher.unpublish("project-1")).toEqual({ success: true });
    await expect(stat(join(sitesDir, "p1"))).rejects.toThrow();
  });

  test("lists hosts with their settings and credentials schemas", async () => {
    const { publisher } = setup();
    const hosts = publisher.hosts();
    expect(hosts.map((host) => [host.id, host.credentials === null])).toEqual([
      ["directory", true],
      ["firebase", false],
    ]);
    expect(hosts[1].credentials).toMatchObject({
      type: "object",
      required: ["client_email", "private_key"],
      description: expect.stringContaining("service account"),
    });
    expect(hosts[0].config).toMatchObject({
      type: "object",
      required: ["site", "url"],
    });
  });
});

describe("site build environment", () => {
  test("passes only what the build tools need", () => {
    expect(
      createBuildEnv({
        PATH: "/bin",
        HOME: "/home/me",
        DEPLOY_CREDENTIALS_KEY: "secret",
        DATABASE_URL: "postgres://secret",
      })
    ).toEqual({
      PATH: "/bin",
      HOME: "/home/me",
      CI: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    });
  });
});
