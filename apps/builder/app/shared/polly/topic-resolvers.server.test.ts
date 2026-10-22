import { describe, test, expect } from "vitest";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { resolveTopics } from "./topic-resolvers.server";

const db = setupTestDb();

const createContext = (userId = "user-1"): AppContext =>
  ({
    db,
    authorization: { type: "user", userId },
  }) as unknown as AppContext;

const anonymousContext = {
  db,
  authorization: { type: "anonymous" },
} as unknown as AppContext;

/** A workspace owned by `ownerId` with `memberId` as an active member. */
const seedMembership = async (
  ownerId: string,
  memberId: string,
  name: string
) => {
  const workspaceId = crypto.randomUUID();
  await seed.workspace(db, { id: workspaceId, userId: ownerId, name });
  await seed.workspaceMember(db, { workspaceId, userId: memberId });
};

// ─── seatSuspended ─────────────────────────────────────────────

describe("notifications", () => {
  test("returns empty list for non-user authorization", async () => {
    const result = await resolveTopics(["notifications"], anonymousContext);
    expect(result.notifications).toEqual([]);
  });
});

describe("seatSuspended", () => {
  test("returns false for non-user authorization", async () => {
    const result = await resolveTopics(["seatSuspended"], anonymousContext);
    expect(result.seatSuspended).toBe(false);
  });

  test("returns false when user has no workspace memberships", async () => {
    const result = await resolveTopics(["seatSuspended"], createContext());
    expect(result.seatSuspended).toBe(false);
  });

  test("returns false when all memberships are user's own workspaces", async () => {
    await seedMembership("user-1", "user-1", "My Workspace");

    const result = await resolveTopics(
      ["seatSuspended"],
      createContext("user-1")
    );
    expect(result.seatSuspended).toBe(false);
  });

  test("returns false for members of someone else's workspace", async () => {
    // selfhost: no plans, so an owner's members are never suspended.
    await seedMembership("owner-1", "user-1", "Owner Workspace");

    const result = await resolveTopics(
      ["seatSuspended"],
      createContext("user-1")
    );
    expect(result.seatSuspended).toBe(false);
  });
});
