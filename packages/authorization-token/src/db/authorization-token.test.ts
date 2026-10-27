import { describe, test, expect } from "vitest";
import { authorizationToken, eq, user } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { PlanRequiredError } from "@webstudio-is/trpc-interface/index.server";
import {
  findMany,
  getTokenInfo,
  getTokenProjectPermits,
  create,
  findOrCreateAgentToken,
  update,
  remove,
  __testing__,
} from "./authorization-token";
import { authorizationTokenRouter } from "../trpc/authorization-tokens-router";

const { applyTokenPermissions } = __testing__;

// ---------------------------------------------------------------------------
// applyTokenPermissions — pure logic tests
// Verifies the business rules that override stored DB values by relation.
// ---------------------------------------------------------------------------

const baseToken = {
  token: "tok-1",
  projectId: "proj-1",
  name: "test",
  createdAt: "2024-01-01T00:00:00.000Z",
  canClone: false,
  canCopy: false,
  canPublish: true,
  canUseApi: false,
};

describe("applyTokenPermissions", () => {
  test("viewers: canPublish forced to false, canClone/canCopy unchanged", () => {
    const result = applyTokenPermissions({ ...baseToken, relation: "viewers" });
    expect(result.canPublish).toBe(false);
    expect(result.canClone).toBe(false);
    expect(result.canCopy).toBe(false);
  });

  test("editors: canClone forced to false, canCopy forced to true, canPublish unchanged", () => {
    const result = applyTokenPermissions({
      ...baseToken,
      relation: "editors",
      canClone: true,
      canPublish: false,
    });
    expect(result.canClone).toBe(false);
    expect(result.canCopy).toBe(true);
    expect(result.canPublish).toBe(false);
  });

  test("builders: canClone/canCopy true, canPublish forced to false", () => {
    const result = applyTokenPermissions({
      ...baseToken,
      relation: "builders",
      canPublish: true,
    });
    expect(result.canClone).toBe(true);
    expect(result.canCopy).toBe(true);
    expect(result.canPublish).toBe(false);
  });

  test("administrators: canClone/canCopy true, canPublish forced to true", () => {
    const result = applyTokenPermissions({
      ...baseToken,
      relation: "administrators",
      canPublish: false,
    });
    expect(result.canClone).toBe(true);
    expect(result.canCopy).toBe(true);
    expect(result.canPublish).toBe(true);
  });

  test("preserves explicit API capability", () => {
    const result = applyTokenPermissions({
      ...baseToken,
      relation: "viewers",
      canUseApi: true,
    });
    expect(result.canUseApi).toBe(true);
  });
});

describe("getTokenProjectPermits", () => {
  test("maps token relation to project permits", () => {
    expect(getTokenProjectPermits({ relation: "viewers" })).toEqual(["view"]);
    expect(getTokenProjectPermits({ relation: "editors" })).toEqual([
      "view",
      "edit",
    ]);
    expect(getTokenProjectPermits({ relation: "builders" })).toEqual([
      "view",
      "edit",
      "build",
    ]);
    expect(getTokenProjectPermits({ relation: "administrators" })).toEqual([
      "view",
      "edit",
      "build",
      "admin",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Database integration tests
// ---------------------------------------------------------------------------

const db = setupTestDb();

const createContext = (allowAdditionalPermissions = true): AppContext =>
  ({
    db,
    authorization: { type: "user", userId: "user-1" },
    planFeatures: { allowAdditionalPermissions },
    getOwnerPlanFeatures: () => Promise.resolve({}),
  }) as unknown as AppContext;

const tokenRow = {
  token: "tok-abc",
  projectId: "proj-1",
  name: "My Token",
  relation: "builders" as "viewers" | "editors" | "builders" | "administrators",
  canClone: false,
  canCopy: false,
  canPublish: true,
  canUseApi: false,
  createdAt: "2024-01-01T00:00:00.000Z",
};

/** proj-1, owned by user-1 (so every permit check passes), optionally with a token. */
const seedProject = async (
  token?: Partial<typeof tokenRow> & { token: string }
) => {
  await seed.project(db, { id: "proj-1", userId: "user-1" });
  if (token !== undefined) {
    await seed.authorizationToken(db, { ...tokenRow, ...token });
  }
};

const readToken = async (token: string) =>
  await db
    .select()
    .from(authorizationToken)
    .where(eq(authorizationToken.token, token));

describe("getTokenInfo", () => {
  test("returns token with permissions applied for builders relation", async () => {
    await seedProject(tokenRow);

    const result = await getTokenInfo("tok-abc", createContext());
    // builders rule: canClone=true, canCopy=true, canPublish=false
    expect(result.canClone).toBe(true);
    expect(result.canCopy).toBe(true);
    expect(result.canPublish).toBe(false);
  });

  test("throws AuthorizationError when token not found", async () => {
    await expect(getTokenInfo("unknown", createContext())).rejects.toThrow(
      "Authorization token not found"
    );
  });
});

describe("findMany", () => {
  test("returns the project's tokens with permissions applied, ordered by createdAt", async () => {
    await seedProject({
      token: "tok-later",
      relation: "administrators",
      canPublish: false,
      createdAt: "2024-02-01T00:00:00.000Z",
    });
    await seed.authorizationToken(db, tokenRow);
    await seed.project(db, { id: "proj-2", userId: "user-1" });
    await seed.authorizationToken(db, {
      ...tokenRow,
      token: "tok-other-project",
      projectId: "proj-2",
    });

    const result = await findMany({ projectId: "proj-1" }, createContext());
    expect(result.map((token) => token.token)).toEqual([
      "tok-abc",
      "tok-later",
    ]);
    // administrators rule: canPublish=true
    expect(result[1].canPublish).toBe(true);
  });
});

describe("create", () => {
  test("inserts a new token and returns the rows", async () => {
    await seedProject();

    const result = await create(
      {
        projectId: "proj-1",
        relation: "viewers",
        name: "Viewer Token",
        canUseApi: true,
      },
      createContext()
    );
    expect(result).toHaveLength(1);
    expect(result[0].canUseApi).toBe(true);
    expect(await readToken(result[0].token)).toEqual([
      expect.objectContaining({
        projectId: "proj-1",
        relation: "viewers",
        name: "Viewer Token",
        canUseApi: true,
      }),
    ]);
  });

  test("rejects API capability when plan does not allow it", async () => {
    await seedProject();

    const promise = create(
      {
        projectId: "proj-1",
        relation: "viewers",
        name: "Viewer Token",
        canUseApi: true,
      },
      createContext(false)
    );
    await expect(promise).rejects.toThrow(PlanRequiredError);
    await expect(promise).rejects.toMatchObject({ code: "PLAN_REQUIRED" });
  });

  test("maps API capability plan errors to forbidden tRPC errors", async () => {
    await seedProject();

    const caller = authorizationTokenRouter.createCaller(createContext(false));

    await expect(
      caller.create({
        projectId: "proj-1",
        relation: "viewers",
        name: "Viewer Token",
        canUseApi: true,
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "API permission requires an upgrade.",
    });
  });
});

describe("update", () => {
  test("updates token relation and returns updated row", async () => {
    await seedProject(tokenRow);

    const result = await update(
      "proj-1",
      { token: "tok-abc", relation: "editors", canUseApi: true },
      createContext()
    );
    expect(result.relation).toBe("editors");
    expect(result.canUseApi).toBe(true);
    // Fields left out of the update keep their stored values.
    expect(result.name).toBe("My Token");
  });

  test("throws when the token doesn't exist", async () => {
    await seedProject();

    await expect(
      update(
        "proj-1",
        { token: "missing", relation: "editors" },
        createContext()
      )
    ).rejects.toThrow("Authorization token not found");
  });

  test("rejects API capability update when plan does not allow it", async () => {
    await seedProject(tokenRow);

    const promise = update(
      "proj-1",
      { token: "tok-abc", relation: "editors", canUseApi: true },
      createContext(false)
    );
    await expect(promise).rejects.toThrow(PlanRequiredError);
    await expect(promise).rejects.toMatchObject({ code: "PLAN_REQUIRED" });
  });

  test("maps API capability update plan errors to forbidden tRPC errors", async () => {
    await seedProject(tokenRow);

    const caller = authorizationTokenRouter.createCaller(createContext(false));

    await expect(
      caller.update({
        projectId: "proj-1",
        token: "tok-abc",
        name: "My Token",
        relation: "editors",
        canClone: false,
        canCopy: true,
        canPublish: false,
        canUseApi: true,
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "API permission requires an upgrade.",
    });
  });

  test("allows preserving existing API capability when plan no longer allows it", async () => {
    await seedProject({ ...tokenRow, canUseApi: true });

    const result = await update(
      "proj-1",
      {
        token: "tok-abc",
        name: "Renamed Token",
        relation: "builders",
        canUseApi: true,
      },
      createContext(false)
    );
    expect(result.name).toBe("Renamed Token");
    expect(result.canUseApi).toBe(true);
  });
});

describe("remove", () => {
  test("deletes token and returns deleted row", async () => {
    await seedProject(tokenRow);

    const result = await remove(
      { projectId: "proj-1", token: "tok-abc" },
      createContext()
    );
    expect(result.token).toBe("tok-abc");
    expect(await readToken("tok-abc")).toEqual([]);
  });
});

describe("findOrCreateAgentToken", () => {
  test("creates the user's API link once and reuses it", async () => {
    await seedProject();
    await db
      .update(user)
      .set({ email: "alex@example.com" })
      .where(eq(user.id, "user-1"));

    const first = await findOrCreateAgentToken(
      { projectId: "proj-1" },
      createContext()
    );
    const second = await findOrCreateAgentToken(
      { projectId: "proj-1" },
      createContext()
    );

    expect(second.token).toBe(first.token);
    expect(await readToken(first.token)).toEqual([
      expect.objectContaining({
        name: "AI agent (alex@example.com)",
        relation: "builders",
        canUseApi: true,
      }),
    ]);
  });

  test("is only for the project owner", async () => {
    await seedProject();
    await seed.user(db, { id: "user-2" });
    const context = {
      ...createContext(),
      authorization: { type: "user", userId: "user-2" },
    } as unknown as AppContext;

    await expect(
      findOrCreateAgentToken({ projectId: "proj-1" }, context)
    ).rejects.toThrow();
  });
});
