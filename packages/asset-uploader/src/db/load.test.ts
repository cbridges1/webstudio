import { describe, test, expect, vi } from "vitest";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { AuthorizationError } from "@webstudio-is/trpc-interface/index.server";
import { asset } from "@webstudio-is/sdk";
import { loadAssetsByProject } from "./load";

const db = setupTestDb();

const createContext = (): AppContext =>
  ({
    db,
    authorization: { type: "user", userId: "user-1" },
    getOwnerPlanFeatures: () => Promise.resolve({}),
  }) as unknown as AppContext;

const fileRow = {
  format: "jpg",
  size: 12345,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-02-01T00:00:00.000Z",
  meta: JSON.stringify({ width: 800, height: 600 }),
};

/** proj-1, owned by user-1. */
const seedProject = async () => {
  await seed.project(db, { id: "proj-1", userId: "user-1" });
};

describe("loadAssetsByProject", () => {
  test("returns formatted assets for an authorised project", async () => {
    await seedProject();
    await seed.asset(
      db,
      {
        id: "asset-1",
        projectId: "proj-1",
        name: "photo.jpg",
        filename: "photo.jpg",
      },
      fileRow
    );
    // Files still uploading are left out.
    await seed.asset(
      db,
      { id: "asset-2", projectId: "proj-1", name: "pending.jpg" },
      { ...fileRow, status: "UPLOADING" }
    );

    const result = await loadAssetsByProject("proj-1", createContext());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "asset-1",
      projectId: "proj-1",
      type: "image",
      meta: { width: 800, height: 600 },
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-02-01T00:00:00.000Z",
    });
  });

  test("returns empty array when project has no uploaded assets", async () => {
    await seedProject();

    const result = await loadAssetsByProject("proj-1", createContext());
    expect(result).toEqual([]);
  });

  test("loads malformed font metadata as a generic file and reports it", async () => {
    await seedProject();
    await seed.asset(
      db,
      {
        id: "font-1",
        projectId: "proj-1",
        name: "Inter.woff2",
        filename: "Inter",
      },
      { ...fileRow, format: "woff2", meta: JSON.stringify({}) }
    );
    const report = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await loadAssetsByProject("proj-1", createContext());

      expect(result).toMatchObject([
        {
          id: "font-1",
          type: "file",
          format: "unknown",
          meta: {},
        },
      ]);
      expect(asset.safeParse(result[0]).success).toBe(true);
      expect(report).toHaveBeenCalledWith(
        expect.stringContaining("Invalid stored font metadata"),
        expect.objectContaining({
          projectId: "proj-1",
          assets: [
            expect.objectContaining({
              assetId: "font-1",
              format: "woff2",
              issues: expect.arrayContaining([
                expect.objectContaining({ path: ["variationAxes"] }),
              ]),
            }),
          ],
        })
      );
    } finally {
      report.mockRestore();
    }
  });

  test("preserves references to existing folders", async () => {
    await seedProject();
    await seed.assetFolder(db, {
      id: "folder-1",
      projectId: "proj-1",
      name: "Images",
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    await seed.asset(
      db,
      {
        id: "asset-1",
        projectId: "proj-1",
        name: "photo.jpg",
        folderId: "folder-1",
      },
      fileRow
    );

    const [asset] = await loadAssetsByProject("proj-1", createContext());
    expect(asset?.folderId).toBe("folder-1");
  });

  test("throws AuthorizationError when caller lacks access", async () => {
    await seed.project(db, { id: "proj-denied", userId: "owner-1" });

    await expect(
      loadAssetsByProject("proj-denied", createContext())
    ).rejects.toThrow(AuthorizationError);
  });
});
