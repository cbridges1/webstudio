import { describe, test, expect } from "vitest";
import { eq, user, workspace } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { AuthorizationError } from "@webstudio-is/trpc-interface/index.server";
import {
  getUserById,
  createOrLoginWithDev,
  createOrLoginWithOAuth,
  updateUserProjectsTags,
} from "./user.server";

const db = setupTestDb();

const createContext = (overrides: Partial<AppContext> = {}): AppContext =>
  ({
    db,
    authorization: { type: "user", userId: "user-1" },
    ...overrides,
  }) as unknown as AppContext;

const userRow = {
  id: "user-1",
  email: "test@example.com",
  username: "tester",
  image: "",
  provider: "dev",
};

const defaultWorkspaces = async (userId: string) =>
  await db
    .select({ name: workspace.name, isDefault: workspace.isDefault })
    .from(workspace)
    .where(eq(workspace.userId, userId));

// ─── getUserById ───────────────────────────────────────────────

describe("getUserById", () => {
  test("returns user when found", async () => {
    await seed.user(db, userRow);

    const result = await getUserById(createContext(), "user-1");
    expect(result.id).toBe("user-1");
    expect(result.email).toBe("test@example.com");
    expect(result.projectsTags).toEqual([]);
  });

  test("throws when user not found", async () => {
    await expect(getUserById(createContext(), "missing")).rejects.toThrow(
      "User not found"
    );
  });
});

// ─── createOrLoginWithDev ──────────────────────────────────────

describe("createOrLoginWithDev", () => {
  test("returns existing user when found", async () => {
    await seed.user(db, userRow);
    await seed.workspace(db, {
      id: crypto.randomUUID(),
      userId: "user-1",
      isDefault: true,
    });

    const result = await createOrLoginWithDev(
      createContext(),
      "test@example.com"
    );
    expect(result.id).toBe("user-1");
    expect(await defaultWorkspaces("user-1")).toHaveLength(1);
  });

  test("lazily creates workspace when existing user has none", async () => {
    await seed.user(db, userRow);

    const result = await createOrLoginWithDev(
      createContext(),
      "test@example.com"
    );
    expect(result.id).toBe("user-1");
    expect(await defaultWorkspaces("user-1")).toEqual([
      { name: "My workspace", isDefault: true },
    ]);
  });

  test("creates new user and workspace when email not found", async () => {
    const result = await createOrLoginWithDev(
      createContext(),
      "new@example.com"
    );

    expect(result).toMatchObject({
      email: "new@example.com",
      username: "admin",
      provider: "dev",
    });
    expect(await defaultWorkspaces(result.id)).toEqual([
      { name: "My workspace", isDefault: true },
    ]);
  });
});

// ─── createOrLoginWithOAuth ───────────────────────────────────

describe("createOrLoginWithOAuth", () => {
  test("syncs changed profile fields for an existing user", async () => {
    await seed.user(db, userRow);

    const result = await createOrLoginWithOAuth(createContext(), {
      provider: "github",
      displayName: "new-github-username",
      emails: [{ value: "test@example.com" }],
      photos: [{ value: "https://avatars.example.com/new" }],
    } as Parameters<typeof createOrLoginWithOAuth>[1]);

    expect(result.username).toBe("new-github-username");
    expect(
      await db
        .select({
          username: user.username,
          image: user.image,
          provider: user.provider,
        })
        .from(user)
        .where(eq(user.id, "user-1"))
    ).toEqual([
      {
        username: "new-github-username",
        image: "https://avatars.example.com/new",
        provider: "github",
      },
    ]);
  });
});

// ─── updateUserProjectsTags ───────────────────────────────────

describe("updateUserProjectsTags", () => {
  const tags = [{ id: "tag-1", label: "Design" }];

  test("returns updated tags", async () => {
    await seed.user(db, userRow);

    const result = await updateUserProjectsTags({ tags }, createContext());
    expect(result).toEqual(tags);
  });

  test("throws AuthorizationError for non-user context", async () => {
    await expect(
      updateUserProjectsTags(
        { tags },
        createContext({ authorization: { type: "anonymous" } })
      )
    ).rejects.toThrow(AuthorizationError);
  });

  test("throws when the user doesn't exist", async () => {
    await expect(
      updateUserProjectsTags({ tags }, createContext())
    ).rejects.toThrow("User not found");
  });
});
