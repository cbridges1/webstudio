import { describe, test, expect } from "vitest";
import { domain, eq, projectDomain } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { countTotalDomains, create, remove } from "./domain";

const db = setupTestDb();

const createContext = (overrides: Partial<AppContext> = {}): AppContext =>
  ({
    db,
    authorization: { type: "user", userId: "owner-1" },
    getOwnerPlanFeatures: () =>
      Promise.resolve({ maxDomainsAllowedPerUser: 5, maxWorkspaces: 20 }),
    domain: {},
    deployment: {
      deploymentTrpc: {
        unpublish: {
          mutate: () => Promise.resolve({ success: true }),
        },
      },
      env: {
        BUILDER_ORIGIN: "https://apps.webstudio.is",
        GITHUB_REF_NAME: "main",
        GITHUB_SHA: undefined,
        PUBLISHER_HOST: "wstd.io",
      },
    },
    entri: {},
    ...overrides,
  }) as unknown as AppContext;

/** `count` custom domains attached to live projects of owner-1. */
const seedOwnerDomains = async (count: number) => {
  await seed.project(db, { id: "other-proj", userId: "owner-1" });
  for (let index = 0; index < count; index += 1) {
    await db
      .insert(domain)
      .values({ id: `existing-${index}`, domain: `site-${index}.com` });
    await db.insert(projectDomain).values({
      projectId: "other-proj",
      domainId: `existing-${index}`,
      txtRecord: `txt-${index}`,
      cname: "cname",
    });
  }
};

// ---------------------------------------------------------------------------
// countTotalDomains
// ---------------------------------------------------------------------------

describe("countTotalDomains", () => {
  test("counts domains attached to the user's live projects", async () => {
    await seedOwnerDomains(3);
    // A domain on a deleted project doesn't count.
    await seed.project(db, {
      id: "deleted-proj",
      userId: "owner-1",
      isDeleted: true,
    });
    await db.insert(domain).values({ id: "gone", domain: "gone.com" });
    await db.insert(projectDomain).values({
      projectId: "deleted-proj",
      domainId: "gone",
      txtRecord: "txt-gone",
      cname: "cname",
    });
    // Neither does another user's.
    await seed.project(db, { id: "someone-else", userId: "owner-2" });
    await db.insert(domain).values({ id: "theirs", domain: "theirs.com" });
    await db.insert(projectDomain).values({
      projectId: "someone-else",
      domainId: "theirs",
      txtRecord: "txt-theirs",
      cname: "cname",
    });

    const count = await countTotalDomains("owner-1", createContext());
    expect(count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// create — domain limit guard
// Verifies that reaching maxDomainsAllowedPerUser returns an error without
// touching the Domain or ProjectDomain tables.
// ---------------------------------------------------------------------------

describe("create — domain limit guard", () => {
  test("returns error when owner is at the domain limit", async () => {
    await seed.project(db, { id: "proj-1", userId: "owner-1" });
    await seedOwnerDomains(5);

    const result = await create(
      {
        projectId: "proj-1",
        domain: "example.com",
      },
      createContext()
    );

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("maximum number of allowed domains"),
    });
    expect(
      await db.select().from(domain).where(eq(domain.domain, "example.com"))
    ).toEqual([]);
  });

  test("creates domain entries when under the limit", async () => {
    await seed.project(db, { id: "proj-1", userId: "owner-1" });

    const result = await create(
      {
        projectId: "proj-1",
        domain: "example.com",
      },
      createContext()
    );

    expect(result).toEqual({ success: true });
    const [created] = await db
      .select()
      .from(domain)
      .where(eq(domain.domain, "example.com"));
    expect(created).toMatchObject({ status: "INITIALIZING" });
    expect(
      await db
        .select({ projectId: projectDomain.projectId })
        .from(projectDomain)
        .where(eq(projectDomain.domainId, created.id))
    ).toEqual([{ projectId: "proj-1" }]);
  });

  test("reuses an existing Domain row", async () => {
    await seed.project(db, { id: "proj-1", userId: "owner-1" });
    await db
      .insert(domain)
      .values({ id: "known", domain: "example.com", status: "ACTIVE" });

    const result = await create(
      { projectId: "proj-1", domain: "example.com" },
      createContext()
    );

    expect(result).toEqual({ success: true });
    expect(await db.select().from(domain)).toEqual([
      expect.objectContaining({ id: "known", status: "ACTIVE" }),
    ]);
  });

  test("reports a duplicate attachment as an error", async () => {
    await seed.project(db, { id: "proj-1", userId: "owner-1" });
    await create(
      { projectId: "proj-1", domain: "example.com" },
      createContext()
    );

    const result = await create(
      { projectId: "proj-1", domain: "example.com" },
      createContext()
    );

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("duplicate key"),
    });
  });

  test("uses project owner's domain limit for workspace member admins", async () => {
    const ownerPlanCalls: string[] = [];
    const workspaceId = crypto.randomUUID();
    await seed.workspace(db, { id: workspaceId, userId: "owner-1" });
    await seed.project(db, { id: "proj-1", userId: "owner-1", workspaceId });
    await seed.workspaceMember(db, {
      workspaceId,
      userId: "member-1",
      relation: "administrators",
    });
    await seedOwnerDomains(1);

    const result = await create(
      {
        projectId: "proj-1",
        domain: "example.com",
      },
      createContext({
        authorization: { type: "user", userId: "member-1" },
        planFeatures: { maxDomainsAllowedPerUser: 0 },
        getOwnerPlanFeatures: (userId: string) => {
          ownerPlanCalls.push(userId);
          return Promise.resolve({
            maxDomainsAllowedPerUser: 5,
            maxWorkspaces: 20,
          });
        },
      } as unknown as Partial<AppContext>)
    );

    expect(result).toEqual({ success: true });
    expect(
      await db
        .select({ projectId: projectDomain.projectId })
        .from(projectDomain)
        .where(eq(projectDomain.projectId, "proj-1"))
    ).toEqual([{ projectId: "proj-1" }]);
    expect(ownerPlanCalls).toEqual(["owner-1"]);
  });
});

// ---------------------------------------------------------------------------
// remove
// Detaches the domain only after unpublishing and marks unreferenced domains
// inactive so they do not remain ACTIVE orphans.
// ---------------------------------------------------------------------------

/** example.com, ACTIVE and attached to proj-1 (owned by owner-1). */
const seedAttachedDomain = async () => {
  await seed.project(db, { id: "proj-1", userId: "owner-1" });
  await db.insert(domain).values({
    id: "domain-id-1",
    domain: "example.com",
    status: "ACTIVE",
    txtRecord: "txt",
  });
  await db.insert(projectDomain).values({
    projectId: "proj-1",
    domainId: "domain-id-1",
    txtRecord: "txt",
    cname: "cname",
  });
};

const deploymentWith = (
  unpublish: (input: { domain: string }) => Promise<unknown>
) =>
  ({
    deploymentTrpc: {
      publish: {
        mutate: () => Promise.resolve({ success: true }),
      },
      unpublish: { mutate: unpublish },
    },
    env: {
      BUILDER_ORIGIN: "https://apps.webstudio.is",
      GITHUB_REF_NAME: "main",
      GITHUB_SHA: undefined,
      PUBLISHER_HOST: "wstd.io",
    },
  }) as unknown as AppContext["deployment"];

describe("remove", () => {
  test("unpublishes, detaches, and marks an unreferenced domain inactive", async () => {
    await seedAttachedDomain();
    let unpublishedDomain: string | undefined;

    const result = await remove(
      { projectId: "proj-1", domainId: "domain-id-1" },
      createContext({
        deployment: deploymentWith(({ domain }) => {
          unpublishedDomain = domain;
          return Promise.resolve({ success: true });
        }),
      })
    );

    expect(result).toEqual({ success: true });
    expect(unpublishedDomain).toBe("example.com");
    expect(await db.select().from(projectDomain)).toEqual([]);
    expect(await db.select().from(domain)).toEqual([
      expect.objectContaining({
        id: "domain-id-1",
        status: "INITIALIZING",
        error: "Removed from project",
        txtRecord: null,
      }),
    ]);
  });

  test("keeps a domain still attached to another project", async () => {
    await seedAttachedDomain();
    await seed.project(db, { id: "proj-2", userId: "owner-1" });
    await db.insert(projectDomain).values({
      projectId: "proj-2",
      domainId: "domain-id-1",
      txtRecord: "txt-2",
      cname: "cname",
    });

    const result = await remove(
      { projectId: "proj-1", domainId: "domain-id-1" },
      createContext()
    );

    expect(result).toEqual({ success: true });
    expect(await db.select().from(domain)).toEqual([
      expect.objectContaining({ id: "domain-id-1", status: "ACTIVE" }),
    ]);
  });

  test("does not detach when unpublish fails", async () => {
    await seedAttachedDomain();

    const result = await remove(
      { projectId: "proj-1", domainId: "domain-id-1" },
      createContext({
        deployment: deploymentWith(() =>
          Promise.resolve({ success: false, error: "Cloudflare failed" })
        ),
      })
    );

    expect(result).toEqual({ success: false, error: "Cloudflare failed" });
    expect(await db.select().from(projectDomain)).toHaveLength(1);
  });

  test("reports an unknown domain", async () => {
    await seed.project(db, { id: "proj-1", userId: "owner-1" });

    const result = await remove(
      { projectId: "proj-1", domainId: "missing" },
      createContext()
    );

    expect(result).toEqual({ success: false, error: "Domain not found" });
  });
});
