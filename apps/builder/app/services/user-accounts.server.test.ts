import { describe, expect, test } from "vitest";
import { eq, user, workspace } from "@webstudio-is/db";
import { setupTestDb } from "@webstudio-is/db/testing";
import {
  createBetterAuth,
  resetPassword,
  signInWithEmail,
} from "./better-auth.server";
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

const signIn = (
  auth: ReturnType<typeof setup>["auth"],
  secret: string,
  email = "alice@example.com"
) =>
  signInWithEmail(auth, {
    email,
    password: secret,
    request: new Request("http://localhost:5173/auth/password"),
  });

const alice = { name: "Alice", email: "alice@example.com", password };

describe("user accounts", () => {
  test("adds a user with a default workspace and lists it", async () => {
    const { accounts } = setup();
    const created = await accounts.add({
      name: " Alice Doe ",
      email: " Alice@Example.com ",
      password,
    });

    expect(created.email).toBe("alice@example.com");
    expect(await accounts.list()).toEqual([
      {
        name: "Alice Doe",
        email: "alice@example.com",
        disabled: false,
        admin: false,
        invited: false,
      },
    ]);
    const [row] = await db.select().from(user).where(eq(user.id, created.id));
    expect(row).toMatchObject({ username: "Alice Doe", provider: "password" });
    expect(
      await db
        .select({ name: workspace.name, isDefault: workspace.isDefault })
        .from(workspace)
        .where(eq(workspace.userId, created.id))
    ).toEqual([{ name: "My workspace", isDefault: true }]);
  });

  test("lists only accounts that sign in with a password", async () => {
    const { accounts } = setup();
    await db.insert(user).values({ id: "oauth-user", email: "o@example.com" });
    await accounts.add(alice);
    expect((await accounts.list()).map((row) => row.email)).toEqual([
      "alice@example.com",
    ]);
  });

  test("adds invited users without a password, who set one with a link", async () => {
    const { auth, accounts } = setup();
    await accounts.add({ name: "Alice", email: alice.email });
    expect(await accounts.list()).toMatchObject([
      { email: "alice@example.com", invited: true },
    ]);
    expect(await signIn(auth, "")).toEqual({ status: "invalid" });
    expect(await signIn(auth, password)).toEqual({ status: "invalid" });

    const token = await accounts.createSetPasswordToken("Alice@example.com");
    expect(
      await resetPassword(auth, {
        token,
        password,
        request: new Request("http://localhost:5173/login/reset-password"),
      })
    ).toEqual({ status: "ok" });
    expect(await signIn(auth, password)).toMatchObject({ status: "ok" });
    expect(await accounts.list()).toMatchObject([{ invited: false }]);
  });

  test("set-password links expire", async () => {
    const { auth, accounts } = setup();
    await accounts.add({ name: "Alice", email: alice.email });
    const token = await accounts.createSetPasswordToken(alice.email, -1);
    expect(
      await resetPassword(auth, {
        token,
        password,
        request: new Request("http://localhost:5173/login/reset-password"),
      })
    ).toEqual({ status: "invalid-token" });
    await expect(
      accounts.createSetPasswordToken("nobody@example.com")
    ).rejects.toThrow(AccountError);
  });

  test("makes and unmakes app admins", async () => {
    const { accounts } = setup();
    const { id } = await accounts.add(alice);
    await accounts.setAdmin("Alice@example.com", true);
    expect(await accounts.list()).toMatchObject([{ admin: true }]);
    const [row] = await db.select().from(user).where(eq(user.id, id));
    expect(row.role).toBe("admin");
    await accounts.setAdmin("alice@example.com", false);
    expect(await accounts.list()).toMatchObject([{ admin: false }]);
    await expect(accounts.setAdmin("nobody@example.com", true)).rejects.toThrow(
      AccountError
    );
  });

  test("rejects invalid input and duplicates", async () => {
    const { accounts } = setup();
    await expect(accounts.add({ ...alice, name: "  " })).rejects.toThrow(
      /Enter a name/
    );
    await expect(accounts.add({ ...alice, password: "short" })).rejects.toThrow(
      /at least 12/
    );
    await expect(accounts.add({ ...alice, email: "nope" })).rejects.toThrow(
      /valid email/
    );
    await accounts.add(alice);
    await expect(
      accounts.add({ ...alice, email: "ALICE@example.com" })
    ).rejects.toThrow(/already has an account/);
  });

  test("changes the password", async () => {
    const { auth, accounts } = setup();
    await accounts.add(alice);
    await accounts.setPassword("alice@example.com", "a brand new password");

    await expect(signIn(auth, password)).resolves.toEqual({
      status: "invalid",
    });
    await expect(signIn(auth, "a brand new password")).resolves.toMatchObject({
      status: "ok",
    });
  });

  test("renames and changes the sign-in email", async () => {
    const { auth, accounts } = setup();
    await accounts.add(alice);
    await accounts.add({ ...alice, email: "bob@example.com", name: "Bob" });

    await accounts.setName("alice@example.com", "Alice Doe");
    await expect(
      accounts.setEmail("alice@example.com", "bob@example.com")
    ).rejects.toThrow(/already has an account/);
    await accounts.setEmail("alice@example.com", " Alice.Doe@Example.com ");

    expect(await accounts.list()).toMatchObject([
      { name: "Alice Doe", email: "alice.doe@example.com" },
      { name: "Bob", email: "bob@example.com" },
    ]);
    await expect(signIn(auth, password)).resolves.toEqual({
      status: "invalid",
    });
    await expect(
      signIn(auth, password, "alice.doe@example.com")
    ).resolves.toMatchObject({ status: "ok" });
  });

  test("disables and enables sign-in", async () => {
    const { auth, accounts } = setup();
    await accounts.add(alice);

    await accounts.disable("alice@example.com");
    expect((await accounts.list())[0].disabled).toBe(true);
    await expect(signIn(auth, password)).resolves.toEqual({
      status: "invalid",
    });

    await accounts.enable("alice@example.com");
    await expect(signIn(auth, password)).resolves.toMatchObject({
      status: "ok",
    });
  });

  test("reports unknown users", async () => {
    const { accounts } = setup();
    await expect(accounts.disable("nobody@example.com")).rejects.toThrow(
      "No user nobody@example.com"
    );
  });
});
