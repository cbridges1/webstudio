import type { Db } from "@webstudio-is/db";
import {
  defaultPlanFeatures,
  type PlanFeatures,
  type Purchase,
} from "./plan-features";

type AuthorizationContext =
  | { type: "token"; ownerId: string }
  | { type: "user"; userId: string }
  | { type: "service" }
  | { type: "anonymous" };

type PlanInfo = {
  planFeatures: PlanFeatures;
  purchases: Array<Purchase>;
};

/**
 * Returns each user's features. selfhost: there are no plans to look up, so
 * every user gets every feature and no purchases.
 */
export const getPlanInfo = async (
  userIds: string[],
  _context: { db: Db }
): Promise<Map<string, PlanInfo>> =>
  new Map(
    userIds.map((userId) => [
      userId,
      { planFeatures: defaultPlanFeatures, purchases: [] },
    ])
  );

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
