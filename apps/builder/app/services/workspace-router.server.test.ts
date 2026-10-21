import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  test,
  expect,
  vi,
} from "vitest";

// vi.hoisted runs before ESM imports, so env.server.ts sees these values.
vi.hoisted(() => {
  process.env.PAYMENT_WORKER_URL = "http://test-payment-worker";
  process.env.PAYMENT_WORKER_TOKEN = "test-token";
});

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { notification, product, transactionLog } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import { createCallerFactory } from "@webstudio-is/trpc-interface/index.server";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { defaultPlanFeatures, type PlanFeatures } from "@webstudio-is/plans";
import { workspaceRouter } from "./workspace-router.server";
import env from "~/env/env.server";

// The payment worker is an HTTP service; requests to it are mocked.
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const db = setupTestDb();

const WS1 = "00000000-0000-4000-8000-000000000001";

const createCaller = createCallerFactory(workspaceRouter);

const teamPlan: PlanFeatures = {
  ...defaultPlanFeatures,
  maxWorkspaces: 5,
  seatsIncluded: 4,
  maxSeatsPerWorkspace: 20,
};

const createContext = (
  overrides?: Partial<{
    planFeatures: PlanFeatures;
    ownerPlanFeatures: PlanFeatures;
    userId: string;
  }>
): AppContext =>
  ({
    db,
    authorization: {
      type: "user",
      userId: overrides?.userId ?? "owner-1",
    },
    planFeatures: overrides?.planFeatures ?? teamPlan,
    purchases: [],
    trpcCache: { setMaxAge: () => {} },
    getOwnerPlanFeatures: async () =>
      overrides?.ownerPlanFeatures ?? overrides?.planFeatures ?? teamPlan,
  }) as unknown as AppContext;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** WS1, owned by owner-1. */
const seedWorkspace = async () => {
  await seed.workspace(db, { id: WS1, userId: "owner-1" });
};

/** Answers the payment worker's /seats/sync with `response`, or HTTP 500 for null. */
const mockPaymentWorker = (
  response: object | null = { type: "success" as const, seats: 1 },
  onRequest?: (body: { workspaceId: string; delta?: number }) => void
) => {
  server.use(
    http.post(`${env.PAYMENT_WORKER_URL}/seats/sync`, async ({ request }) => {
      onRequest?.(
        (await request.json()) as { workspaceId: string; delta?: number }
      );
      if (response === null) {
        return new HttpResponse(null, { status: 500 });
      }
      return HttpResponse.json(response);
    })
  );
};

/**
 * WS1 with `memberCount` members and `pendingInviteCount` pending invites, and
 * an invitee account (invitee@test.com).
 */
const setupAddMember = async (
  opts: {
    workspaceMemberCount?: number;
    pendingInviteCount?: number;
    paymentWorkerResponse?: object | null;
  } = {}
) => {
  const {
    workspaceMemberCount = 1,
    pendingInviteCount = 0,
    paymentWorkerResponse = { type: "success" as const, seats: 1 },
  } = opts;
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
  mockPaymentWorker(paymentWorkerResponse);
};

// ---------------------------------------------------------------------------
// addMember
// ---------------------------------------------------------------------------

describe("addMember", () => {
  test("rejects when maxWorkspaces <= 1 (free/pro plan)", async () => {
    await seedWorkspace();
    const ctx = createContext({ planFeatures: defaultPlanFeatures });
    const caller = createCaller(ctx);

    const result = await caller.addMember({
      workspaceId: WS1,
      email: "invitee@test.com",
      relation: "editors",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Upgrade your plan");
    }
  });

  test("rejects non-owners before billing sync", async () => {
    let paymentWorkerCalled = false;

    await seedWorkspace();
    mockPaymentWorker(undefined, () => {
      paymentWorkerCalled = true;
    });

    const ctx = createContext({ userId: "member-1" });
    const caller = createCaller(ctx);

    const result = await caller.addMember({
      workspaceId: WS1,
      email: "invitee@test.com",
      relation: "editors",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Only the workspace owner");
    }
    expect(paymentWorkerCalled).toBe(false);
  });

  test("rejects when workspace seat limit reached", async () => {
    const plan: PlanFeatures = { ...teamPlan, maxSeatsPerWorkspace: 2 };
    const ctx = createContext({ planFeatures: plan });
    const caller = createCaller(ctx);

    // 2 members + 0 pending = 2 >= maxSeatsPerWorkspace(2)
    await setupAddMember({ workspaceMemberCount: 2, pendingInviteCount: 0 });

    const result = await caller.addMember({
      workspaceId: WS1,
      email: "invitee@test.com",
      relation: "editors",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("seat limit");
    }
  });

  test("rejects when members + pending invites >= maxSeatsPerWorkspace", async () => {
    const plan: PlanFeatures = { ...teamPlan, maxSeatsPerWorkspace: 2 };
    const ctx = createContext({ planFeatures: plan });
    const caller = createCaller(ctx);

    // 1 member + 1 pending = 2 >= maxSeatsPerWorkspace(2)
    await setupAddMember({ workspaceMemberCount: 1, pendingInviteCount: 1 });

    const result = await caller.addMember({
      workspaceId: WS1,
      email: "invitee@test.com",
      relation: "editors",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("seat limit");
    }
  });

  test("rejects when payment worker returns error (card declined)", async () => {
    const ctx = createContext();
    const caller = createCaller(ctx);

    await setupAddMember({
      paymentWorkerResponse: {
        type: "error",
        error: "Your card was declined.",
      },
    });

    const result = await caller.addMember({
      workspaceId: WS1,
      email: "invitee@test.com",
      relation: "editors",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Unable to update billing");
    }
  });

  test("rejects when payment worker HTTP response is not ok", async () => {
    const ctx = createContext();
    const caller = createCaller(ctx);

    await setupAddMember({ paymentWorkerResponse: null });

    const result = await caller.addMember({
      workspaceId: WS1,
      email: "invitee@test.com",
      relation: "editors",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Unable to update billing");
    }
  });

  test("pre-charges payment worker with delta=+1", async () => {
    const ctx = createContext();
    const caller = createCaller(ctx);

    let capturedBody: { workspaceId: string; delta?: number } | undefined;

    await setupAddMember();

    // Override the payment worker handler to capture the request body.
    mockPaymentWorker(undefined, (body) => {
      capturedBody = body;
    });

    const result = await caller.addMember({
      workspaceId: WS1,
      email: "invitee@test.com",
      relation: "editors",
    });

    expect(result.success).toBe(true);
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.workspaceId).toBe(WS1);
    expect(capturedBody!.delta).toBe(1);
  });

  test("succeeds and creates invite notification when billing passes", async () => {
    const ctx = createContext();
    const caller = createCaller(ctx);

    await setupAddMember({ workspaceMemberCount: 2 });

    const result = await caller.addMember({
      workspaceId: WS1,
      email: "invitee@test.com",
      relation: "editors",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(await db.select().from(notification)).toEqual([
        expect.objectContaining({
          id: result.notificationId,
          type: "workspaceInvite",
          recipientId: "user-2",
          payload: { workspaceId: WS1, relation: "editors" },
        }),
      ]);
    }
  });

  test("rejects an invitee without an account before billing", async () => {
    let paymentWorkerCalled = false;
    await seedWorkspace();
    mockPaymentWorker(undefined, () => {
      paymentWorkerCalled = true;
    });

    const result = await createCaller(createContext()).addMember({
      workspaceId: WS1,
      email: "nobody@test.com",
      relation: "editors",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("No Webstudio account found");
    }
    expect(paymentWorkerCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeMember
// ---------------------------------------------------------------------------

describe("removeMember", () => {
  test("calls payment worker to sync seats after removal", async () => {
    let capturedBody: { workspaceId: string; delta?: number } | undefined;

    await seedWorkspace();
    await seed.workspaceMember(db, { workspaceId: WS1, userId: "user-2" });
    mockPaymentWorker({ type: "success", seats: 0 }, (body) => {
      capturedBody = body;
    });

    const ctx = createContext();
    const caller = createCaller(ctx);
    const result = await caller.removeMember({
      workspaceId: WS1,
      memberUserId: "user-2",
    });

    expect(result.success).toBe(true);
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.workspaceId).toBe(WS1);
    // No delta — member is already removed from DB
    expect(capturedBody!.delta).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// syncSeats
// ---------------------------------------------------------------------------

describe("syncSeats", () => {
  test("rejects when maxWorkspaces <= 1", async () => {
    await seedWorkspace();
    const ctx = createContext({ planFeatures: defaultPlanFeatures });
    const caller = createCaller(ctx);

    const result = await caller.syncSeats({ workspaceId: WS1 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Upgrade your plan");
    }
  });

  test("calls payment worker with workspaceId (no delta)", async () => {
    let capturedBody: { workspaceId: string; delta?: number } | undefined;

    await seedWorkspace();
    mockPaymentWorker({ type: "success", seats: 3 }, (body) => {
      capturedBody = body;
    });

    const ctx = createContext();
    const caller = createCaller(ctx);
    const result = await caller.syncSeats({ workspaceId: WS1 });

    expect(result.success).toBe(true);
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.workspaceId).toBe(WS1);
    // No delta for manual sync
    expect(capturedBody!.delta).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listMembers
// ---------------------------------------------------------------------------

describe("listMembers", () => {
  const setupListMembers = async (opts: {
    memberCount?: number;
    /** Extra seats bought, or null for no subscription event */
    extraSeats?: number | null;
  }) => {
    const { memberCount = 2, extraSeats = null } = opts;
    await seed.user(db, {
      id: "owner-1",
      email: "owner@test.com",
      username: "owner",
    });
    await seedWorkspace();
    for (let index = 1; index <= memberCount; index += 1) {
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
    await db
      .insert(product)
      .values({ id: "prod-seats", name: "Seats", meta: {} });
    if (extraSeats !== null) {
      await db.insert(transactionLog).values({
        eventId: "evt-seats",
        userId: "owner-1",
        productId: "prod-seats",
        eventData: {
          type: "customer.subscription.updated",
          created: 1000,
          data: {
            object: {
              object: "subscription",
              id: "sub-seats",
              items: { data: [{ quantity: extraSeats }] },
            },
          },
        },
      });
    }
  };

  test("maxSeats = seatsIncluded + extraSeats when subscription exists", async () => {
    // seatsIncluded=4, quantity=2 → maxSeats=6
    await setupListMembers({ extraSeats: 2 });

    const ctx = createContext();
    const caller = createCaller(ctx);
    const result = await caller.listMembers({ workspaceId: WS1 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxSeats).toBe(6); // 4 + 2
    }
  });

  test("maxSeats = seatsIncluded when no subscription events", async () => {
    // seatsIncluded=4, no TransactionLog event → paidSeats=null → maxSeats=4
    await setupListMembers({ extraSeats: null });

    const ctx = createContext();
    const caller = createCaller(ctx);
    const result = await caller.listMembers({ workspaceId: WS1 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxSeats).toBe(4); // 4 + 0
    }
  });

  test("maxSeats = seatsIncluded when subscription has quantity=0", async () => {
    await setupListMembers({ extraSeats: 0 });

    const ctx = createContext();
    const caller = createCaller(ctx);
    const result = await caller.listMembers({ workspaceId: WS1 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxSeats).toBe(4); // 4 + 0
    }
  });

  test("maxSeats uses workspace owner's seats for member callers", async () => {
    await setupListMembers({ extraSeats: null });

    const ctx = createContext({
      userId: "m-1",
      planFeatures: defaultPlanFeatures,
      ownerPlanFeatures: teamPlan,
    });
    const caller = createCaller(ctx);
    const result = await caller.listMembers({ workspaceId: WS1 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxSeats).toBe(4);
    }
  });

  test("returns owner, members, and pendingInvites", async () => {
    await setupListMembers({ memberCount: 2, extraSeats: null });

    const ctx = createContext();
    const caller = createCaller(ctx);
    const result = await caller.listMembers({ workspaceId: WS1 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.owner.userId).toBe("owner-1");
      expect(result.data.members).toHaveLength(2);
      expect(result.data.pendingInvites).toHaveLength(0);
    }
  });
});
