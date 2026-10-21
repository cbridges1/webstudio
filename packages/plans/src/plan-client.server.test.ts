import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  product,
  transactionLog,
  userProduct,
  type Db,
  type Json,
} from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import { type PlanFeatures, defaultPlanFeatures } from "./plan-features";
import {
  getPlanInfo,
  getExtraPaidSeats,
  __testing__,
} from "./plan-client.server";

const { parseProductMeta, mergeProductMetas } = __testing__;

const db = setupTestDb();
const testContext = { db };

beforeEach(() => {
  vi.unstubAllEnvs();
});

const seedProduct = async (
  id: string,
  name: string,
  meta: Record<string, unknown> = {}
) => {
  await db.insert(product).values({ id, name, meta: meta as Json });
};

/** A completed checkout, which the UserProduct view counts as a purchase. */
const seedPurchase = async (
  userId: string,
  productId: string,
  subscriptionId?: string
) => {
  await seed.user(db, { id: userId });
  await db.insert(transactionLog).values({
    eventId: `evt-${userId}-${productId}`,
    userId,
    productId,
    eventData: {
      type: "checkout.session.completed",
      created: 100,
      data: { object: { status: "complete", subscription: subscriptionId } },
    },
  });
};

/**
 * A database whose queries fail for `failingSource` and otherwise answer with
 * `rows`, for exercising error handling.
 */
const createFailingDb = (
  failingSource: unknown,
  rows: Record<string, unknown>[] = []
) => {
  const answer = (source: unknown) =>
    source === failingSource
      ? Promise.reject(new Error("db error"))
      : Promise.resolve(rows);
  return {
    select: () => ({
      from: (source: unknown) => {
        const result = answer(source);
        result.catch(() => {});
        return Object.assign(result, { where: () => answer(source) });
      },
    }),
  } as unknown as Db;
};

describe("getPlanInfo", () => {
  test("empty userIds returns empty map without hitting DB", async () => {
    const result = await getPlanInfo([], testContext);
    expect(result.size).toBe(0);
  });

  test("user with no products returns defaultPlanFeatures", async () => {
    const result = await getPlanInfo(["user-1"], testContext);
    expect(result.get("user-1")).toEqual({
      planFeatures: defaultPlanFeatures,
      purchases: [],
    });
  });

  test("user with one product resolves plan features from PLANS env + meta merge", async () => {
    vi.stubEnv(
      "PLANS",
      JSON.stringify([{ name: "Pro", maxDomainsAllowedPerUser: 5 }])
    );
    await seedProduct("prod-pro", "Pro", { maxDomainsAllowedPerUser: 10 });
    await seedPurchase("user-1", "prod-pro", "sub-abc");

    const result = await getPlanInfo(["user-1"], testContext);
    const info = result.get("user-1");
    // meta overrides env plan: maxDomainsAllowedPerUser should be 10 (from meta)
    expect(info?.planFeatures.maxDomainsAllowedPerUser).toBe(10);
    expect(info?.purchases).toEqual([
      { planName: "Pro", subscriptionId: "sub-abc" },
    ]);
  });

  test("product not in PLANS falls back to defaultPlanFeatures for that product", async () => {
    vi.stubEnv("PLANS", JSON.stringify([]));
    await seedProduct("prod-pro", "Pro", { maxDomainsAllowedPerUser: 10 });
    await seedPurchase("user-1", "prod-pro");

    const result = await getPlanInfo(["user-1"], testContext);
    const info = result.get("user-1");
    // meta provides maxDomainsAllowedPerUser: 10, rest from defaultPlanFeatures
    expect(info?.planFeatures.maxDomainsAllowedPerUser).toBe(10);
    expect(info?.planFeatures.canDownloadAssets).toBe(
      defaultPlanFeatures.canDownloadAssets
    );
  });

  test("multiple users resolved together", async () => {
    vi.stubEnv("PLANS", JSON.stringify([]));
    await seedProduct("prod-pro", "Pro");
    await seedPurchase("user-1", "prod-pro", "sub-abc");
    await seedPurchase("user-2", "prod-pro");

    const result = await getPlanInfo(["user-1", "user-2"], testContext);
    expect(result.size).toBe(2);
    expect(result.get("user-1")?.purchases[0].planName).toBe("Pro");
    expect(result.get("user-2")?.purchases[0].subscriptionId).toBeUndefined();
  });

  test("UserProduct DB error throws", async () => {
    await expect(
      getPlanInfo(["user-1"], { db: createFailingDb(userProduct) })
    ).rejects.toThrow("Failed to fetch user products");
  });

  test("Product DB error throws and cache is cleared for retry", async () => {
    await expect(
      getPlanInfo(["user-1"], {
        db: createFailingDb(product, [
          { userId: "user-1", productId: "prod-pro", subscriptionId: null },
        ]),
      })
    ).rejects.toThrow("Failed to fetch products");

    // After error the cache is cleared — next call should hit DB again
    vi.stubEnv("PLANS", JSON.stringify([]));
    await seedProduct("prod-pro", "Pro");
    await seedPurchase("user-1", "prod-pro");
    const result = await getPlanInfo(["user-1"], testContext);
    expect(result.get("user-1")?.purchases[0].planName).toBe("Pro");
  });
});

/** Full-featured plan for use in tests — all booleans true, numeric limits at max */
const fullFeatures: PlanFeatures = {
  ...defaultPlanFeatures,
  canDownloadAssets: true,
  canRestoreBackups: true,
  allowAdditionalPermissions: true,
  allowDynamicData: true,
  allowAuth: true,
  allowContentMode: true,
  allowStagingPublish: true,
  maxContactEmailsPerProject: 5,
  maxDomainsAllowedPerUser: 100,
  maxDailyPublishesPerUser: 100,
  maxWorkspaces: 1,
  maxProjectsAllowedPerUser: 100,
};

describe("parseProductMeta", () => {
  test("extracts known keys from a valid object", () => {
    const result = parseProductMeta({
      maxContactEmailsPerProject: 10,
      canDownloadAssets: true,
    });
    expect(result).toEqual({
      maxContactEmailsPerProject: 10,
      canDownloadAssets: true,
    });
  });

  test("strips unknown keys", () => {
    const result = parseProductMeta({
      admin: true,
      maxContactEmailsPerProject: 3,
    });
    expect(result).toEqual({ maxContactEmailsPerProject: 3 });
  });

  test("returns empty object for non-object input", () => {
    expect(parseProductMeta("not an object")).toEqual({});
    expect(parseProductMeta(42)).toEqual({});
    expect(parseProductMeta(undefined)).toEqual({});
  });

  test("returns empty object for null input", () => {
    expect(parseProductMeta(null)).toEqual({});
  });

  test("rejects negative numbers", () => {
    const result = parseProductMeta({ maxContactEmailsPerProject: -1 });
    expect(result).toEqual({});
  });

  test("accepts zero for numeric fields", () => {
    const result = parseProductMeta({ maxWorkspaces: 0 });
    expect(result).toEqual({ maxWorkspaces: 0 });
  });

  test("rejects wrong types for fields", () => {
    const result = parseProductMeta({
      canDownloadAssets: "yes",
      maxContactEmailsPerProject: "five",
    });
    expect(result).toEqual({});
  });
});

describe("mergeProductMetas", () => {
  test("booleans: true if ANY product grants the feature", () => {
    const result = mergeProductMetas([
      { ...fullFeatures, canDownloadAssets: false, canRestoreBackups: true },
      { ...fullFeatures, canDownloadAssets: true, canRestoreBackups: false },
    ]);
    expect(result.canDownloadAssets).toBe(true);
    expect(result.canRestoreBackups).toBe(true);
  });

  test("booleans: false when NO product grants the feature", () => {
    const result = mergeProductMetas([
      { ...fullFeatures, canDownloadAssets: false },
      { ...fullFeatures, canDownloadAssets: false },
    ]);
    expect(result.canDownloadAssets).toBe(false);
  });

  test("numbers: takes the highest value across products", () => {
    const result = mergeProductMetas([
      { ...fullFeatures, maxContactEmailsPerProject: 3, maxWorkspaces: 2 },
      { ...fullFeatures, maxContactEmailsPerProject: 10, maxWorkspaces: 5 },
    ]);
    expect(result.maxContactEmailsPerProject).toBe(10);
    expect(result.maxWorkspaces).toBe(5);
  });

  test("single product returns its values unchanged", () => {
    const plan = { ...fullFeatures, maxWorkspaces: 7 };
    const result = mergeProductMetas([plan]);
    expect(result).toEqual(plan);
  });

  test("empty array returns defaultPlanFeatures", () => {
    const result = mergeProductMetas([]);
    expect(result).toEqual(defaultPlanFeatures);
  });
});

describe("workspaces plan", () => {
  test("merging pro + workspaces product picks highest maxWorkspaces", () => {
    const proProduct = { ...fullFeatures, maxWorkspaces: 1 };
    const workspacesProduct = { ...defaultPlanFeatures, maxWorkspaces: 20 };

    const result = mergeProductMetas([proProduct, workspacesProduct]);
    expect(result.maxWorkspaces).toBe(20);
    expect(result.canDownloadAssets).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getExtraPaidSeats
// ---------------------------------------------------------------------------

const seedSubscriptionEvent = async ({
  eventId,
  type,
  created,
  quantity,
  status = "active",
  subscriptionId = "sub-seats",
  productId = "prod-seats",
}: {
  eventId: string;
  type: string;
  created: number;
  quantity?: number;
  status?: string;
  subscriptionId?: string;
  productId?: string;
}) => {
  await seed.user(db, { id: "user-1" });
  await db.insert(transactionLog).values({
    eventId,
    userId: "user-1",
    productId,
    eventData: {
      type,
      created,
      data: {
        object: {
          object: "subscription",
          id: subscriptionId,
          status,
          items: quantity === undefined ? undefined : { data: [{ quantity }] },
        },
      },
    },
  });
};

describe("getExtraPaidSeats", () => {
  test("returns quantity from latest subscription event", async () => {
    await seedProduct("prod-seats", "Seats");
    await seedSubscriptionEvent({
      eventId: "evt-1",
      type: "customer.subscription.created",
      created: 1000,
      quantity: 2,
    });
    await seedSubscriptionEvent({
      eventId: "evt-2",
      type: "customer.subscription.updated",
      created: 2000,
      quantity: 3,
    });
    const result = await getExtraPaidSeats("user-1", testContext);
    expect(result).toBe(3);
  });

  test("returns null when no Seats product exists", async () => {
    const result = await getExtraPaidSeats("user-1", testContext);
    expect(result).toBeNull();
  });

  test("returns null when no subscription event exists", async () => {
    await seedProduct("prod-seats", "Seats");
    const result = await getExtraPaidSeats("user-1", testContext);
    expect(result).toBeNull();
  });

  test("returns null when subscription was deleted after the latest event", async () => {
    await seedProduct("prod-seats", "Seats");
    await seedSubscriptionEvent({
      eventId: "evt-1",
      type: "customer.subscription.updated",
      created: 1000,
      quantity: 2,
    });
    await seedSubscriptionEvent({
      eventId: "evt-del",
      type: "customer.subscription.deleted",
      created: 2000,
      status: "canceled",
    });
    const result = await getExtraPaidSeats("user-1", testContext);
    expect(result).toBeNull();
  });

  test("returns quantity when the deletion happened before the latest event", async () => {
    await seedProduct("prod-seats", "Seats");
    await seedSubscriptionEvent({
      eventId: "evt-del",
      type: "customer.subscription.deleted",
      created: 500,
      status: "canceled",
    });
    await seedSubscriptionEvent({
      eventId: "evt-1",
      type: "customer.subscription.updated",
      created: 1000,
      quantity: 5,
    });
    const result = await getExtraPaidSeats("user-1", testContext);
    expect(result).toBe(5);
  });

  test("returns null when eventData has no quantity", async () => {
    await seedProduct("prod-seats", "Seats");
    await seedSubscriptionEvent({
      eventId: "evt-1",
      type: "customer.subscription.updated",
      created: 1000,
    });
    const result = await getExtraPaidSeats("user-1", testContext);
    expect(result).toBeNull();
  });
});
