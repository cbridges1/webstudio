import { describe, test, expect } from "vitest";
import { asset, eq, file, project } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { AuthorizationError } from "@webstudio-is/trpc-interface/index.server";
import { deleteAssets } from "./delete";

const db = setupTestDb();

const uid = () => `proj-${Math.random().toString(36).slice(2)}`;

const createContext = (): AppContext =>
  ({
    db,
    authorization: { type: "user", userId: "user-1" },
    getOwnerPlanFeatures: async () => ({}),
  }) as unknown as AppContext;

const readFile = async (name: string) =>
  (await db.select().from(file).where(eq(file.name, name)))[0];

describe("deleteAssets", () => {
  test("throws AuthorizationError when caller lacks edit access", async () => {
    const projectId = uid();
    await seed.project(db, { id: projectId, userId: "owner-1" });

    await expect(
      deleteAssets({ ids: ["asset-1"], projectId }, createContext())
    ).rejects.toThrow(AuthorizationError);
  });

  test("throws when no assets found", async () => {
    const projectId = uid();
    await seed.project(db, { id: projectId, userId: "user-1" });

    await expect(
      deleteAssets({ ids: ["asset-1"], projectId }, createContext())
    ).rejects.toThrow("Assets not found");
  });

  test("deletes assets, clears the preview image and marks unused file as deleted", async () => {
    const projectId = uid();
    await seed.project(db, { id: projectId, userId: "user-1" });
    await seed.asset(db, { id: "asset-1", projectId, name: "photo.jpg" });
    await db
      .update(project)
      .set({ previewImageAssetId: "asset-1" })
      .where(eq(project.id, projectId));

    await deleteAssets({ ids: ["asset-1"], projectId }, createContext());

    expect(await db.select().from(asset)).toEqual([]);
    expect(
      (await db.select().from(project).where(eq(project.id, projectId)))[0]
        .previewImageAssetId
    ).toBeNull();
    expect((await readFile("photo.jpg")).isDeleted).toBe(true);
  });

  test("does not mark file deleted when another asset still uses it", async () => {
    const projectId = uid();
    const otherProjectId = uid();
    await seed.project(db, { id: projectId, userId: "user-1" });
    await seed.project(db, { id: otherProjectId, userId: "user-1" });
    await seed.asset(db, { id: "asset-1", projectId, name: "photo.jpg" });
    // A clone shares the file.
    await seed.asset(db, {
      id: "asset-1",
      projectId: otherProjectId,
      name: "photo.jpg",
    });

    await deleteAssets({ ids: ["asset-1"], projectId }, createContext());

    expect((await readFile("photo.jpg")).isDeleted).toBe(false);
  });
});
