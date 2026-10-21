import { describe, expect, test } from "vitest";
import { eq, project, user } from "@webstudio-is/db";
import { setupTestDb } from "@webstudio-is/db/testing";
import { defaultPlanFeatures } from "@webstudio-is/plans";
import type { AppContext } from "./context.server";
import {
  getPlanFeaturesByOwnerId,
  getProjectOwnerId,
  getProjectPlanFeatures,
} from "./project-plan.server";

const db = setupTestDb();

const createContext = (
  getOwnerPlanFeatures: AppContext["getOwnerPlanFeatures"] = async () =>
    defaultPlanFeatures
): AppContext =>
  ({
    db,
    getOwnerPlanFeatures,
  }) as unknown as AppContext;

const seedProject = async (id: string, userId: string | null) => {
  await db.insert(user).values([{ id: "owner-1" }, { id: "owner-2" }]);
  await db
    .insert(project)
    .values({ id, title: "Project", domain: `domain-${id}`, userId });
};

describe("project plan helpers", () => {
  test("resolves project owner id from Project.userId and caches it per context", async () => {
    await seedProject("project-1", "owner-1");
    const context = createContext();

    await expect(getProjectOwnerId("project-1", context)).resolves.toBe(
      "owner-1"
    );
    // A cached lookup doesn't see the change.
    await db
      .update(project)
      .set({ userId: "owner-2" })
      .where(eq(project.id, "project-1"));
    await expect(getProjectOwnerId("project-1", context)).resolves.toBe(
      "owner-1"
    );
    // A new context does.
    await expect(getProjectOwnerId("project-1", createContext())).resolves.toBe(
      "owner-2"
    );
  });

  test("resolves project plan features from the project owner and caches owner plan", async () => {
    await seedProject("project-1", "owner-1");
    const ownerPlanCalls: string[] = [];

    const context = createContext(async (ownerId) => {
      ownerPlanCalls.push(ownerId);
      return {
        ...defaultPlanFeatures,
        maxAssetsPerProject: 350,
      };
    });

    await expect(
      getProjectPlanFeatures("project-1", context)
    ).resolves.toMatchObject({
      maxAssetsPerProject: 350,
    });
    await expect(
      getProjectPlanFeatures("project-1", context)
    ).resolves.toMatchObject({
      maxAssetsPerProject: 350,
    });

    expect(ownerPlanCalls).toEqual(["owner-1"]);
  });

  test("rejects projects without an owner and retries after the failed cache entry is cleared", async () => {
    await seedProject("project-2", null);
    const context = createContext();

    await expect(getProjectOwnerId("project-2", context)).rejects.toThrow(
      "Project must have project userId defined"
    );
    await db
      .update(project)
      .set({ userId: "owner-2" })
      .where(eq(project.id, "project-2"));
    await expect(getProjectOwnerId("project-2", context)).resolves.toBe(
      "owner-2"
    );
  });

  test("rejects unknown projects", async () => {
    await expect(getProjectOwnerId("missing", createContext())).rejects.toThrow(
      "Project not found"
    );
  });

  test("clears failed owner-plan cache entries before retrying", async () => {
    let ownerPlanCalls = 0;
    const context = createContext(async () => {
      ownerPlanCalls += 1;
      if (ownerPlanCalls === 1) {
        throw new Error("temporary plan failure");
      }
      return {
        ...defaultPlanFeatures,
        maxDomainsAllowedPerUser: 5,
      };
    });

    await expect(getPlanFeaturesByOwnerId("owner-3", context)).rejects.toThrow(
      "temporary plan failure"
    );
    await expect(
      getPlanFeaturesByOwnerId("owner-3", context)
    ).resolves.toMatchObject({
      maxDomainsAllowedPerUser: 5,
    });
    expect(ownerPlanCalls).toBe(2);
  });
});
