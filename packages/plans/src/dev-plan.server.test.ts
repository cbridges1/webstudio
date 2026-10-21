import { describe, test, expect } from "vitest";
import { eq, product, transactionLog, userProduct } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import { applyDevPlan } from "./dev-plan.server";

const db = setupTestDb();
const context = { db };

// ─── applyDevPlan ─────────────────────────────────────────────

describe("applyDevPlan", () => {
  test("does nothing when user is not found", async () => {
    // Should resolve without throwing even when user is missing
    await expect(
      applyDevPlan("ghost@example.com", "Pro", context)
    ).resolves.toBeUndefined();
    expect(await db.select().from(product)).toEqual([]);
  });

  test("upserts Product and TransactionLog when plan is set", async () => {
    await seed.user(db, { id: "user-1", email: "dev@example.com" });

    await applyDevPlan("dev@example.com", "Pro", context);
    // Applying again updates the same rows.
    await applyDevPlan("dev@example.com", "Pro", context);

    expect(await db.select().from(product)).toEqual([
      expect.objectContaining({ id: "dev-product-Pro", name: "Pro" }),
    ]);
    expect(await db.select().from(transactionLog)).toEqual([
      expect.objectContaining({
        eventId: "dev-user-1",
        userId: "user-1",
        productId: "dev-product-Pro",
      }),
    ]);
    // The row is what the UserProduct view counts as an active purchase.
    expect(
      await db
        .select({ productId: userProduct.productId })
        .from(userProduct)
        .where(eq(userProduct.userId, "user-1"))
    ).toEqual([{ productId: "dev-product-Pro" }]);
  });

  test("deletes TransactionLog when plan is null (free tier)", async () => {
    await seed.user(db, { id: "user-1", email: "dev@example.com" });
    await applyDevPlan("dev@example.com", "Pro", context);

    await applyDevPlan("dev@example.com", null, context);
    expect(await db.select().from(transactionLog)).toEqual([]);
  });
});
