import { describe, expect, test } from "vitest";
import { setupTestDb } from "./testing";
import { build, domain, project, projectDomain, user } from "./schema";
import { loadDomainsVirtual, loadLatestBuildVirtual } from "./virtual";

const db = setupTestDb();

const seed = async () => {
  await db.insert(user).values({ id: "user-1" });
  await db.insert(project).values([
    { id: "p1", title: "One", domain: "one", userId: "user-1" },
    { id: "p2", title: "Two", domain: "two", userId: "user-1" },
  ]);
  await db.insert(domain).values({
    id: "d1",
    domain: "example.com",
    txtRecord: "txt-1",
    status: "ACTIVE",
  });
  await db.insert(projectDomain).values({
    projectId: "p1",
    domainId: "d1",
    txtRecord: "txt-1",
    cname: "one.wstd.work",
  });
  await db.insert(build).values([
    { id: "dev-1", projectId: "p1", pages: "{}" },
    {
      id: "b-old",
      projectId: "p1",
      pages: "{}",
      deployment: JSON.stringify({ domains: ["one"], destination: "saas" }),
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "b-custom",
      projectId: "p1",
      pages: "{}",
      deployment: JSON.stringify({ domains: ["example.com"] }),
      createdAt: "2026-02-01T00:00:00.000Z",
    },
    {
      id: "b-static",
      projectId: "p1",
      pages: "{}",
      deployment: JSON.stringify({ domains: ["one"], destination: "static" }),
      createdAt: "2026-03-01T00:00:00.000Z",
    },
  ]);
};

describe("timestamps", () => {
  test("read back as ISO strings", async () => {
    await db.insert(user).values({ id: "user-1" });
    const [row] = await db.select().from(user);
    expect(row.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });
});

describe("loadLatestBuildVirtual", () => {
  test("returns the latest saas build for any of the project's domains", async () => {
    await seed();
    const builds = await loadLatestBuildVirtual(db, ["p1", "p2"]);
    expect(builds.get("p1")).toEqual({
      buildId: "b-custom",
      projectId: "p1",
      domainsVirtualId: "",
      domain: "example.com",
      createdAt: "2026-02-01T00:00:00.000Z",
      publishStatus: "PENDING",
      publishError: null,
      updatedAt: expect.any(String),
    });
    expect(builds.has("p2")).toBe(false);
  });

  test("returns nothing for no projects", async () => {
    expect((await loadLatestBuildVirtual(db, [])).size).toBe(0);
  });
});

describe("loadDomainsVirtual", () => {
  test("returns custom domains with their latest build", async () => {
    await seed();
    const domains = await loadDomainsVirtual(db, ["p1", "p2"]);
    expect(domains.get("p1")).toEqual([
      expect.objectContaining({
        id: "d1-p1",
        domainId: "d1",
        projectId: "p1",
        domain: "example.com",
        status: "ACTIVE",
        verified: true,
        expectedTxtRecord: "txt-1",
        cname: "one.wstd.work",
        latestBuildVirtual: expect.objectContaining({
          buildId: "b-custom",
          domain: "example.com",
        }),
      }),
    ]);
    expect(domains.get("p2")).toBeUndefined();
  });
});
