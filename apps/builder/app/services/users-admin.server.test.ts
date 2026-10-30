import { describe, expect, test, vi } from "vitest";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import {
  createBetterAuth,
  resetPassword,
  signInWithEmail,
} from "./better-auth.server";
import { createUserAccounts } from "./user-accounts.server";
import {
  addUser,
  listUsers,
  resendInvite,
  updateUser,
} from "./users-admin.server";

const db = setupTestDb();

const auth = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("./username-auth.server", () => ({
  getBetterAuth: () => auth.current,
}));

const email = vi.hoisted(() => ({
  enabled: false,
  sent: [] as Array<{ to: string; subject: string; text: string }>,
}));

vi.mock("./email.server", () => ({
  isEmailEnabled: async () => email.enabled,
  sendEmail: async (
    _db: unknown,
    message: { to: string; subject: string; text: string }
  ) => {
    email.sent.push(message);
    return { sent: true };
  },
  setPasswordUrl: (token: string) =>
    `http://localhost:5180/login/reset-password?token=${token}&invite=1`,
  accountInviteEmail: ({ to, inviter, url }: Record<string, string>) => ({
    to,
    subject: `${inviter} added you to Webstudio`,
    text: url,
  }),
}));

const createAuth = () => {
  const created = createBetterAuth({
    db,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    baseURL: "http://localhost:5180",
    rateLimit: false,
  });
  auth.current = created;
  return created;
};

const contextFor = (userId: string) =>
  ({
    db,
    authorization: { type: "user", userId },
  }) as unknown as AppContext;

const password = "correct horse battery staple";

const signIn = (email: string, secret = password) =>
  signInWithEmail(createAuth(), {
    email,
    password: secret,
    request: new Request("http://localhost:5180/auth/password", {
      method: "POST",
    }),
  });

const root = "root@example.com";
const alice = "alice@example.com";

/** The first admin, root@example.com, made the way the account script makes it; returns its context. */
const setup = async () => {
  const accounts = createUserAccounts({ db, auth: createAuth() });
  const { id } = await accounts.add({ name: "Root", email: root, password });
  await accounts.setAdmin(root, true);
  return contextFor(id);
};

describe("users settings", () => {
  test("admins add users who can then sign in", async () => {
    const admin = await setup();

    const { users, invite } = await addUser(
      { name: "Alice", email: "Alice@Example.com", password },
      admin
    );
    expect(invite).toBeUndefined();
    expect(users).toEqual([
      {
        name: "Alice",
        email: alice,
        admin: false,
        disabled: false,
        invited: false,
        isSelf: false,
      },
      {
        name: "Root",
        email: root,
        admin: true,
        disabled: false,
        invited: false,
        isSelf: true,
      },
    ]);
    expect(await signIn(alice)).toMatchObject({ status: "ok" });
  });

  test("adds admins", async () => {
    const admin = await setup();
    const { users } = await addUser(
      { name: "Bob", email: "bob@example.com", password, admin: true },
      admin
    );
    expect(users.find((row) => row.email === "bob@example.com")).toMatchObject({
      admin: true,
    });
  });

  test("invites users, who choose their own password from the link", async () => {
    const admin = await setup();
    email.enabled = false;
    const { users, invite } = await addUser(
      { name: "Alice", email: "Alice@Example.com" },
      admin
    );
    expect(users.find((row) => row.email === alice)).toMatchObject({
      invited: true,
    });
    expect(invite).toMatchObject({
      email: alice,
      emailed: false,
      emailError: "Email isn't set up",
    });
    // No password yet: nothing signs in.
    expect(await signIn(alice, "")).toEqual({ status: "invalid" });

    const token = new URL(invite?.url ?? "").searchParams.get("token") ?? "";
    expect(
      await resetPassword(createAuth(), {
        token,
        password,
        request: new Request("http://localhost:5180/login/reset-password"),
      })
    ).toEqual({ status: "ok" });
    expect(await signIn(alice)).toMatchObject({ status: "ok" });
    expect(
      (await listUsers(admin)).find((row) => row.email === alice)
    ).toMatchObject({ invited: false });
    // The link works once.
    expect(
      await resetPassword(createAuth(), {
        token,
        password: "another long password",
        request: new Request("http://localhost:5180/login/reset-password"),
      })
    ).toEqual({ status: "invalid-token" });
    await expect(resendInvite({ email: alice }, admin)).rejects.toThrow(
      "already chosen a password"
    );
  });

  test("emails invites when email is set up, and resends them", async () => {
    const admin = await setup();
    email.enabled = true;
    email.sent = [];
    const { invite } = await addUser(
      { name: "Alice", email: alice, admin: true },
      admin
    );
    expect(invite).toMatchObject({ email: alice, emailed: true });
    expect(email.sent).toEqual([
      expect.objectContaining({
        to: alice,
        subject: "Root added you to Webstudio",
        text: invite?.url,
      }),
    ]);
    const again = await resendInvite({ email: "ALICE@example.com" }, admin);
    expect(again).toMatchObject({ email: alice, emailed: true });
    expect(again.url).not.toBe(invite?.url);
    expect(email.sent).toHaveLength(2);
    email.enabled = false;
  });

  test("reports what's wrong with a new user", async () => {
    const admin = await setup();
    await expect(
      addUser({ name: "Al", email: "not-an-email", password }, admin)
    ).rejects.toThrow("valid email");
    await expect(
      addUser({ name: "Alice", email: alice, password: "short" }, admin)
    ).rejects.toThrow("at least 12");
    await expect(
      addUser({ name: "Root 2", email: root, password }, admin)
    ).rejects.toThrow("already has an account");
  });

  test("renames, changes emails and passwords, disables, enables and sets the admin role", async () => {
    const admin = await setup();
    await addUser({ name: "Alice", email: alice, password }, admin);

    await updateUser(
      { action: "password", email: alice, password: "a new long password" },
      admin
    );
    expect(await signIn(alice)).toEqual({ status: "invalid" });
    expect(await signIn(alice, "a new long password")).toMatchObject({
      status: "ok",
    });

    let users = await updateUser(
      { action: "name", email: alice, name: "Alice Doe" },
      admin
    );
    expect(users[0]).toMatchObject({ name: "Alice Doe", email: alice });
    users = await updateUser(
      { action: "email", email: alice, newEmail: "alice.doe@example.com" },
      admin
    );
    expect(users[0]).toMatchObject({ email: "alice.doe@example.com" });
    const renamed = "alice.doe@example.com";

    users = await updateUser({ action: "disable", email: renamed }, admin);
    expect(users[0]).toMatchObject({ disabled: true });
    expect(await signIn(renamed, "a new long password")).toEqual({
      status: "invalid",
    });
    users = await updateUser({ action: "enable", email: renamed }, admin);
    expect(users[0]).toMatchObject({ disabled: false });

    users = await updateUser({ action: "admin", email: renamed }, admin);
    expect(users[0]).toMatchObject({ admin: true });
    users = await updateUser({ action: "unadmin", email: renamed }, admin);
    expect(users[0]).toMatchObject({ admin: false });
  });

  test("admins can't lock themselves out", async () => {
    const admin = await setup();
    await expect(
      updateUser({ action: "disable", email: "ROOT@example.com" }, admin)
    ).rejects.toThrow("your own account");
    await expect(
      updateUser({ action: "unadmin", email: root }, admin)
    ).rejects.toThrow("your own admin role");
  });

  test("only admins manage users", async () => {
    await setup();
    await seed.user(db, { id: "someone", role: "user" });
    const someone = contextFor("someone");
    await expect(listUsers(someone)).rejects.toThrow("Only admins");
    await expect(
      addUser({ name: "Mallory", email: "m@example.com", password }, someone)
    ).rejects.toThrow("Only admins");
    await expect(
      updateUser({ action: "admin", email: root }, someone)
    ).rejects.toThrow("Only admins");
    await expect(resendInvite({ email: root }, someone)).rejects.toThrow(
      "Only admins"
    );
  });
});
