import { describe, expect, test } from "vitest";
import type { Db } from "@webstudio-is/db";
import { defaultPlanFeatures, isUnlimited } from "./plan-features";
import { getPlanInfo } from "./plan-client.server";

describe("plans", () => {
  test("every feature is on and every limit is unlimited", () => {
    for (const value of Object.values(defaultPlanFeatures)) {
      expect(value === true || isUnlimited(value as number)).toBe(true);
    }
  });

  test("every user gets every feature and no purchases", async () => {
    const info = await getPlanInfo(["a", "b"], { db: {} as Db });
    expect([...info.keys()]).toEqual(["a", "b"]);
    expect(info.get("a")).toEqual({
      planFeatures: defaultPlanFeatures,
      purchases: [],
    });
  });

  test("unlimited survives JSON", () => {
    const parsed = JSON.parse(JSON.stringify(defaultPlanFeatures));
    expect(parsed).toEqual(defaultPlanFeatures);
  });
});
