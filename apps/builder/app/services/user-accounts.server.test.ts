import { describe, expect, test } from "vitest";
import { eq, user, workspace } from "@webstudio-is/db";
import { setupTestDb } from "@webstudio-is/db/testing";
import { createBetterAuth, signInWithUsername } from "./better-auth.server";
import { AccountError, createUserAccounts } from "./user-accounts.server";

const db = setupTestDb();

const setup = () => {
  const auth = createBetterAuth({
    db,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    baseURL: "http://localhost:5173",
    rateLimit: false,
  });
  return { auth, accounts: createUserAccounts({ db, auth }) };
};

const password = "correct horse battery staple";

const signIn = (auth: ReturnType<typeof setup>["auth"], secret: string) =>
  signInWithUsername(auth, {
    username: "alice",
    password: secret,
    request: new Request("http://localhost:5173/auth/password"),
  });

describe("user accounts", () => {
  test("adds a user with a default workspace and lists it", async () => {
    const { accounts } = setup();
    const created = await accounts.add({
      username: " Alice ",
      email: "Alice@Example.com",
      password,
    });

    expect(created.username).toBe("alice");
    expect(await accounts.list()).toEqual([
      { username: "alice", email: "alice@example.com", disabled: false },
    ]);
    expect(
      await db
        .select({ name: workspace.name, isDefault: workspace.isDefault })
        .from(workspace)
        .where(eq(workspace.userId, created.id))
    ).toEqual([{ name: "My workspace", isDefault: true }]);
  });

  test("keeps the placeholder email out of User.email", async () => {
    const { accounts } = setup();
    const { id } = await accounts.add({ username: "alice", password });

    const [row] = await db.select().from(user).where(eq(user.id, id));
    expect(row.email).toBeNull();
    expect(row.provider).toBe("username");
  });

  test("rejects invalid input and duplicates", async () => {
    const { accounts } = setup();
    await expect(
      accounts.add({ username: "a", password })
    ).rejects.toBeInstanceOf(AccountError);
    await expect(
      accounts.add({ username: "alice", password: "short" })
    ).rejects.toThrow(/at least 12/);
    await expect(
      accounts.add({ username: "alice", email: "nope", password })
    ).rejects.toThrow(/valid email/);
    await accounts.add({ username: "alice", password });
    await expect(accounts.add({ username: "ALICE", password })).rejects.toThrow(
      /already exists/
    );
  });

  test("changes the password", async () => {
    const { auth, accounts } = setup();
    await accounts.add({ username: "alice", password });
    await accounts.setPassword("alice", "a brand new password");

    await expect(signIn(auth, password)).resolves.toEqual({
      status: "invalid",
    });
    await expect(signIn(auth, "a brand new password")).resolves.toMatchObject({
      status: "ok",
    });
  });

  test("disables and enables sign-in", async () => {
    const { auth, accounts } = setup();
    await accounts.add({ username: "alice", password });

    await accounts.disable("alice");
    expect((await accounts.list())[0].disabled).toBe(true);
    await expect(signIn(auth, password)).resolves.toEqual({
      status: "invalid",
    });

    await accounts.enable("alice");
    await expect(signIn(auth, password)).resolves.toMatchObject({
      status: "ok",
    });
  });

  test("accepts the characters the help text promises", async () => {
    const { auth, accounts } = setup();
    await accounts.add({ username: "jane.doe-2_x", password });
    await expect(
      signInWithUsername(auth, {
        username: "jane.doe-2_x",
        password,
        request: new Request("http://localhost:5173/auth/password"),
      })
    ).resolves.toMatchObject({ status: "ok" });
  });

  test("reports unknown users", async () => {
    const { accounts } = setup();
    await expect(accounts.disable("nobody")).rejects.toThrow("No user nobody");
  });
});
