import { describe, test, expect } from "vitest";
import {
  and,
  eq,
  isNull,
  notification,
  project,
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

  test("never downgrades member workspaces (selfhost has no plans)", async () => {
    await seed.workspace(db, { id: WS2, userId: "owner-2" });
    await seed.workspaceMember(db, {
      workspaceId: WS2,
      userId: "user-1",
      relation: "editors",
    });

    const result = await findMany("user-1", createContext());
    const member = result.find((w) => w.id === WS2);
    expect(member?.role).toBe("editors");
    expect(member?.isDowngraded).toBe(false);
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
