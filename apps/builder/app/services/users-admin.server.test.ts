import { describe, expect, test, vi } from "vitest";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { createBetterAuth, signInWithEmail } from "./better-auth.server";
import { createUserAccounts } from "./user-accounts.server";
import { addUser, listUsers, updateUser } from "./users-admin.server";

const db = setupTestDb();

const auth = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("./username-auth.server", () => ({
  getBetterAuth: () => auth.current,
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

    const users = await addUser(
      { name: "Alice", email: "Alice@Example.com", password },
      admin
    );
    expect(users).toEqual([
      {
        name: "Alice",
        email: alice,
        admin: false,
        disabled: false,
        isSelf: false,
      },
      { name: "Root", email: root, admin: true, disabled: false, isSelf: true },
    ]);
    expect(await signIn(alice)).toMatchObject({ status: "ok" });
  });

  test("adds admins", async () => {
    const admin = await setup();
    const users = await addUser(
      { name: "Bob", email: "bob@example.com", password, admin: true },
      admin
    );
    expect(users.find((row) => row.email === "bob@example.com")).toMatchObject({
      admin: true,
    });
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
  });
});
