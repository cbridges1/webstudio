import { describe, test, expect } from "vitest";
import {
  and,
  eq,
  isNull,
  notification,
  product,
  project,
  transactionLog,
  workspace,
  workspaceMember,
} from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { AuthorizationError } from "@webstudio-is/trpc-interface/index.server";
import { defaultPlanFeatures } from "@webstudio-is/plans";
import {
  create,
  rename,
  remove,
  findMany,
  countAllMembers,
  addMember,
  updateRole,
  removeMember,
  moveProject,
  transferProject,
  findSharedWorkspacesByOwnerEmail,
} from "./workspace";

const db = setupTestDb();

const createContext = (userId = "user-1"): AppContext =>
  ({
    db,
    authorization: { type: "user", userId },
    getOwnerPlanFeatures: async () => defaultPlanFeatures,
  }) as unknown as AppContext;

const WS1 = "00000000-0000-4000-8000-000000000001";
const WS2 = "00000000-0000-4000-8000-000000000002";

/** WS1 ("My Workspace"), owned by user-1. */
const seedOwnWorkspace = async (
  overrides: { isDefault?: boolean; userId?: string } = {}
) =>
  await seed.workspace(db, {
    id: WS1,
    name: "My Workspace",
    userId: "user-1",
    ...overrides,
  });

const readWorkspace = async (id: string) =>
  (await db.select().from(workspace).where(eq(workspace.id, id)))[0];

const activeMembers = async (workspaceId: string) =>
  await db
    .select({
      userId: workspaceMember.userId,
      relation: workspaceMember.relation,
    })
    .from(workspaceMember)
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        isNull(workspaceMember.removedAt)
      )
    );

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("create", () => {
  test("throws for non-user auth (anonymous)", async () => {
    const ctx = {
      db,
      authorization: { type: "anonymous" },
    } as unknown as AppContext;
    await expect(
      create({ name: "Test", maxWorkspaces: 5 }, ctx)
    ).rejects.toThrow(AuthorizationError);
  });

  test("throws when workspace name is too short", async () => {
    await expect(
      create({ name: "x", maxWorkspaces: 5 }, createContext())
    ).rejects.toThrow("at least 2 characters");
  });

  test("throws when user is at the workspace limit", async () => {
    await seed.workspace(db, { id: WS1, userId: "user-1" });
    await seed.workspace(db, { id: WS2, userId: "user-1" });

    await expect(
      create({ name: "New WS", maxWorkspaces: 2 }, createContext())
    ).rejects.toThrow("maximum number of workspaces");
  });

  test("creates workspace when under limit", async () => {
    await seed.user(db, { id: "user-1" });
    await seed.workspace(db, { id: WS1, userId: "user-1" });

    const result = await create(
      { name: "  New WS  ", maxWorkspaces: 2 },
      createContext()
    );
    expect(result).toMatchObject({
      name: "New WS",
      userId: "user-1",
      isDefault: false,
    });
  });
});

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

describe("rename", () => {
  test("throws for name too short", async () => {
    await expect(
      rename({ workspaceId: WS1, name: "x" }, createContext())
    ).rejects.toThrow("at least 2 characters");
  });

  test("renames workspace and returns updated row", async () => {
    await seedOwnWorkspace();

    const result = await rename(
      { workspaceId: WS1, name: "Renamed" },
      createContext()
    );
    expect(result.name).toBe("Renamed");
  });

  test("doesn't rename another user's workspace", async () => {
    await seedOwnWorkspace({ userId: "other-user" });

    await expect(
      rename({ workspaceId: WS1, name: "Renamed" }, createContext())
    ).rejects.toThrow("Workspace not found");
    expect((await readWorkspace(WS1)).name).toBe("My Workspace");
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("remove", () => {
  test("throws when workspace has projects and deleteProjects is not set", async () => {
    await seedOwnWorkspace();
    await seed.project(db, {
      id: "proj-1",
      userId: "user-1",
      workspaceId: WS1,
    });

    await expect(remove({ workspaceId: WS1 }, createContext())).rejects.toThrow(
      "still contains projects"
    );
  });

  test("throws when caller is not the owner", async () => {
    await seedOwnWorkspace({ userId: "other-user" });

    await expect(
      remove({ workspaceId: WS1 }, createContext("user-1"))
    ).rejects.toThrow(AuthorizationError);
  });

  test("throws when trying to delete the default workspace", async () => {
    await seedOwnWorkspace({ isDefault: true });

    await expect(remove({ workspaceId: WS1 }, createContext())).rejects.toThrow(
      "default workspace cannot be deleted"
    );
  });

  test("soft-deletes workspace when empty", async () => {
    await seedOwnWorkspace();

    await remove({ workspaceId: WS1 }, createContext());
    expect((await readWorkspace(WS1)).isDeleted).toBe(true);
  });

  test("soft-deletes its projects too when deleteProjects is set", async () => {
    await seedOwnWorkspace();
    await seed.project(db, {
      id: "proj-1",
      userId: "user-1",
      workspaceId: WS1,
    });

    await remove({ workspaceId: WS1, deleteProjects: true }, createContext());
    expect((await readWorkspace(WS1)).isDeleted).toBe(true);
    expect(
      await db
        .select({ isDeleted: project.isDeleted })
        .from(project)
        .where(eq(project.id, "proj-1"))
    ).toEqual([{ isDeleted: true }]);
  });
});

// ---------------------------------------------------------------------------
// findMany
// ---------------------------------------------------------------------------

describe("findMany", () => {
  test("returns owned workspaces with role=own", async () => {
    await seedOwnWorkspace();

    const result = await findMany("user-1", createContext());
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("own");
    expect(result[0].isDowngraded).toBe(false);
  });

  test("lists the default workspace first", async () => {
    await seed.workspace(db, {
      id: WS1,
      userId: "user-1",
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    await seed.workspace(db, {
      id: WS2,
      userId: "user-1",
      isDefault: true,
      createdAt: "2024-02-01T00:00:00.000Z",
    });

    const result = await findMany("user-1", createContext());
    expect(result.map((w) => w.id)).toEqual([WS2, WS1]);
  });

  test("returns member workspaces with isDowngraded=true when owner plan maxWorkspaces<=1", async () => {
    await seed.workspace(db, { id: WS2, userId: "owner-2" });
    await seed.workspaceMember(db, {
      workspaceId: WS2,
      userId: "user-1",
      relation: "editors",
    });

    const ctx = createContext();
    ctx.getOwnerPlanFeatures = async () => ({
      ...defaultPlanFeatures,
      maxWorkspaces: 1,
    });

    const result = await findMany("user-1", ctx);
    const member = result.find((w) => w.id === WS2);
    expect(member?.role).toBe("editors");
    expect(member?.isDowngraded).toBe(true);
  });

  // The viewer (user-1) owns nothing and is a member of WS2 owned by owner-2.
  // user-1 is the first of the workspace's members.
  const setupDowngradeScenario = async (opts: {
    /** Number of members, user-1 included; given as their ids */
    members: string[];
    /** Pending invites owner-2 has sent */
    pendingInvites: number;
    /** Extra seats owner-2 bought, or null for no subscription event */
    transactionLog: { quantity: number } | null;
  }) => {
    await seed.workspace(db, { id: WS2, userId: "owner-2" });
    const memberIds = ["user-1", ...opts.members.slice(1)];
    for (const userId of memberIds) {
      await seed.workspaceMember(db, {
        workspaceId: WS2,
        userId,
        relation: "editors",
      });
    }
    for (let index = 0; index < opts.pendingInvites; index += 1) {
      await seed.user(db, { id: `invitee-${index}` });
      await db.insert(notification).values({
        type: "workspaceInvite",
        recipientId: `invitee-${index}`,
        senderId: "owner-2",
        payload: { workspaceId: WS2, relation: "editors" },
      });
    }
    await db
      .insert(product)
      .values({ id: "prod-seats", name: "Seats", meta: {} });
    if (opts.transactionLog !== null) {
      await db.insert(transactionLog).values({
        eventId: "evt-seats",
        userId: "owner-2",
        productId: "prod-seats",
        eventData: {
          type: "customer.subscription.updated",
          created: 1000,
          data: {
            object: {
              object: "subscription",
              id: "sub-seats",
              items: { data: [{ quantity: opts.transactionLog.quantity }] },
            },
          },
        },
      });
    }
  };

  // ---- extraSeats from subscription (quantity present) ----

  test("downgraded when members > seatsIncluded + extraSeats (with subscription)", async () => {
    // 3 members + 1 pending = 4 total, seatsIncluded=1, quantity=1 → paidSeats=2 < 4
    await setupDowngradeScenario({
      members: ["m-1", "m-2", "m-3"],
      pendingInvites: 1,
      transactionLog: {
        quantity: 1,
      },
    });
    const ctx = createContext();
    ctx.getOwnerPlanFeatures = async () => ({
      ...defaultPlanFeatures,
      maxWorkspaces: 5,
      seatsIncluded: 1,
    });
    const result = await findMany("user-1", ctx);
    expect(result.find((w) => w.id === WS2)?.isDowngraded).toBe(true);
  });

  test("not downgraded when members === seatsIncluded + extraSeats (boundary with subscription)", async () => {
    // 3 members, seatsIncluded=2, quantity=1 → paidSeats=3, 3 === 3
    await setupDowngradeScenario({
      members: ["m-1", "m-2", "m-3"],
      pendingInvites: 0,
      transactionLog: {
        quantity: 1,
      },
    });
    const ctx = createContext();
    ctx.getOwnerPlanFeatures = async () => ({
      ...defaultPlanFeatures,
      maxWorkspaces: 5,
      seatsIncluded: 2,
    });
    const result = await findMany("user-1", ctx);
    expect(result.find((w) => w.id === WS2)?.isDowngraded).toBe(false);
  });

  test("not downgraded when members < seatsIncluded + extraSeats (well under with subscription)", async () => {
    // 1 member, seatsIncluded=2, quantity=2 → paidSeats=4, 1 < 4
    await setupDowngradeScenario({
      members: ["m-1"],
      pendingInvites: 0,
      transactionLog: {
        quantity: 2,
      },
    });
    const ctx = createContext();
    ctx.getOwnerPlanFeatures = async () => ({
      ...defaultPlanFeatures,
      maxWorkspaces: 5,
      seatsIncluded: 2,
    });
    const result = await findMany("user-1", ctx);
    expect(result.find((w) => w.id === WS2)?.isDowngraded).toBe(false);
  });

  test("not downgraded when extra seats save you from exceeding seatsIncluded", async () => {
    // 3 members, seatsIncluded=2, quantity=2 → paidSeats=4, 3 < 4
    await setupDowngradeScenario({
      members: ["m-1", "m-2", "m-3"],
      pendingInvites: 0,
      transactionLog: {
        quantity: 2,
      },
    });
    const ctx = createContext();
    ctx.getOwnerPlanFeatures = async () => ({
      ...defaultPlanFeatures,
      maxWorkspaces: 5,
      seatsIncluded: 2,
    });
    const result = await findMany("user-1", ctx);
    expect(result.find((w) => w.id === WS2)?.isDowngraded).toBe(false);
  });

  // ---- extraSeats = null (no subscription event in TransactionLog) ----

  test("not downgraded when members < seatsIncluded and extraSeats is null", async () => {
    // 1 member, seatsIncluded=2, no subscription event → paidSeats=2, 1 < 2
    await setupDowngradeScenario({
      members: ["m-1"],
      pendingInvites: 0,
      transactionLog: null,
    });
    const ctx = createContext();
    ctx.getOwnerPlanFeatures = async () => ({
      ...defaultPlanFeatures,
      maxWorkspaces: 5,
      seatsIncluded: 2,
    });
    const result = await findMany("user-1", ctx);
    expect(result.find((w) => w.id === WS2)?.isDowngraded).toBe(false);
  });

  test("not downgraded when members === seatsIncluded and extraSeats is null", async () => {
    // 2 members, seatsIncluded=2, no subscription event → paidSeats=2, 2 === 2
    await setupDowngradeScenario({
      members: ["m-1", "m-2"],
      pendingInvites: 0,
      transactionLog: null,
    });
    const ctx = createContext();
    ctx.getOwnerPlanFeatures = async () => ({
      ...defaultPlanFeatures,
      maxWorkspaces: 5,
      seatsIncluded: 2,
    });
    const result = await findMany("user-1", ctx);
    expect(result.find((w) => w.id === WS2)?.isDowngraded).toBe(false);
  });

  test("downgraded when members > seatsIncluded and extraSeats is null", async () => {
    // 3 members, seatsIncluded=2, no subscription event → paidSeats=2, 3 > 2
    await setupDowngradeScenario({
      members: ["m-1", "m-2", "m-3"],
      pendingInvites: 0,
      transactionLog: null,
    });
    const ctx = createContext();
    ctx.getOwnerPlanFeatures = async () => ({
      ...defaultPlanFeatures,
      maxWorkspaces: 5,
      seatsIncluded: 2,
    });
    const result = await findMany("user-1", ctx);
    expect(result.find((w) => w.id === WS2)?.isDowngraded).toBe(true);
  });

  // ---- pending invites count toward members ----

  test("downgraded when members + pending > paidSeats", async () => {
    // 2 members + 1 pending = 3 total, seatsIncluded=2, no extra seats → 3 > 2
    await setupDowngradeScenario({
      members: ["m-1", "m-2"],
      pendingInvites: 1,
      transactionLog: null,
    });
    const ctx = createContext();
    ctx.getOwnerPlanFeatures = async () => ({
      ...defaultPlanFeatures,
      maxWorkspaces: 5,
      seatsIncluded: 2,
    });
    const result = await findMany("user-1", ctx);
    expect(result.find((w) => w.id === WS2)?.isDowngraded).toBe(true);
  });

  test("not downgraded when members + pending === paidSeats", async () => {
    // 1 member + 1 pending = 2 total, seatsIncluded=2, no extra seats → 2 === 2
    await setupDowngradeScenario({
      members: ["m-1"],
      pendingInvites: 1,
      transactionLog: null,
    });
    const ctx = createContext();
    ctx.getOwnerPlanFeatures = async () => ({
      ...defaultPlanFeatures,
      maxWorkspaces: 5,
      seatsIncluded: 2,
    });
    const result = await findMany("user-1", ctx);
    expect(result.find((w) => w.id === WS2)?.isDowngraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// countAllMembers
// ---------------------------------------------------------------------------

describe("countAllMembers", () => {
  test("returns 0 when user has no workspaces", async () => {
    const count = await countAllMembers("user-1", createContext());
    expect(count).toBe(0);
  });

  test("returns sum of active members + pending invites", async () => {
    await seedOwnWorkspace();
    for (const userId of ["m1", "m2", "m3"]) {
      await seed.workspaceMember(db, { workspaceId: WS1, userId });
    }
    // Removed members don't count.
    await seed.workspaceMember(db, {
      workspaceId: WS1,
      userId: "m4",
      removedAt: new Date().toISOString(),
    });
    for (const recipientId of ["i1", "i2"]) {
      await seed.user(db, { id: recipientId });
      await db.insert(notification).values({
        type: "workspaceInvite",
        recipientId,
        senderId: "user-1",
        payload: { workspaceId: WS1, relation: "editors" },
      });
    }

    const count = await countAllMembers("user-1", createContext());
    expect(count).toBe(5);
  });

  test("deduplicates same member across multiple workspaces", async () => {
    // "user-a" is in two workspaces — should count as 1, not 2.
    await seed.workspace(db, { id: WS1, userId: "user-1" });
    await seed.workspace(db, { id: WS2, userId: "user-1" });
    await seed.workspaceMember(db, { workspaceId: WS1, userId: "user-a" });
    await seed.workspaceMember(db, { workspaceId: WS2, userId: "user-a" });

    const count = await countAllMembers("user-1", createContext());
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// addMember
// ---------------------------------------------------------------------------

describe("addMember", () => {
  test("throws when invited email does not exist", async () => {
    await seedOwnWorkspace();

    await expect(
      addMember(
        { workspaceId: WS1, email: "unknown@test.com", relation: "editors" },
        createContext()
      )
    ).rejects.toThrow("No Webstudio account found");
  });

  test("throws when inviting yourself", async () => {
    await seed.user(db, { id: "user-1", email: "me@test.com" });
    await seedOwnWorkspace();

    await expect(
      addMember(
        { workspaceId: WS1, email: "me@test.com", relation: "editors" },
        createContext()
      )
    ).rejects.toThrow("already the owner");
  });

  test("throws when invitee is already a member", async () => {
    await seedOwnWorkspace();
    await seed.user(db, { id: "user-2", email: "other@test.com" });
    await seed.workspaceMember(db, { workspaceId: WS1, userId: "user-2" });

    await expect(
      addMember(
        { workspaceId: WS1, email: "other@test.com", relation: "editors" },
        createContext()
      )
    ).rejects.toThrow("Already a member");
  });

  test("creates an invite notification", async () => {
    await seedOwnWorkspace();
    await seed.user(db, { id: "user-2", email: "other@test.com" });

    const { notificationId } = await addMember(
      { workspaceId: WS1, email: "other@test.com", relation: "editors" },
      createContext()
    );
    // Inviting again returns the pending invite.
    await expect(
      addMember(
        { workspaceId: WS1, email: "other@test.com", relation: "editors" },
        createContext()
      )
    ).resolves.toEqual({ notificationId });
    expect(await db.select().from(notification)).toEqual([
      expect.objectContaining({
        id: notificationId,
        type: "workspaceInvite",
        recipientId: "user-2",
        senderId: "user-1",
        status: "pending",
        payload: { workspaceId: WS1, relation: "editors" },
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// updateRole
// ---------------------------------------------------------------------------

describe("updateRole", () => {
  test("throws when trying to change own role", async () => {
    await seedOwnWorkspace();
    await expect(
      updateRole(
        { workspaceId: WS1, memberUserId: "user-1", relation: "editors" },
        createContext()
      )
    ).rejects.toThrow("Cannot change the workspace owner's role");
  });

  test("throws when member not found", async () => {
    await seedOwnWorkspace();

    await expect(
      updateRole(
        { workspaceId: WS1, memberUserId: "user-2", relation: "editors" },
        createContext()
      )
    ).rejects.toThrow("Member not found");
  });

  test("updates member role successfully", async () => {
    await seedOwnWorkspace();
    await seed.workspaceMember(db, {
      workspaceId: WS1,
      userId: "user-2",
      relation: "viewers",
    });

    await updateRole(
      { workspaceId: WS1, memberUserId: "user-2", relation: "editors" },
      createContext()
    );
    expect(await activeMembers(WS1)).toEqual([
      { userId: "user-2", relation: "editors" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// removeMember
// ---------------------------------------------------------------------------

describe("removeMember", () => {
  test("throws when owner tries to remove themselves", async () => {
    await seedOwnWorkspace();

    await expect(
      removeMember(
        { workspaceId: WS1, memberUserId: "user-1" },
        createContext()
      )
    ).rejects.toThrow("owner cannot be removed");
  });

  test("throws when member not found", async () => {
    await seedOwnWorkspace();

    await expect(
      removeMember(
        { workspaceId: WS1, memberUserId: "user-2" },
        createContext()
      )
    ).rejects.toThrow("Member not found");
  });

  test("removes member successfully", async () => {
    await seedOwnWorkspace();
    await seed.workspaceMember(db, { workspaceId: WS1, userId: "user-2" });

    await removeMember(
      { workspaceId: WS1, memberUserId: "user-2" },
      createContext()
    );
    expect(await activeMembers(WS1)).toEqual([]);
  });

  test("a member can leave", async () => {
    await seedOwnWorkspace();
    await seed.workspaceMember(db, { workspaceId: WS1, userId: "user-2" });

    await removeMember(
      { workspaceId: WS1, memberUserId: "user-2" },
      createContext("user-2")
    );
    expect(await activeMembers(WS1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// moveProject
// ---------------------------------------------------------------------------

describe("moveProject", () => {
  test("throws when project not found", async () => {
    await expect(
      moveProject(
        { projectId: "proj-1", targetWorkspaceId: WS2 },
        createContext()
      )
    ).rejects.toThrow("Project not found");
  });

  test("throws when cross-owner move attempted", async () => {
    await seed.project(db, { id: "proj-1", userId: "user-1" });
    await seed.workspace(db, { id: WS2, userId: "user-2" });
    await seed.workspaceMember(db, {
      workspaceId: WS2,
      userId: "user-1",
      relation: "administrators",
    });

    await expect(
      moveProject(
        { projectId: "proj-1", targetWorkspaceId: WS2 },
        createContext()
      )
    ).rejects.toThrow(AuthorizationError);
  });

  test("moves a project between the owner's workspaces", async () => {
    await seedOwnWorkspace();
    await seed.workspace(db, { id: WS2, userId: "user-1" });
    await seed.project(db, {
      id: "proj-1",
      userId: "user-1",
      workspaceId: WS1,
    });

    await moveProject(
      { projectId: "proj-1", targetWorkspaceId: WS2 },
      createContext()
    );
    expect(
      await db
        .select({ workspaceId: project.workspaceId })
        .from(project)
        .where(eq(project.id, "proj-1"))
    ).toEqual([{ workspaceId: WS2 }]);
  });
});

// ---------------------------------------------------------------------------
// transferProject
// ---------------------------------------------------------------------------

describe("transferProject", () => {
  test("silently succeeds when recipient email not found", async () => {
    await seed.project(db, { id: "proj-1", userId: "user-1" });

    await transferProject(
      { projectId: "proj-1", recipientEmail: "ghost@test.com" },
      createContext()
    );
    expect(await db.select().from(notification)).toEqual([]);
  });

  test("throws when transferring to yourself", async () => {
    await seed.user(db, { id: "user-1", email: "me@test.com" });
    await seed.project(db, { id: "proj-1", userId: "user-1" });

    await expect(
      transferProject(
        { projectId: "proj-1", recipientEmail: "me@test.com" },
        createContext()
      )
    ).rejects.toThrow("cannot transfer a project to yourself");
  });

  test("creates a transfer notification", async () => {
    await seed.project(db, { id: "proj-1", userId: "user-1" });
    await seed.user(db, { id: "user-2", email: "other@test.com" });

    await transferProject(
      { projectId: "proj-1", recipientEmail: "other@test.com" },
      createContext()
    );
    expect(await db.select().from(notification)).toEqual([
      expect.objectContaining({
        type: "projectTransfer",
        recipientId: "user-2",
        senderId: "user-1",
        payload: { projectId: "proj-1" },
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// findSharedWorkspacesByOwnerEmail
// ---------------------------------------------------------------------------

describe("findSharedWorkspacesByOwnerEmail", () => {
  test("returns empty array when target user not found", async () => {
    const result = await findSharedWorkspacesByOwnerEmail(
      { email: "ghost@test.com" },
      createContext()
    );
    expect(result).toEqual([]);
  });

  test("returns workspaces where caller is a member", async () => {
    await seed.user(db, { id: "user-2", email: "other@test.com" });
    await seed.workspace(db, { id: WS1, name: "Shared WS", userId: "user-2" });
    await seed.workspace(db, { id: WS2, name: "Other WS", userId: "user-2" });
    await seed.workspaceMember(db, { workspaceId: WS1, userId: "user-1" });

    const result = await findSharedWorkspacesByOwnerEmail(
      { email: "other@test.com" },
      createContext()
    );
    expect(result).toEqual([{ id: WS1, name: "Shared WS" }]);
  });

  test("returns empty when caller is not a member of any target workspace", async () => {
    await seed.user(db, { id: "user-2", email: "other@test.com" });
    await seed.workspace(db, { id: WS2, name: "Other WS", userId: "user-2" });

    const result = await findSharedWorkspacesByOwnerEmail(
      { email: "other@test.com" },
      createContext()
    );
    expect(result).toEqual([]);
  });
});
