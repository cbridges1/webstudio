import {
  and,
  desc,
  eq,
  gt,
  inArray,
  maybeOne,
  product,
  transactionLog,
  userProduct,
  type Db,
} from "@webstudio-is/db";
import {
  type PlanFeatures,
  planFeatures,
  defaultPlanFeatures,
  parsePlansEnv,
  type Purchase,
} from "./plan-features";

export { parsePlansEnv } from "./plan-features";

type AuthorizationContext =
  | { type: "token"; ownerId: string }
  | { type: "user"; userId: string }
  | { type: "service" }
  | { type: "anonymous" };

type PlanInfo = {
  planFeatures: PlanFeatures;
  purchases: Array<Purchase>;
};

export const parseProductMeta = (meta: unknown): Partial<PlanFeatures> => {
  const result = planFeatures.partial().safeParse(meta);
  return result.success ? result.data : {};
};

export const mergeProductMetas = (
  productMetas: Array<PlanFeatures>
): PlanFeatures => {
  if (productMetas.length === 0) {
    return defaultPlanFeatures;
  }

  return Object.fromEntries(
    (Object.keys(defaultPlanFeatures) as Array<keyof PlanFeatures>).map(
      (key) => {
        const vals = productMetas.map((item) => item[key]);
        const merged =
          typeof defaultPlanFeatures[key] === "boolean"
            ? (vals as Array<boolean>).some(Boolean)
            : Math.max(...(vals as Array<number>));
        return [key, merged];
      }
    )
  ) as PlanFeatures;
};

export const buildPurchases = (
  userProducts: Array<{
    productId: string | null | undefined;
    subscriptionId: string | null | undefined;
  }>,
  productIdToName: Map<string, string>
): Array<Purchase> => {
  const purchases: Array<Purchase> = [];
  for (const userProduct of userProducts) {
    if (userProduct.productId === null || userProduct.productId === undefined) {
      continue;
    }
    purchases.push({
      planName: productIdToName.get(userProduct.productId) ?? "",
      subscriptionId: userProduct.subscriptionId ?? undefined,
    });
  }
  return purchases;
};

type Product = { id: string; name: string; meta: unknown };

// Products are admin-created and rarely change. Cache them for the lifetime of the
// server instance to avoid a repeated DB round-trip on every request.
// The promise itself is cached to deduplicate concurrent cold-start requests.
let productCachePromise: Promise<Map<string, Product>> | undefined;

const fetchProducts = (db: Db): Promise<Map<string, Product>> =>
  db
    .select({ id: product.id, name: product.name, meta: product.meta })
    .from(product)
    .then(
      (rows) => new Map(rows.map((row) => [row.id, row])),
      (error) => {
        console.error(error);
        throw new Error("Failed to fetch products");
      }
    );

const getProductCache = (db: Db): Promise<Map<string, Product>> => {
  // Skip caching in test environment so each test gets a fresh fetch.
  if (process.env.VITEST !== undefined) {
    return fetchProducts(db);
  }
  if (productCachePromise !== undefined) {
    return productCachePromise;
  }
  const promise = fetchProducts(db);
  promise.catch(() => {
    productCachePromise = undefined;
  });
  productCachePromise = promise;
  return promise;
};

export const getPlanInfo = async (
  userIds: string[],
  context: { db: Db }
): Promise<Map<string, PlanInfo>> => {
  const { db } = context;

  if (userIds.length === 0) {
    return new Map();
  }

  const userProductRows = await db
    .select({
      userId: userProduct.userId,
      subscriptionId: userProduct.subscriptionId,
      productId: userProduct.productId,
    })
    .from(userProduct)
    .where(inArray(userProduct.userId, userIds))
    .catch((error) => {
      console.error(error);
      throw new Error("Failed to fetch user products");
    });

  const userProductsByUserId = new Map<
    string,
    Array<{
      productId: string | null;
      subscriptionId: string | null;
    }>
  >();

  for (const row of userProductRows) {
    if (row.userId === null) {
      continue;
    }
    const rows = userProductsByUserId.get(row.userId) ?? [];
    rows.push({
      productId: row.productId,
      subscriptionId: row.subscriptionId,
    });
    userProductsByUserId.set(row.userId, rows);
  }

  const productIds = [
    ...new Set(
      userProductRows.flatMap(({ productId }) =>
        productId === null || productId === undefined ? [] : [productId]
      )
    ),
  ];

  if (productIds.length === 0) {
    return new Map(
      userIds.map((userId) => [
        userId,
        { planFeatures: defaultPlanFeatures, purchases: [] },
      ])
    );
  }

  const allProducts = await getProductCache(db);
  const productById = new Map(
    productIds.flatMap((id) => {
      const product = allProducts.get(id);
      return product !== undefined ? [[id, product] as const] : [];
    })
  );
  const productIdToName = new Map(
    [...productById.values()].map((product) => [product.id, product.name])
  );
  const plansByName = parsePlansEnv(process.env.PLANS ?? "[]");

  return new Map(
    userIds.map((userId) => {
      const userProducts = userProductsByUserId.get(userId) ?? [];
      const productMetas = userProducts.flatMap(({ productId }) => {
        if (productId === null || productId === undefined) {
          return [];
        }
        const product = productById.get(productId);
        if (product === undefined) {
          return [];
        }
        return [
          {
            ...(plansByName.get(product.name)?.features ?? defaultPlanFeatures),
            ...parseProductMeta(product.meta),
          },
        ];
      });

      return [
        userId,
        {
          planFeatures: mergeProductMetas(productMetas),
          purchases: buildPurchases(userProducts, productIdToName),
        },
      ];
    })
  );
};

/**
 * Returns the extra-seat subscription quantity for the given user, derived
 * from the latest customer.subscription.updated/created event in TransactionLog
 * whose product is an extra-seat plan (maxSeatsPerWorkspace > 0, maxWorkspaces <= 1).
 *
 * Returns null when no matching event exists (free plan, no extra seats, etc.).
 */
export const getExtraPaidSeats = async (
  userId: string,
  context: { db: Db }
): Promise<number | null> => {
  const { db } = context;
  const seatProductIds = (
    await db
      .select({ id: product.id })
      .from(product)
      .where(eq(product.name, "Seats"))
  ).map((p) => p.id);
  if (seatProductIds.length === 0) {
    return null;
  }

  const latest = maybeOne(
    await db
      .select({
        eventData: transactionLog.eventData,
        subscriptionId: transactionLog.subscriptionId,
        eventCreated: transactionLog.eventCreated,
      })
      .from(transactionLog)
      .where(
        and(
          eq(transactionLog.userId, userId),
          inArray(transactionLog.eventType, [
            "customer.subscription.updated",
            "customer.subscription.created",
          ]),
          inArray(transactionLog.productId, seatProductIds)
        )
      )
      .orderBy(desc(transactionLog.eventCreated))
      .limit(1)
  );

  if (latest === null) {
    return null;
  }

  // Check if the subscription was cancelled after this event.
  if (latest.subscriptionId) {
    const deleted = await db
      .select({ eventId: transactionLog.eventId })
      .from(transactionLog)
      .where(
        and(
          eq(transactionLog.subscriptionId, latest.subscriptionId),
          eq(transactionLog.eventType, "customer.subscription.deleted"),
          eq(transactionLog.status, "canceled"),
          latest.eventCreated === null
            ? undefined
            : gt(transactionLog.eventCreated, latest.eventCreated)
        )
      )
      .limit(1);

    if (deleted.length > 0) {
      return null;
    }
  }

  const eventData = latest.eventData as
    | {
        data?: {
          object?: {
            items?: { data?: Array<{ quantity?: unknown }> };
          };
        };
      }
    | null
    | undefined;
  const rawQuantity = eventData?.data?.object?.items?.data?.[0]?.quantity;
  return typeof rawQuantity === "number" ? rawQuantity : null;
};

export const __testing__ = {
  parseProductMeta,
  mergeProductMetas,
};

export const getAuthorizationOwnerId = (
  authorization: AuthorizationContext
): string | undefined => {
  if (authorization.type === "token") {
    return authorization.ownerId;
  }
  if (authorization.type === "user") {
    return authorization.userId;
  }
  return undefined;
};
