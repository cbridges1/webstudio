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
import { directoryAdapter } from "./adapters/directory";
import type { BuildRow, Database, PublishStatus } from "./database";
import { createPublisher, type PublisherOptions } from "./publisher";

const createFakeDb = (
  builds: BuildRow[],
  projects: Record<string, string> = {}
) => {
  const statuses = new Map<string, PublishStatus>();
  const sites = new Map<string, string>();
  const db: Database = {
    getBuild: async (id) => builds.find((build) => build.id === id),
    setPublishStatus: async (id, status) => {
      statuses.set(id, status);
    },
    findProjectIdByDomain: async (domain) => projects[domain],
    setPublishedUrl: async (projectId, url) => {
      sites.set(projectId, url);
    },
    clearPublishedUrl: async (projectId) => {
      sites.delete(projectId);
    },
  };
  return { db, statuses, sites };
};

const build = (overrides: Partial<BuildRow> = {}): BuildRow => ({
  id: "build-1",
  projectId: "project-1",
  deployment: JSON.stringify({
    destination: "saas",
    target: "production",
    domains: ["p1"],
  }),
  publishStatus: "PENDING",
  ...overrides,
});

let root: string;
let siteDir: string;
let configPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "deployer-test-"));
  siteDir = join(root, "sites", "p1");
  configPath = join(root, "deploy-targets.json");
  await writeFile(
    configPath,
    JSON.stringify({
      projects: {
        "project-1": {
          host: "directory",
          config: { path: siteDir, url: "https://p1.example.com/" },
        },
        "project-2": { host: "nope", config: {} },
      },
    })
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const setup = (db: Database, overrides: Partial<PublisherOptions> = {}) => {
  const calls: {
    buildId: string;
    builderOrigin: string;
    serviceToken: string;
  }[] = [];
  const logs: string[] = [];
  const publisher = createPublisher({
    db,
    adapters: new Map([[directoryAdapter.id, directoryAdapter]]),
    webstudioDir: "/unused",
    serviceToken: "service-token",
    publisherHost: "wstd.work",
    configPath,
    credentialsDir: join(root, "credentials"),
    jobsDir: join(root, "jobs"),
    logsDir: join(root, "logs"),
    jobTimeoutMs: 60_000,
    keepFailedWorkdirs: false,
    consoleLog: (line) => logs.push(line),
    buildSite: async ({
      workDir,
      buildId,
      builderOrigin,
      serviceToken,
      log,
    }) => {
      calls.push({ buildId, builderOrigin, serviceToken });
      log("building");
      const out = join(workDir, "dist", "client");
      await mkdir(out, { recursive: true });
      await writeFile(join(out, "index.html"), `<h1>${buildId}</h1>`);
      return out;
    },
    ...overrides,
  });
  return { publisher, calls, logs };
};

const publishInput = {
  buildId: "build-1",
  builderOrigin: "https://builder.example.com",
  destination: "saas" as const,
};

describe("publisher", () => {
  test("builds, deploys, records the URL and marks the build published", async () => {
    const { db, statuses, sites } = createFakeDb([build()]);
    const { publisher, calls } = setup(db);

    await expect(publisher.publish(publishInput)).resolves.toEqual({
      success: true,
    });
    await publisher.idle();

    expect(calls).toEqual([
      {
        buildId: "build-1",
        builderOrigin: "https://builder.example.com",
        serviceToken: "service-token",
      },
    ]);
    expect(await readFile(join(siteDir, "index.html"), "utf8")).toBe(
      "<h1>build-1</h1>"
    );
    expect(sites.get("project-1")).toBe("https://p1.example.com/");
    expect(statuses.get("build-1")).toBe("PUBLISHED");
    // Work directory is cleaned up; a log file is kept.
    await expect(stat(join(root, "jobs", "build-1"))).rejects.toThrow();
    expect(await readFile(join(root, "logs", "build-1.log"), "utf8")).toContain(
      "Published"
    );
  });

  test("syncs from the builder's private address when one is set", async () => {
    const { db } = createFakeDb([build()]);
    const { publisher, calls } = setup(db, {
      builderUrl: "http://builder:3000",
    });

    await publisher.publish(publishInput);
    await publisher.idle();

    expect(calls).toEqual([
      expect.objectContaining({ builderOrigin: "http://builder:3000" }),
    ]);
  });

  test("rejects the static-download flow", async () => {
    const { db, statuses } = createFakeDb([build()]);
    const { publisher } = setup(db);

    const result = await publisher.publish({
      ...publishInput,
      destination: "static",
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Static download"),
    });
    expect(statuses.get("build-1")).toBe("FAILED");
  });

  test("deploys staging-target builds like any other", async () => {
    // Upstream calls a publish to only the project's own domain "staging".
    const { db, statuses } = createFakeDb([
      build({
        deployment: JSON.stringify({
          destination: "saas",
          target: "staging",
          domains: ["p1"],
        }),
      }),
    ]);
    const { publisher } = setup(db);

    expect(await publisher.publish(publishInput)).toEqual({ success: true });
    await publisher.idle();
    expect(statuses.get("build-1")).toBe("PUBLISHED");
  });

  test("rejects a project without a deploy target", async () => {
    const { db, statuses } = createFakeDb([build({ projectId: "project-9" })]);
    const { publisher, calls } = setup(db);

    const result = await publisher.publish(publishInput);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("no deploy target"),
    });
    expect(statuses.get("build-1")).toBe("FAILED");
    expect(calls).toEqual([]);
  });

  test("rejects an unknown host", async () => {
    const { db } = createFakeDb([build({ projectId: "project-2" })]);
    const { publisher } = setup(db);

    expect(await publisher.publish(publishInput)).toMatchObject({
      success: false,
      error: expect.stringContaining('Unknown host "nope"'),
    });
  });

  test("marks the build failed when the site build fails", async () => {
    const { db, statuses, sites } = createFakeDb([build()]);
    const { publisher } = setup(db, {
      buildSite: async () => {
        throw new Error("vite exploded");
      },
    });

    expect(await publisher.publish(publishInput)).toEqual({ success: true });
    await publisher.idle();

    expect(statuses.get("build-1")).toBe("FAILED");
    expect(sites.size).toBe(0);
    expect(await readFile(join(root, "logs", "build-1.log"), "utf8")).toContain(
      "FAILED: vite exploded"
    );
  });

  test("runs jobs one at a time and keeps going after a failure", async () => {
    const { db, statuses } = createFakeDb([build(), build({ id: "build-2" })]);
    let active = 0;
    let maxActive = 0;
    const { publisher } = setup(db, {
      buildSite: async ({ workDir, buildId }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        if (buildId === "build-1") {
          throw new Error("first fails");
        }
        const out = join(workDir, "out");
        await mkdir(out, { recursive: true });
        await writeFile(join(out, "index.html"), "ok");
        return out;
      },
    });

    await publisher.publish(publishInput);
    await publisher.publish({ ...publishInput, buildId: "build-2" });
    await publisher.idle();

    expect(maxActive).toBe(1);
    expect(statuses.get("build-1")).toBe("FAILED");
    expect(statuses.get("build-2")).toBe("PUBLISHED");
  });

  test("unpublish removes the site and its recorded URL", async () => {
    const { db, sites } = createFakeDb([build()], { p1: "project-1" });
    const { publisher } = setup(db);
    await publisher.publish(publishInput);
    await publisher.idle();
    expect(sites.has("project-1")).toBe(true);

    expect(await publisher.unpublish({ domain: "p1.wstd.work" })).toEqual({
      success: true,
    });
    await expect(stat(siteDir)).rejects.toThrow();
    expect(sites.has("project-1")).toBe(false);
  });

  test("unpublish ignores custom domains", async () => {
    const { db } = createFakeDb([]);
    const { publisher } = setup(db);
    expect(await publisher.unpublish({ domain: "www.example.com" })).toEqual({
      success: true,
    });
  });

  test("unpublish reports an unknown project domain", async () => {
    const { db } = createFakeDb([]);
    const { publisher } = setup(db);
    expect(
      await publisher.unpublish({ domain: "ghost.wstd.work" })
    ).toMatchObject({
      success: false,
    });
  });
});
