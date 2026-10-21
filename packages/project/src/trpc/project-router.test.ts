import { describe, expect, test } from "vitest";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import {
  createCallerFactory,
  type AppContext,
} from "@webstudio-is/trpc-interface/index.server";
import { defaultPlanFeatures } from "@webstudio-is/plans";
import { projectRouter } from "./project-router";

const db = setupTestDb();
const createCaller = createCallerFactory(projectRouter);

const createContext = (
  overrides: Partial<Pick<AppContext, "authorization" | "planFeatures">> = {}
): AppContext =>
  ({
    db,
    authorization: { type: "user", userId: "member-1" },
    planFeatures: defaultPlanFeatures,
    getOwnerPlanFeatures: () =>
      Promise.resolve({
        ...defaultPlanFeatures,
        maxWorkspaces: 20,
        maxDailyPublishesPerUser: 100,
        seatsIncluded: 4,
      }),
    ...overrides,
  }) as unknown as AppContext;

/** `count` publishes made today to projects owned by `userId`. */
const seedPublishes = async (userId: string, count: number) => {
  const projectId = `published-by-${userId}`;
  await seed.project(db, { id: projectId, userId });
  for (let index = 0; index < count; index += 1) {
    await seed.build(db, {
      id: `${projectId}-${index}`,
      projectId,
      deployment: JSON.stringify({ domains: ["example.com"] }),
    });
  }
};

/** proj-1, owned by owner-1, in a workspace where member-1 is an editor. */
const seedSharedProject = async () => {
  const workspaceId = crypto.randomUUID();
  await seed.workspace(db, { id: workspaceId, userId: "owner-1" });
  await seed.project(db, { id: "proj-1", userId: "owner-1", workspaceId });
  await seed.workspaceMember(db, {
    workspaceId,
    userId: "member-1",
    relation: "editors",
  });
};

describe("userPublishCount", () => {
  test("counts publishes for the project owner when called by a workspace member", async () => {
    await seedSharedProject();
    await seedPublishes("owner-1", 3);
    await seedPublishes("member-1", 1);

    const caller = createCaller(createContext());
    const result = await caller.userPublishCount({ projectId: "proj-1" });

    expect(result).toEqual({ success: true, data: 3, limit: 500 });
  });

  test("counts publishes for the caller when projectId is omitted", async () => {
    await seedPublishes("member-1", 2);

    const caller = createCaller(createContext());
    const result = await caller.userPublishCount();

    expect(result).toEqual({ success: true, data: 2 });
  });

  test("counts zero for a caller who hasn't published today", async () => {
    const caller = createCaller(createContext());
    const result = await caller.userPublishCount();

    expect(result).toEqual({ success: true, data: 0 });
  });

  test("uses token owner when projectId is omitted for token auth", async () => {
    await seedPublishes("token-owner", 4);

    const caller = createCaller(
      createContext({
        authorization: {
          type: "token",
          authToken: "token-1",
          ownerId: "token-owner",
        },
      })
    );
    const result = await caller.userPublishCount();

    expect(result).toEqual({ success: true, data: 4 });
  });

  test("does not count publishes when caller cannot view the project", async () => {
    await seed.project(db, { id: "private", userId: "owner-1" });

    const caller = createCaller(createContext());
    const result = await caller.userPublishCount({ projectId: "private" });

    expect(result.success).toBe(false);
    if ("error" in result) {
      expect(result.error).toContain("Not authorized");
    }
  });
});
