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
import type {
  DeployReport,
  PublishRequest,
} from "@webstudio-is/deploy-protocol";
import { createAdapters } from "./adapters";
import { createPublisher, type PublisherOptions } from "./publisher";
import { createBuildEnv } from "./site-build";

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
    credentialsDir: join(root, "credentials"),
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

const job = (overrides: Partial<PublishRequest> = {}): PublishRequest => ({
  buildId: "build-1",
  builder: { origin: "https://builder.example.com", token: "publish-token" },
  target: {
    host: "directory",
    config: { site: "p1", url: "https://p1.example.com/" },
  },
  label: "Project 1",
  ...overrides,
});

describe("publisher", () => {
  test("builds, deploys and reports the URL to the builder", async () => {
    const { publisher, calls, reports } = setup();

    expect(await publisher.publish(job())).toEqual({ success: true });
    await publisher.idle();

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

  test("rejects an unknown host right away", async () => {
    const { publisher, calls, reports } = setup();
    const result = await publisher.publish(
      job({ target: { host: "nope", config: {} } })
    );
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('no "nope" host'),
    });
    await publisher.idle();
    expect(calls).toEqual([]);
    expect(reports).toEqual([]);
  });

  test("rejects invalid settings right away", async () => {
    const { publisher } = setup();
    const result = await publisher.publish(
      job({
        target: { host: "directory", config: { site: "../etc", url: "x" } },
      })
    );
    expect(result.success).toBe(false);
  });

  test("has no directory host without a sites directory", async () => {
    const { publisher } = setup({ adapters: createAdapters({}) });
    expect((await publisher.publish(job())).success).toBe(false);
  });

  test("checks that credentials exist and fit the host", async () => {
    const { publisher } = setup();
    const target = {
      host: "firebase",
      config: { site: "my-site" },
      credentials: "main",
    };
    expect(await publisher.validate(target)).toEqual({
      success: false,
      error: 'Credentials "main" not found',
    });
    await mkdir(join(root, "credentials"));
    await writeFile(join(root, "credentials", "main.json"), '{"secret":"x"}');
    expect(await publisher.validate(target)).toEqual({
      success: false,
      error: 'Credentials "main" are not valid for Firebase Hosting',
    });
  });

  test("reports a failed site build", async () => {
    const { publisher, reports } = setup({
      buildSite: async () => {
        throw new Error("vite exploded");
      },
    });
    expect(await publisher.publish(job())).toEqual({ success: true });
    await publisher.idle();
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
    await publisher.idle();
    expect(attempts).toBe(3);
  });

  test("runs jobs one at a time and keeps going after a failure", async () => {
    const order: string[] = [];
    const { publisher, reports } = setup({
      buildSite: async ({ workDir, buildId }) => {
        order.push(`start ${buildId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end ${buildId}`);
        if (buildId === "build-1") {
          throw new Error("first fails");
        }
        const out = join(workDir, "dist", "client");
        await mkdir(out, { recursive: true });
        return out;
      },
    });
    await publisher.publish(job({ buildId: "build-1" }));
    await publisher.publish(job({ buildId: "build-2" }));
    await publisher.idle();
    expect(order).toEqual([
      "start build-1",
      "end build-1",
      "start build-2",
      "end build-2",
    ]);
    expect(reports.map((report) => report.body.status)).toEqual([
      "FAILED",
      "PUBLISHED",
    ]);
  });

  test("unpublish removes the site", async () => {
    const { publisher } = setup();
    await publisher.publish(job());
    await publisher.idle();
    expect(await publisher.unpublish(job().target)).toEqual({ success: true });
    await expect(stat(join(sitesDir, "p1"))).rejects.toThrow();
  });

  test("lists hosts with their settings and usable credentials", async () => {
    const { publisher } = setup();
    const hosts = await publisher.hosts();
    expect(hosts.map((host) => [host.id, host.credentials])).toEqual([
      ["directory", null],
      ["firebase", []],
    ]);
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
        DEPLOY_API_KEY: "secret",
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
