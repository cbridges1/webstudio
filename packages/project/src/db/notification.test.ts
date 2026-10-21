import { describe, test, expect } from "vitest";
import {
  domain,
  eq,
  notification,
  project,
  projectDomain,
} from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { defaultPlanFeatures } from "@webstudio-is/plans";
import { accept, __testing__ } from "./notification";

const { describeNotification } = __testing__;

describe("describeNotification", () => {
  test("workspace invite with workspace name and relation", () => {
    expect(
      describeNotification({
        type: "workspaceInvite",
        senderLabel: "Alice",
        workspaceName: "Design Team",
        invite: { workspaceId: "ws-1", relation: "editors" },
      })
    ).toBe('Alice invited you to "Design Team" as editor');
  });

  test("workspace invite without workspace name falls back", () => {
    expect(
      describeNotification({
        type: "workspaceInvite",
        senderLabel: "Bob",
        workspaceName: undefined,
        invite: { workspaceId: "ws-1", relation: "viewers" },
      })
    ).toBe('Bob invited you to "a workspace" as viewer');
  });

  test("workspace invite with administrators relation", () => {
    expect(
      describeNotification({
        type: "workspaceInvite",
        senderLabel: "Carol",
        workspaceName: "Acme",
        invite: { workspaceId: "ws-1", relation: "administrators" },
      })
    ).toBe('Carol invited you to "Acme" as admin');
  });

  test("workspace invite with builders relation", () => {
    expect(
      describeNotification({
        type: "workspaceInvite",
        senderLabel: "Dave",
        workspaceName: "Studio",
        invite: { workspaceId: "ws-1", relation: "builders" },
      })
    ).toBe('Dave invited you to "Studio" as builder');
  });

  test("workspace invite type without invite payload returns generic", () => {
    expect(
      describeNotification({
        type: "workspaceInvite",
        senderLabel: "Eve",
      })
    ).toBe("You have a new notification");
  });

  test("project transfer with project title", () => {
    expect(
      describeNotification({
        type: "projectTransfer",
        senderLabel: "Frank",
        projectTitle: "My Portfolio",
      })
    ).toBe('Frank wants to transfer "My Portfolio" to you');
  });

  test("project transfer without project title falls back", () => {
    expect(
      describeNotification({
        type: "projectTransfer",
        senderLabel: "Grace",
        projectTitle: undefined,
      })
    ).toBe('Grace wants to transfer "a project" to you');
  });

  test("unknown type returns generic message", () => {
    expect(
      describeNotification({
        type: "unknownType",
        senderLabel: "Someone",
      })
    ).toBe("You have a new notification");
  });
});

// ---------------------------------------------------------------------------
// accept() — domain guard
// ---------------------------------------------------------------------------

const db = setupTestDb();

const makeAcceptCtx = (
  planOverrides: Partial<typeof defaultPlanFeatures> = {}
): AppContext =>
  ({
    authorization: { type: "user", userId: "recipient-1" },
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

const notificationId = "00000000-0000-4000-8000-000000000001";

/** proj-1 owned by sender-1, with a pending transfer to recipient-1. */
const seedTransfer = async ({ withDomain }: { withDomain: boolean }) => {
  await seed.user(db, { id: "recipient-1" });
  await seed.workspace(db, {
    id: "00000000-0000-4000-8000-0000000000a1",
    userId: "recipient-1",
    isDefault: true,
  });
  await seed.project(db, { id: "proj-1", userId: "sender-1" });
  if (withDomain) {
    await db.insert(domain).values({ id: "domain-1", domain: "example.com" });
    await db.insert(projectDomain).values({
      projectId: "proj-1",
      domainId: "domain-1",
      txtRecord: "txt",
      cname: "cname",
    });
  }
  await db.insert(notification).values({
    id: notificationId,
    type: "projectTransfer",
    status: "pending",
    senderId: "sender-1",
    recipientId: "recipient-1",
    createdAt: new Date(Date.now() - 1000).toISOString(),
    payload: { projectId: "proj-1" },
  });
};

const readNotificationStatus = async () =>
  (
    await db
      .select({ status: notification.status })
      .from(notification)
      .where(eq(notification.id, notificationId))
  )[0]?.status;

describe("accept — domain guard", () => {
  test("throws when free receiver tries to accept a project with a custom domain", async () => {
    await seedTransfer({ withDomain: true });

    const ctx = makeAcceptCtx({
      maxDomainsAllowedPerUser: 0,
      maxProjectsAllowedPerUser: 100,
    });

    await expect(accept({ notificationId }, ctx)).rejects.toThrow(
      "custom domains attached"
    );
    // The claim is reverted so the receiver can retry after upgrading.
    expect(await readNotificationStatus()).toBe("pending");
  });

  test("succeeds when free receiver accepts a project with no custom domains", async () => {
    await seedTransfer({ withDomain: false });

    const ctx = makeAcceptCtx({
      maxDomainsAllowedPerUser: 0,
      maxProjectsAllowedPerUser: 100,
    });

    await expect(accept({ notificationId }, ctx)).resolves.toBeUndefined();
    expect(await readNotificationStatus()).toBe("accepted");
    // The project moves to the receiver's default workspace.
    expect(
      await db
        .select({ userId: project.userId, workspaceId: project.workspaceId })
        .from(project)
        .where(eq(project.id, "proj-1"))
    ).toEqual([
      {
        userId: "recipient-1",
        workspaceId: "00000000-0000-4000-8000-0000000000a1",
      },
    ]);
  });
});
