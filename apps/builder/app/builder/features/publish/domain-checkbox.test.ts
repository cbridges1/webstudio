import { describe, test, expect } from "vitest";
import { __testing__ } from "./domain-checkbox";

const { isCustomDomainPublishRestricted } = __testing__;

describe("isCustomDomainPublishRestricted", () => {
  test("anyone can publish to custom domains without the builder role", () => {
    expect(
      isCustomDomainPublishRestricted({
        canPublishToStagingOnly: false,
        isCustomDomain: true,
      })
    ).toBe(false);
  });

  test("builders can't publish to custom domains", () => {
    expect(
      isCustomDomainPublishRestricted({
        canPublishToStagingOnly: true,
        isCustomDomain: true,
      })
    ).toBe(true);
  });

  test("builders can publish to staging", () => {
    for (const isCustomDomain of [false, undefined]) {
      expect(
        isCustomDomainPublishRestricted({
          canPublishToStagingOnly: true,
          isCustomDomain,
        })
      ).toBe(false);
    }
  });
});
