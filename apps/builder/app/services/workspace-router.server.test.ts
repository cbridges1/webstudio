import { describe, test, expect } from "vitest";
import { notification } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import { createCallerFactory } from "@webstudio-is/trpc-interface/index.server";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { defaultPlanFeatures } from "@webstudio-is/plans";
import { workspaceRouter } from "./workspace-router.server";

const db = setupTestDb();

const WS1 = "00000000-0000-4000-8000-000000000001";

const createCaller = createCallerFactory(workspaceRouter);

const createContext = (userId = "owner-1"): AppContext =>
  ({
    db,
    authorization: { type: "user", userId },
    planFeatures: defaultPlanFeatures,
    purchases: [],
    trpcCache: { setMaxAge: () => {} },
    getOwnerPlanFeatures: async () => defaultPlanFeatures,
  }) as unknown as AppContext;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** WS1, owned by owner-1. */
const seedWorkspace = async () => {
  await seed.workspace(db, { id: WS1, userId: "owner-1" });
};

/**
 * WS1 with `memberCount` members and `pendingInviteCount` pending invites, and
 * an invitee account (invitee@test.com).
 */
const setupAddMember = async (
  opts: { workspaceMemberCount?: number; pendingInviteCount?: number } = {}
) => {
  const { workspaceMemberCount = 1, pendingInviteCount = 0 } = opts;
  await seedWorkspace();
  await seed.user(db, { id: "user-2", email: "invitee@test.com" });
  for (let index = 0; index < workspaceMemberCount; index += 1) {
    await seed.workspaceMember(db, {
      workspaceId: WS1,
      userId: `member-${index}`,
    });
  }
  for (let index = 0; index < pendingInviteCount; index += 1) {
    await seed.user(db, { id: `pending-${index}` });
    await db.insert(notification).values({
      type: "workspaceInvite",
      recipientId: `pending-${index}`,
      senderId: "owner-1",
      payload: { workspaceId: WS1, relation: "editors" },
    });
  }
};

// ---------------------------------------------------------------------------
// addMember
// ---------------------------------------------------------------------------

describe("addMember", () => {
  test("rejects non-owners", async () => {
    await seedWorkspace();

    const result = await createCaller(createContext("member-1")).addMember({
      workspaceId: WS1,
      email: "invitee@test.com",
      relation: "editors",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Only the workspace owner");
    }
  });

  test("invites without a plan, payment provider or seat limit", async () => {
    await setupAddMember({ workspaceMemberCount: 25, pendingInviteCount: 5 });

    const result = await createCaller(createContext()).addMember({
      workspaceId: WS1,
      email: "invitee@test.com",
      relation: "editors",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        await db.select().from(notification).orderBy(notification.createdAt)
      ).toContainEqual(
        expect.objectContaining({
          id: result.notificationId,
          type: "workspaceInvite",
          recipientId: "user-2",
          payload: { workspaceId: WS1, relation: "editors" },
        })
      );
    }
  });

  test("rejects an invitee without an account", async () => {
    await seedWorkspace();

    const result = await createCaller(createContext()).addMember({
      workspaceId: WS1,
      email: "nobody@test.com",
      relation: "editors",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("No Webstudio account found");
    }
  });
});

// ---------------------------------------------------------------------------
// listMembers
// ---------------------------------------------------------------------------

describe("listMembers", () => {
  test("returns owner, members, and pendingInvites", async () => {
    await seed.user(db, {
      id: "owner-1",
      email: "owner@test.com",
      username: "owner",
    });
    await seedWorkspace();
    for (let index = 1; index <= 2; index += 1) {
      await seed.user(db, {
        id: `m-${index}`,
        email: `m-${index}@test.com`,
        username: `m-${index}`,
      });
      await seed.workspaceMember(db, {
        workspaceId: WS1,
        userId: `m-${index}`,
        relation: "editors",
      });
    }

    const result = await createCaller(createContext()).listMembers({
      workspaceId: WS1,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.owner.userId).toBe("owner-1");
      expect(result.data.members).toHaveLength(2);
      expect(result.data.pendingInvites).toHaveLength(0);
    }
  });
});
