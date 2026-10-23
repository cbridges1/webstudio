import { describe, test, expect } from "vitest";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "../context/context.server";
import { defaultPlanFeatures } from "@webstudio-is/plans";
import {
  checkProjectPermit,
  hasProjectPermit,
  getProjectPermit,
  __testing__,
} from "./project.server";

const { isRolePermitted } = __testing__;

describe("isRolePermitted", () => {
  describe("workspace owner (own relation)", () => {
    test("own relation grants view permit", () => {
      expect(isRolePermitted(["own"], "view")).toBe(true);
    });

    test("own relation grants edit permit", () => {
      expect(isRolePermitted(["own"], "edit")).toBe(true);
    });

    test("own relation grants build permit", () => {
      expect(isRolePermitted(["own"], "build")).toBe(true);
    });

    test("own relation grants admin permit", () => {
      expect(isRolePermitted(["own"], "admin")).toBe(true);
    });

    test("own relation grants own permit", () => {
      expect(isRolePermitted(["own"], "own")).toBe(true);
    });
  });

  describe("administrators", () => {
    test("grants view permit", () => {
      expect(isRolePermitted(["administrators"], "view")).toBe(true);
    });

    test("grants edit permit", () => {
      expect(isRolePermitted(["administrators"], "edit")).toBe(true);
    });

    test("grants build permit", () => {
      expect(isRolePermitted(["administrators"], "build")).toBe(true);
    });

    test("grants admin permit", () => {
      expect(isRolePermitted(["administrators"], "admin")).toBe(true);
    });

    test("denies own permit", () => {
      expect(isRolePermitted(["administrators"], "own")).toBe(false);
    });
  });

  describe("builders", () => {
    test("grants view permit", () => {
      expect(isRolePermitted(["builders"], "view")).toBe(true);
    });

    test("grants edit permit", () => {
      expect(isRolePermitted(["builders"], "edit")).toBe(true);
    });

    test("grants build permit", () => {
      expect(isRolePermitted(["builders"], "build")).toBe(true);
    });

    test("denies admin permit", () => {
      expect(isRolePermitted(["builders"], "admin")).toBe(false);
    });

    test("denies own permit", () => {
      expect(isRolePermitted(["builders"], "own")).toBe(false);
    });
  });

  describe("editors", () => {
    test("grants view permit", () => {
      expect(isRolePermitted(["editors"], "view")).toBe(true);
    });

    test("grants edit permit", () => {
      expect(isRolePermitted(["editors"], "edit")).toBe(true);
    });

    test("denies build permit", () => {
      expect(isRolePermitted(["editors"], "build")).toBe(false);
    });

    test("denies admin permit", () => {
      expect(isRolePermitted(["editors"], "admin")).toBe(false);
    });

    test("denies own permit", () => {
      expect(isRolePermitted(["editors"], "own")).toBe(false);
    });
  });

  describe("viewers", () => {
    test("grants view permit", () => {
      expect(isRolePermitted(["viewers"], "view")).toBe(true);
    });

    test("denies edit permit", () => {
      expect(isRolePermitted(["viewers"], "edit")).toBe(false);
    });

    test("denies build permit", () => {
      expect(isRolePermitted(["viewers"], "build")).toBe(false);
    });

    test("denies admin permit", () => {
      expect(isRolePermitted(["viewers"], "admin")).toBe(false);
    });

    test("denies own permit", () => {
      expect(isRolePermitted(["viewers"], "own")).toBe(false);
    });
  });

  describe("multiple relations", () => {
    test("uses highest privilege from multiple relations", () => {
      // User has both viewer and builder relations
      expect(isRolePermitted(["viewers", "builders"], "build")).toBe(true);
    });

    test("own in any position grants all", () => {
      expect(isRolePermitted(["viewers", "own"], "own")).toBe(true);
    });
  });

  describe("empty relations", () => {
    test("empty relations deny all permits", () => {
      expect(isRolePermitted([], "view")).toBe(false);
      expect(isRolePermitted([], "edit")).toBe(false);
      expect(isRolePermitted([], "build")).toBe(false);
      expect(isRolePermitted([], "admin")).toBe(false);
      expect(isRolePermitted([], "own")).toBe(false);
    });
  });

  describe("unknown relation strings", () => {
    test("unknown relation denies permit", () => {
      expect(isRolePermitted(["unknown"], "view")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Database integration tests
// ---------------------------------------------------------------------------

const db = setupTestDb();

// Each test uses a unique projectId so the memoized `check()` doesn't
// return a cached result from a previous test.
const uid = () => `proj-${Math.random().toString(36).slice(2)}`;

const makeUserCtx = (userId = "user-1", maxWorkspaces = 5): AppContext =>
  ({
    db,
    authorization: { type: "user", userId },
    getOwnerPlanFeatures: async () => ({
      ...defaultPlanFeatures,
      maxWorkspaces,
    }),
  }) as unknown as AppContext;

/** A project owned by `owner-1` in workspace `ws-<projectId>`. */
const seedWorkspaceProject = async (projectId: string) => {
  const workspaceId = crypto.randomUUID();
  await seed.workspace(db, { id: workspaceId, userId: "owner-1" });
  await seed.project(db, { id: projectId, userId: "owner-1", workspaceId });
  return workspaceId;
};

const seedMember = async (
  projectId: string,
  userId: string,
  relation: "viewers" | "editors" | "builders" | "administrators"
) => {
  const workspaceId = await seedWorkspaceProject(projectId);
  await seed.workspaceMember(db, { workspaceId, userId, relation });
};

// ---------------------------------------------------------------------------
// checkProjectPermit — user auth
// ---------------------------------------------------------------------------

describe("checkProjectPermit — user direct owner", () => {
  test("allows edit when user directly owns the project", async () => {
    const projectId = uid();
    await seed.project(db, { id: projectId, userId: "user-1" });
    const allowed = await checkProjectPermit({
      projectId,
      permit: "edit",
      authInfo: { type: "user", userId: "user-1" },
      db,
    });
    expect(allowed).toBe(true);
  });

  test("allows via workspace member relation", async () => {
    const projectId = uid();
    await seedMember(projectId, "user-2", "builders");
    const allowed = await checkProjectPermit({
      projectId,
      permit: "build",
      authInfo: { type: "user", userId: "user-2" },
      db,
    });
    expect(allowed).toBe(true);
  });

  test("denies when user has insufficient workspace relation", async () => {
    const projectId = uid();
    await seedMember(projectId, "user-3", "viewers");
    const allowed = await checkProjectPermit({
      projectId,
      permit: "edit",
      authInfo: { type: "user", userId: "user-3" },
      db,
    });
    expect(allowed).toBe(false);
  });

  test("denies a removed workspace member", async () => {
    const projectId = uid();
    const workspaceId = await seedWorkspaceProject(projectId);
    await seed.workspaceMember(db, {
      workspaceId,
      userId: "user-5",
      relation: "administrators",
      removedAt: new Date().toISOString(),
    });
    const allowed = await checkProjectPermit({
      projectId,
      permit: "view",
      authInfo: { type: "user", userId: "user-5" },
      db,
    });
    expect(allowed).toBe(false);
  });

  test("denies when user has no access at all", async () => {
    const projectId = uid();
    await seedWorkspaceProject(projectId);
    const allowed = await checkProjectPermit({
      projectId,
      permit: "view",
      authInfo: { type: "user", userId: "user-4" },
      db,
    });
    expect(allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Legacy template allowlist no longer bypasses auth
// ---------------------------------------------------------------------------

// One of the project IDs that used to be hardcoded in the allowlist.
const legacyTemplateId = "5e086cf4-4293-471c-8eab-ddca8b5cd4db";

describe("checkProjectPermit — template projects no longer bypass auth", () => {
  test("denies view without a real owner, workspace, or token relation", async () => {
    await seed.project(db, { id: legacyTemplateId, userId: "owner-1" });
    const allowed = await checkProjectPermit({
      projectId: legacyTemplateId,
      permit: "view",
      authInfo: { type: "user", userId: "unrelated-user" },
      db,
    });
    expect(allowed).toBe(false);
  });

  test("denies edit for an unrelated user on a template project", async () => {
    await seed.project(db, { id: legacyTemplateId, userId: "owner-1" });
    const allowed = await checkProjectPermit({
      projectId: legacyTemplateId,
      permit: "edit",
      authInfo: { type: "user", userId: "unrelated-user-2" },
      db,
    });
    expect(allowed).toBe(false);
  });

  test("allows view when a real token grants it", async () => {
    await seed.project(db, { id: legacyTemplateId, userId: "owner-1" });
    await seed.authorizationToken(db, {
      token: "template-tok",
      projectId: legacyTemplateId,
      relation: "viewers",
    });
    const allowed = await checkProjectPermit({
      projectId: legacyTemplateId,
      permit: "view",
      authInfo: { type: "token", authToken: "template-tok" },
      db,
    });
    expect(allowed).toBe(true);
  });

  test("denies view when the token does not exist", async () => {
    const allowed = await checkProjectPermit({
      projectId: legacyTemplateId,
      permit: "view",
      authInfo: { type: "token", authToken: "missing-tok" },
      db,
    });
    expect(allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkProjectPermit — token auth
// ---------------------------------------------------------------------------

describe("checkProjectPermit — token auth", () => {
  test("allows when token exists with matching relation", async () => {
    const projectId = uid();
    await seed.project(db, { id: projectId, userId: "owner-1" });
    await seed.authorizationToken(db, { token: "tok-1", projectId });
    const allowed = await checkProjectPermit({
      projectId,
      permit: "view",
      authInfo: { type: "token", authToken: "tok-1" },
      db,
    });
    expect(allowed).toBe(true);
  });

  test("denies when the token's relation doesn't grant the permit", async () => {
    const projectId = uid();
    await seed.project(db, { id: projectId, userId: "owner-1" });
    await seed.authorizationToken(db, {
      token: "tok-viewer",
      projectId,
      relation: "viewers",
    });
    const allowed = await checkProjectPermit({
      projectId,
      permit: "edit",
      authInfo: { type: "token", authToken: "tok-viewer" },
      db,
    });
    expect(allowed).toBe(false);
  });

  test("denies when token not found", async () => {
    const projectId = uid();
    const allowed = await checkProjectPermit({
      projectId,
      permit: "view",
      authInfo: { type: "token", authToken: "tok-missing" },
      db,
    });
    expect(allowed).toBe(false);
  });

  test("denies when token belongs to another project", async () => {
    const projectId = uid();
    const otherProjectId = uid();
    await seed.project(db, { id: projectId, userId: "owner-1" });
    await seed.project(db, { id: otherProjectId, userId: "owner-1" });
    await seed.authorizationToken(db, {
      token: "other-project-token",
      projectId: otherProjectId,
    });
    const allowed = await checkProjectPermit({
      projectId,
      permit: "view",
      authInfo: { type: "token", authToken: "other-project-token" },
      db,
    });
    expect(allowed).toBe(false);
  });

  test("denies 'own' permit for tokens regardless of DB", async () => {
    const projectId = uid();
    const allowed = await checkProjectPermit({
      projectId,
      permit: "own",
      authInfo: { type: "token", authToken: "tok-any" },
      db,
    });
    expect(allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkProjectPermit — service auth
// ---------------------------------------------------------------------------

describe("checkProjectPermit — service auth", () => {
  test("service auth allows view without DB", async () => {
    const projectId = uid();
    const allowed = await checkProjectPermit({
      projectId,
      permit: "view",
      authInfo: { type: "service" },
      db,
    });
    expect(allowed).toBe(true);
  });

  test("a publish token's service auth views only its project", async () => {
    const projectId = uid();
    const authInfo = { type: "service" as const, projectId };
    expect(
      await checkProjectPermit({ projectId, permit: "view", authInfo, db })
    ).toBe(true);
    expect(
      await checkProjectPermit({
        projectId: uid(),
        permit: "view",
        authInfo,
        db,
      })
    ).toBe(false);
  });

  test("service auth denies edit", async () => {
    const projectId = uid();
    const allowed = await checkProjectPermit({
      projectId,
      permit: "edit",
      authInfo: { type: "service" },
      db,
    });
    expect(allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasProjectPermit — workspace downgrade guard
// ---------------------------------------------------------------------------

describe("hasProjectPermit — workspace downgrade guard", () => {
  test("denies workspace member when owner plan has maxWorkspaces <= 1", async () => {
    const projectId = uid();
    await seedMember(projectId, "user-2", "editors");
    const ctx = makeUserCtx("user-2", 1);

    const allowed = await hasProjectPermit({ projectId, permit: "edit" }, ctx);
    expect(allowed).toBe(false);
  });

  test("allows workspace member when owner plan has maxWorkspaces > 1", async () => {
    const projectId = uid();
    await seedMember(projectId, "user-2", "editors");
    const ctx = makeUserCtx("user-2", 5);

    const allowed = await hasProjectPermit({ projectId, permit: "edit" }, ctx);
    expect(allowed).toBe(true);
  });

  test("anonymous auth always denied without hitting DB", async () => {
    const projectId = uid();
    const ctx = {
      db,
      authorization: { type: "anonymous" },
      getOwnerPlanFeatures: async () => defaultPlanFeatures,
    } as unknown as AppContext;
    const allowed = await hasProjectPermit({ projectId, permit: "view" }, ctx);
    expect(allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getProjectPermit
// ---------------------------------------------------------------------------

describe("getProjectPermit", () => {
  test("returns first matching permit from ordered list", async () => {
    const projectId = uid();
    await seed.project(db, { id: projectId, userId: "user-1" });
    const ctx = makeUserCtx("user-1");

    const permit = await getProjectPermit(
      { projectId, permits: ["own", "admin", "edit"] },
      ctx
    );
    expect(permit).toBe("own");
  });

  test("returns undefined when no permit matches", async () => {
    const projectId = uid();
    await seed.project(db, { id: projectId, userId: "owner-1" });
    const ctx = makeUserCtx("user-no-access");

    const permit = await getProjectPermit(
      { projectId, permits: ["edit", "view"] },
      ctx
    );
    expect(permit).toBeUndefined();
  });
});
