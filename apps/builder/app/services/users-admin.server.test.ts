import { describe, expect, test, vi } from "vitest";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import { createBetterAuth, signInWithUsername } from "./better-auth.server";
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

const signIn = (username: string, secret = password) =>
  signInWithUsername(createAuth(), {
    username,
    password: secret,
    request: new Request("http://localhost:5180/auth/password", {
      method: "POST",
    }),
  });

/** The first admin, "root", made the way the account script makes it; returns its context. */
const setup = async () => {
  const accounts = createUserAccounts({ db, auth: createAuth() });
  const { id } = await accounts.add({ username: "root", password });
  await accounts.setAdmin("root", true);
  return contextFor(id);
};

describe("users settings", () => {
  test("admins add users who can then sign in", async () => {
    const admin = await setup();

    const users = await addUser(
      { username: "Alice", email: "alice@example.com", password },
      admin
    );
    expect(users).toEqual([
      {
        username: "alice",
        email: "alice@example.com",
        admin: false,
        disabled: false,
        isSelf: false,
      },
      {
        username: "root",
        email: null,
        admin: true,
        disabled: false,
        isSelf: true,
      },
    ]);
    expect(await signIn("alice")).toMatchObject({ status: "ok" });
    expect(await signIn("alice@example.com")).toMatchObject({ status: "ok" });
  });

  test("adds admins", async () => {
    const admin = await setup();
    const users = await addUser(
      { username: "bob", password, admin: true },
      admin
    );
    expect(users.find((row) => row.username === "bob")).toMatchObject({
      admin: true,
    });
  });

  test("reports what's wrong with a new user", async () => {
    const admin = await setup();
    await expect(addUser({ username: "al", password }, admin)).rejects.toThrow(
      "Usernames have 3–32"
    );
    await expect(
      addUser({ username: "alice", password: "short" }, admin)
    ).rejects.toThrow("at least 12");
    await expect(
      addUser({ username: "root", password }, admin)
    ).rejects.toThrow("root already exists");
  });

  test("changes passwords, disables, enables and sets the admin role", async () => {
    const admin = await setup();
    await addUser({ username: "alice", password }, admin);

    await updateUser(
      {
        action: "password",
        username: "alice",
        password: "a new long password",
      },
      admin
    );
    expect(await signIn("alice")).toEqual({ status: "invalid" });
    expect(await signIn("alice", "a new long password")).toMatchObject({
      status: "ok",
    });

    let users = await updateUser(
      { action: "disable", username: "alice" },
      admin
    );
    expect(users[0]).toMatchObject({ username: "alice", disabled: true });
    expect(await signIn("alice", "a new long password")).toEqual({
      status: "invalid",
    });
    users = await updateUser({ action: "enable", username: "alice" }, admin);
    expect(users[0]).toMatchObject({ disabled: false });

    users = await updateUser({ action: "admin", username: "alice" }, admin);
    expect(users[0]).toMatchObject({ admin: true });
    users = await updateUser({ action: "unadmin", username: "alice" }, admin);
    expect(users[0]).toMatchObject({ admin: false });
  });

  test("admins can't lock themselves out", async () => {
    const admin = await setup();
    await expect(
      updateUser({ action: "disable", username: "root" }, admin)
    ).rejects.toThrow("your own account");
    await expect(
      updateUser({ action: "unadmin", username: "root" }, admin)
    ).rejects.toThrow("your own admin role");
  });

  test("only admins manage users", async () => {
    await setup();
    await seed.user(db, { id: "someone", role: "user" });
    const someone = contextFor("someone");
    await expect(listUsers(someone)).rejects.toThrow("Only admins");
    await expect(
      addUser({ username: "mallory", password }, someone)
    ).rejects.toThrow("Only admins");
    await expect(
      updateUser({ action: "admin", username: "someone" }, someone)
    ).rejects.toThrow("Only admins");
  });
});
