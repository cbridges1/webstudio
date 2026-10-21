import { describe, test, expect } from "vitest";
import { build, eq, project } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { defaultPlanFeatures } from "@webstudio-is/plans";
import { create } from "./project";

const db = setupTestDb();

const createContext = (
  planOverrides: Partial<typeof defaultPlanFeatures> = {}
): AppContext =>
  ({
    authorization: { type: "user", userId: "owner-1" },
    planFeatures: defaultPlanFeatures,
    purchases: [],
    trpcCache: new Map(),
    domain: {},
    deployment: {},
    entri: {},
    db,
    createTokenContext: () => {},
    getOwnerPlanFeatures: async () => ({
      ...defaultPlanFeatures,
      ...planOverrides,
    }),
  }) as unknown as AppContext;

const seedOwnerProjects = async (count: number) => {
  await seed.user(db, { id: "owner-1" });
  for (let index = 0; index < count; index += 1) {
    await seed.project(db, { id: `existing-${index}`, userId: "owner-1" });
  }
};

describe("create — maxProjectsAllowedPerUser guard", () => {
  test("throws when owner is at the project limit", async () => {
    await seedOwnerProjects(3);

    const ctx = createContext({ maxProjectsAllowedPerUser: 3 });

    await expect(create({ title: "New Project" }, ctx)).rejects.toThrow(
      "You've reached the project limit"
    );
  });

  test("deleted projects don't count toward the limit", async () => {
    await seedOwnerProjects(3);
    await db
      .update(project)
      .set({ isDeleted: true })
      .where(eq(project.id, "existing-0"));

    const ctx = createContext({ maxProjectsAllowedPerUser: 3 });

    await expect(create({ title: "New Project" }, ctx)).resolves.toMatchObject({
      title: "New Project",
    });
  });

  test("proceeds when owner is under the project limit", async () => {
    await seedOwnerProjects(2);

    const ctx = createContext({ maxProjectsAllowedPerUser: 3 });

    const result = await create({ title: "New Project" }, ctx);
    expect(result).toMatchObject({
      title: "New Project",
      userId: "owner-1",
      workspaceId: null,
      isDeleted: false,
    });
    // The project starts with a development build.
    expect(
      await db
        .select({ deployment: build.deployment })
        .from(build)
        .where(eq(build.projectId, result.id))
    ).toEqual([{ deployment: null }]);
  });
});
