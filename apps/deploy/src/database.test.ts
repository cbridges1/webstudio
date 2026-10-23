import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { eq, project } from "@webstudio-is/db";
import { createTestDb, resetTestDb, seed } from "@webstudio-is/db/testing";
import { createDatabase } from "./database";

// The fork's in-process Postgres with its migrations applied, so these queries
// are checked against the schema the builder runs on.
let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(testDb);
});
afterAll(async () => {
  await testDb.close();
});

const loadPublishedUrl = async (projectId: string) => {
  const [row] = await testDb
    .select({ publishedUrl: project.publishedUrl })
    .from(project)
    .where(eq(project.id, projectId));
  return row?.publishedUrl;
};

describe("database", () => {
  test("reads a build and updates its publish status", async () => {
    await seed.project(testDb, { id: "project-1", domain: "p1" });
    await seed.build(testDb, {
      id: "build-1",
      projectId: "project-1",
      deployment: JSON.stringify({ domains: ["p1"] }),
    });
    const db = createDatabase(testDb);

    expect(await db.getBuild("build-1")).toEqual({
      id: "build-1",
      projectId: "project-1",
      deployment: JSON.stringify({ domains: ["p1"] }),
      publishStatus: "PENDING",
    });
    await db.setPublishStatus("build-1", "PUBLISHED");
    expect(await db.getBuild("build-1")).toMatchObject({
      publishStatus: "PUBLISHED",
    });
    expect(await db.getBuild("missing")).toBeUndefined();
  });

  test("finds live projects by domain", async () => {
    await seed.project(testDb, { id: "project-1", domain: "p1" });
    await seed.project(testDb, {
      id: "project-2",
      domain: "gone",
      isDeleted: true,
    });
    const db = createDatabase(testDb);

    expect(await db.findProjectIdByDomain("p1")).toBe("project-1");
    expect(await db.findProjectIdByDomain("gone")).toBeUndefined();
  });

  test("sets and clears the published link", async () => {
    await seed.project(testDb, { id: "project-1", domain: "p1" });
    const db = createDatabase(testDb);

    await db.setPublishedUrl("project-1", "https://p1.example.com/");
    expect(await loadPublishedUrl("project-1")).toBe("https://p1.example.com/");
    await db.clearPublishedUrl("project-1");
    expect(await loadPublishedUrl("project-1")).toBeNull();
  });
});
