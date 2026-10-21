import { describe, test, expect } from "vitest";
import {
  asset,
  domain,
  eq,
  file,
  project,
  projectDomain,
} from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { AuthorizationError } from "@webstudio-is/trpc-interface/index.server";
import { findMany, findManyByIds, countByUserId } from "./projects";

const db = setupTestDb();

const createContext = (userId = "user-1"): AppContext =>
  ({
    db,
    authorization: { type: "user", userId },
  }) as unknown as AppContext;

const WS1 = "00000000-0000-4000-8000-000000000001";

// ---------------------------------------------------------------------------
// countByUserId
// ---------------------------------------------------------------------------

describe("countByUserId", () => {
  test("counts the user's live projects", async () => {
    for (const id of ["p1", "p2", "p3"]) {
      await seed.project(db, { id, userId: "user-1" });
    }
    await seed.project(db, { id: "gone", userId: "user-1", isDeleted: true });
    await seed.project(db, { id: "theirs", userId: "user-2" });

    const count = await countByUserId({
      userId: "user-1",
      context: createContext(),
    });
    expect(count).toBe(3);
  });

  test("throws AuthorizationError when userId does not match caller", async () => {
    await expect(
      countByUserId({ userId: "other-user", context: createContext("user-1") })
    ).rejects.toThrow(AuthorizationError);
  });
});

// ---------------------------------------------------------------------------
// findMany
// ---------------------------------------------------------------------------

describe("findMany", () => {
  test("returns projects with empty domainsVirtual when no domains exist", async () => {
    await seed.project(db, { id: "proj-1", userId: "user-1" });
    await seed.project(db, { id: "gone", userId: "user-1", isDeleted: true });

    const result = await findMany({
      userId: "user-1",
      context: createContext(),
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "proj-1",
      isPublished: false,
      previewImageAsset: null,
      latestBuildVirtual: null,
      domainsVirtual: [],
    });
  });

  test("includes custom domains, the preview image and the latest publish", async () => {
    await seed.project(db, {
      id: "proj-1",
      userId: "user-1",
      domain: "my-project",
    });
    await db.insert(file).values({
      name: "preview.png",
      format: "png",
      size: 1,
      status: "UPLOADED",
    });
    await db
      .insert(asset)
      .values({ id: "asset-1", projectId: "proj-1", name: "preview.png" });
    await db.insert(domain).values({
      id: "d1",
      domain: "example.com",
      status: "ACTIVE",
      txtRecord: "txt",
    });
    await db.insert(projectDomain).values({
      projectId: "proj-1",
      domainId: "d1",
      txtRecord: "txt",
      cname: "cname",
    });
    await seed.build(db, {
      id: "b-prod",
      projectId: "proj-1",
      deployment: JSON.stringify({ domains: ["my-project"] }),
    });
    await db
      .update(project)
      .set({ previewImageAssetId: "asset-1" })
      .where(eq(project.id, "proj-1"));

    const result = await findMany({
      userId: "user-1",
      context: createContext(),
    });
    const found = result.find((item) => item.id === "proj-1");
    expect(found).toMatchObject({
      isPublished: true,
      previewImageAsset: { id: "asset-1", name: "preview.png" },
      latestBuildVirtual: { buildId: "b-prod", domain: "my-project" },
      domainsVirtual: [
        { domain: "example.com", status: "ACTIVE", verified: true },
      ],
    });
  });

  test("throws AuthorizationError when userId does not match caller", async () => {
    await expect(
      findMany({ userId: "other-user", context: createContext("user-1") })
    ).rejects.toThrow(AuthorizationError);
  });

  test("filters by workspaceId when provided and caller is owner", async () => {
    await seed.workspace(db, { id: WS1, userId: "user-1" });
    await seed.project(db, {
      id: "proj-1",
      userId: "user-1",
      workspaceId: WS1,
    });
    await seed.project(db, { id: "unassigned", userId: "user-1" });

    const result = await findMany({
      userId: "user-1",
      context: createContext(),
      workspaceId: WS1,
    });
    expect(result.map((item) => item.id)).toEqual(["proj-1"]);
    expect(result[0].workspaceId).toBe(WS1);
  });

  test("includes the user's unassigned projects for the default workspace", async () => {
    await seed.workspace(db, { id: WS1, userId: "user-1", isDefault: true });
    await seed.project(db, {
      id: "proj-1",
      userId: "user-1",
      workspaceId: WS1,
      createdAt: "2024-01-02T00:00:00.000Z",
    });
    await seed.project(db, {
      id: "unassigned",
      userId: "user-1",
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    await seed.project(db, { id: "theirs", userId: "user-2" });

    const result = await findMany({
      userId: "user-1",
      context: createContext(),
      workspaceId: WS1,
      includeUnassigned: true,
    });
    expect(result.map((item) => item.id)).toEqual(["proj-1", "unassigned"]);
  });

  test("rejects a workspace the caller doesn't belong to", async () => {
    await seed.workspace(db, { id: WS1, userId: "user-2" });

    await expect(
      findMany({
        userId: "user-1",
        context: createContext(),
        workspaceId: WS1,
      })
    ).rejects.toThrow("You don't have access to this workspace");
  });
});

// ---------------------------------------------------------------------------
// findManyByIds
// ---------------------------------------------------------------------------

describe("findManyByIds", () => {
  test("returns the caller's projects and approved marketplace projects", async () => {
    await seed.project(db, { id: "mine", userId: "user-1" });
    await seed.project(db, {
      id: "approved",
      userId: "user-2",
      marketplaceApprovalStatus: "APPROVED",
    });
    await seed.project(db, { id: "private", userId: "user-2" });

    const result = await findManyByIds(
      ["mine", "approved", "private"],
      createContext()
    );
    expect(result.map((item) => item.id).sort()).toEqual(["approved", "mine"]);
  });
});
