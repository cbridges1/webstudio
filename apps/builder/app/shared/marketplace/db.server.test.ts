import { describe, test, expect } from "vitest";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { getItems } from "./db.server";

const db = setupTestDb();

const ctx = { db } as unknown as AppContext;

const marketplaceProductJson = JSON.stringify({
  category: "sectionTemplates",
  name: "My Section",
  thumbnailAssetId: "asset-thumb",
  author: "Author Name",
  email: "author@example.com",
  website: "https://example.com",
  issues: "",
  description: "A nice section template for testing purposes.",
});

/** A marketplace project with one published build carrying `marketplaceProduct`. */
const seedMarketplaceProject = async ({
  id = "proj-1",
  marketplaceApprovalStatus = "APPROVED" as const,
  marketplaceProduct = marketplaceProductJson,
  published = true,
}: {
  id?: string;
  marketplaceApprovalStatus?: "APPROVED" | "PENDING";
  marketplaceProduct?: string;
  published?: boolean;
} = {}) => {
  await seed.project(db, { id, userId: "author-1", marketplaceApprovalStatus });
  await seed.build(db, {
    id: `${id}-build`,
    projectId: id,
    marketplaceProduct,
    deployment: published
      ? JSON.stringify({ destination: "saas", domains: [id] })
      : null,
  });
};

// ─── getItems ─────────────────────────────────────────────────

describe("getItems", () => {
  test("returns empty array when no marketplace products", async () => {
    const result = await getItems(ctx);
    expect(result).toEqual([]);
  });

  test("skips projects that aren't approved or published", async () => {
    await seedMarketplaceProject({
      id: "pending",
      marketplaceApprovalStatus: "PENDING",
    });
    await seedMarketplaceProject({ id: "unpublished", published: false });

    const result = await getItems(ctx);
    expect(result).toHaveLength(0);
  });

  test("skips products with invalid marketplaceProduct JSON", async () => {
    await seedMarketplaceProject({
      // Category not in enum → parse fails
      marketplaceProduct: JSON.stringify({ category: "invalid", name: "x" }),
    });

    const result = await getItems(ctx);
    expect(result).toHaveLength(0);
  });

  test("returns items with thumbnailAssetName when asset exists", async () => {
    await seedMarketplaceProject();
    await seed.asset(db, {
      id: "asset-thumb",
      projectId: "proj-1",
      name: "thumb.png",
    });
    await seed.authorizationToken(db, {
      token: "tok-abc",
      projectId: "proj-1",
      relation: "viewers",
    });

    const result = await getItems(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].projectId).toBe("proj-1");
    expect(result[0].authorizationToken).toBe("tok-abc");
    expect(result[0].thumbnailAssetName).toBe("thumb.png");
  });

  test("returns items without thumbnailAssetName when asset missing", async () => {
    await seedMarketplaceProject();

    const result = await getItems(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].authorizationToken).toBeUndefined();
    expect(result[0].thumbnailAssetName).toBeUndefined();
  });
});
