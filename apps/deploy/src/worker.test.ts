import { describe, expect, test } from "vitest";
import { deployJob, deployWorker, eq } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { DeployResult } from "@webstudio-is/deploy-protocol";
import type { Publisher, PublishJob, PublishOutcome } from "./publisher";
import { createQueue } from "./queue";
import { createDeployerServer } from "./server";
import { createWorker } from "./worker";

const db = setupTestDb();

const request = {
  builderOrigin: "https://builder.example.com",
  token: "publish-token",
};

/** A publisher that records what it was asked to do. */
const fakePublisher = ({
  publish = async () => ({ success: true, url: "https://p1.example.com/" }),
  validate = async () => ({ success: true }),
}: {
  publish?: (job: PublishJob) => Promise<PublishOutcome>;
  validate?: (projectId: string) => Promise<DeployResult>;
} = {}) => {
  const events: string[] = [];
  const publisher: Publisher = {
    hosts: () => [
      { id: "directory", label: "Folder", config: {}, credentials: null },
    ],
    publish: async (job) => {
      events.push(`publish ${job.buildId}`);
      return publish(job);
    },
    validate: async (projectId) => {
      events.push(`validate ${projectId}`);
      return validate(projectId);
    },
    unpublish: async (projectId) => {
      events.push(`unpublish ${projectId}`);
      return { success: true };
    },
    reportFailure: async (job, error) => {
      events.push(`report ${job.buildId}: ${error}`);
    },
  };
  return { publisher, events };
};

const setup = async (publisher = fakePublisher(), workerId = "worker-1") => {
  await seed.project(db, { id: "project-1", userId: "owner" });
  const worker = createWorker({
    queue: createQueue({ db, workerId }),
    publisher: publisher.publisher,
    // The tests wake it themselves.
    pollIntervalMs: 60_000,
    consoleLog: () => {},
  });
  return { worker, events: publisher.events };
};

const queueJob = async (
  values: Partial<typeof deployJob.$inferInsert> = {}
) => {
  const [row] = await db
    .insert(deployJob)
    .values({
      kind: "publish",
      projectId: "project-1",
      buildId: "build-1",
      request,
      ...values,
    })
    .returning({ id: deployJob.id });
  return row.id;
};

const jobRow = async (id: string) =>
  (await db.select().from(deployJob).where(eq(deployJob.id, id)))[0];

describe("worker", () => {
  test("registers with its hosts and runs queued jobs, recording the outcome", async () => {
    const { worker, events } = await setup(
      fakePublisher({
        validate: async () => ({ success: false, error: "bad site" }),
      })
    );
    const published = await queueJob();
    const checked = await queueJob({
      kind: "validate",
      buildId: null,
      request: {},
    });

    await worker.start();
    await worker.idle();
    await worker.stop();

    expect(events.sort()).toEqual(["publish build-1", "validate project-1"]);
    expect(await jobRow(published)).toMatchObject({
      status: "succeeded",
      result: { url: "https://p1.example.com/" },
      attempts: 1,
      workerId: "worker-1",
    });
    expect((await jobRow(published)).finishedAt).not.toBeNull();
    expect(await jobRow(checked)).toMatchObject({
      status: "failed",
      error: "bad site",
    });
    expect(await db.select().from(deployWorker)).toEqual([
      expect.objectContaining({
        id: "worker-1",
        hosts: [expect.objectContaining({ id: "directory" })],
      }),
    ]);
  });

  test("runs publishes one at a time, in order, with checks beside them", async () => {
    let release = () => {};
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const { worker, events } = await setup(
      fakePublisher({
        publish: async (job) => {
          if (job.buildId === "build-1") {
            await blocked;
          }
          return { success: true, url: "https://p1.example.com/" };
        },
      })
    );
    await queueJob({ buildId: "build-1" });
    await queueJob({ buildId: "build-2" });
    await worker.start();
    // A check queued while build-1 runs doesn't wait for it.
    const checked = await queueJob({
      kind: "validate",
      buildId: null,
      request: {},
    });
    worker.wake();
    await expect
      .poll(async () => (await jobRow(checked)).status)
      .toBe("succeeded");
    expect(events).toEqual(["publish build-1", "validate project-1"]);
    release();
    await worker.idle();
    await worker.stop();
    expect(events).toEqual([
      "publish build-1",
      "validate project-1",
      "publish build-2",
    ]);
  });

  test("two workers never take the same job", async () => {
    await seed.project(db, { id: "project-1", userId: "owner" });
    await queueJob();
    const a = createQueue({ db, workerId: "a" });
    const b = createQueue({ db, workerId: "b" });
    const claimed = await Promise.all([
      a.claim(["publish"]),
      b.claim(["publish"]),
    ]);
    expect(claimed.filter((job) => job !== undefined)).toHaveLength(1);
  });

  test("takes only its own queue's jobs", async () => {
    await seed.project(db, { id: "project-1", userId: "owner" });
    const id = await queueJob({ queue: "containers" });
    expect(
      await createQueue({ db, workerId: "a" }).claim(["publish"])
    ).toBeUndefined();
    expect(
      await createQueue({ db, workerId: "b", queue: "containers" }).claim([
        "publish",
      ])
    ).toMatchObject({ id });
  });

  test("takes back the jobs of a worker that died, and gives up after three tries", async () => {
    const { worker, events } = await setup();
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const retried = await queueJob({
      buildId: "build-1",
      status: "running",
      attempts: 1,
      workerId: "dead",
      heartbeatAt: longAgo,
    });
    const abandoned = await queueJob({
      buildId: "build-2",
      status: "running",
      attempts: 3,
      workerId: "dead",
      heartbeatAt: longAgo,
    });
    // Still heartbeating: another worker's job.
    const alive = await queueJob({
      buildId: "build-3",
      status: "running",
      attempts: 1,
      workerId: "other",
      heartbeatAt: new Date().toISOString(),
    });

    await worker.start();
    await worker.idle();
    await worker.stop();

    expect(await jobRow(retried)).toMatchObject({
      status: "succeeded",
      attempts: 2,
    });
    expect(await jobRow(abandoned)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("stopped while running this job, 3 times"),
    });
    expect(await jobRow(alive)).toMatchObject({ status: "running" });
    expect(events).toEqual([
      "report build-2: The deploy service stopped while running this publish",
      "publish build-1",
    ]);
  });

  test("fails a publish job it can't read", async () => {
    const { worker, events } = await setup();
    const broken = await queueJob({ request: { token: 1 } });
    await worker.start();
    await worker.idle();
    await worker.stop();
    expect(events).toEqual([]);
    expect(await jobRow(broken)).toMatchObject({
      status: "failed",
      error: "Invalid publish job",
    });
  });
});

describe("server", () => {
  const serve = async (wakeToken?: string) => {
    let wakes = 0;
    const server = createDeployerServer({
      wake: () => {
        wakes += 1;
      },
      status: () => ({ running: undefined }),
      wakeToken,
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as { port: number };
    return {
      url: `http://127.0.0.1:${port}`,
      wakes: () => wakes,
      close: () => new Promise((done) => server.close(done)),
    };
  };

  test("wakes on POST /wake, under any prefix", async () => {
    const server = await serve();
    expect(
      (await fetch(`${server.url}/deploy/wake`, { method: "POST" })).status
    ).toBe(202);
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${server.url}/wake`)).status).toBe(404);
    expect(server.wakes()).toBe(1);
    await server.close();
  });

  test("needs the wake token when one is set", async () => {
    const server = await serve("wake-secret");
    const wake = (token?: string) =>
      fetch(`${server.url}/wake`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    expect((await wake()).status).toBe(401);
    expect((await wake("wrong")).status).toBe(401);
    expect((await wake("wake-secret")).status).toBe(202);
    expect(server.wakes()).toBe(1);
    await server.close();
  });
});
