import { eq, product, transactionLog, user, type Db } from "@webstudio-is/db";

/**
 * Upsert or delete dev plan rows in the DB for the given user email.
 * This lets getPlanInfo work naturally (same as production) for all callers,
 * including getOwnerPlanFeatures for shared-workspace suspension checks.
 *
 * - Plan selected: upsert a Product row (id = "dev-product-{planName}") and a
 *   TransactionLog row (eventId = "dev-{userId}") that satisfies the UserProduct view.
 * - No plan selected: delete the TransactionLog row so the user has no active purchase.
 */
export const applyDevPlan = async (
  email: string,
  planName: string | null,
  context: { db: Db }
) => {
  const { db } = context;
  try {
    // Resolve userId from email (user was already created by the authenticator).
    const [row] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email));

    const userId = row?.id;
    if (!userId) {
      console.error("[applyDevPlan] No user found for email:", email);
      return;
    }

    if (planName !== null) {
      const productId = `dev-product-${planName}`;
      const productRow = {
        id: productId,
        name: planName,
        meta: {},
        features: [],
        images: [],
      };
      await db
        .insert(product)
        .values(productRow)
        .onConflictDoUpdate({ target: product.id, set: productRow });

      const transaction = {
        eventId: `dev-${userId}`,
        userId,
        productId,
        eventData: {
          type: "checkout.session.completed",
          created: Math.floor(Date.now() / 1000),
          data: { object: { status: "complete" } },
        },
      };
      await db.insert(transactionLog).values(transaction).onConflictDoUpdate({
        target: transactionLog.eventId,
        set: transaction,
      });
    } else {
      // Remove any existing dev plan row — the user becomes free tier.
      await db
        .delete(transactionLog)
        .where(eq(transactionLog.eventId, `dev-${userId}`));
    }
  } catch (error) {
    console.error("[applyDevPlan] Failed to apply the dev plan:", error);
  }
};
