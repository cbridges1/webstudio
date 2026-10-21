import { describe, expect, test } from "vitest";
import { authAccount, authSession, eq, user } from "@webstudio-is/db";
import { setupTestDb } from "@webstudio-is/db/testing";
import { createBetterAuth, signInWithUsername } from "./better-auth.server";

const db = setupTestDb();

const createAuth = () =>
  createBetterAuth({
    db,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    baseURL: "http://localhost:5180",
  });

const password = "correct horse battery staple";

/** Creates an account the way the account script does. */
const createAccount = async (
  auth: ReturnType<typeof createAuth>,
  username = "alice",
  { email }: { email?: string } = {}
) => {
  const { user: created } = await auth.api.createUser({
    body: {
      email: email ?? `${username}@users.invalid`,
      password,
      name: username,
      data: { username },
    },
  });
  await db
    .update(user)
    .set({ provider: "username", email: email ?? null })
    .where(eq(user.id, created.id));
  return created.id;
};

const signIn = (
  auth: ReturnType<typeof createAuth>,
  input: { username: string; password: string; ip?: string }
) =>
  signInWithUsername(auth, {
    username: input.username,
    password: input.password,
    request: new Request("http://localhost:5180/auth/password", {
      method: "POST",
      headers: { "x-forwarded-for": input.ip ?? "203.0.113.1" },
    }),
  });

describe("username sign-in", () => {
  test("signs in with the right password and keeps no Better Auth session", async () => {
    const auth = createAuth();
    const userId = await createAccount(auth);

    await expect(
      signIn(auth, { username: "alice", password })
    ).resolves.toEqual({ status: "ok", userId });
    expect(await db.select().from(authSession)).toEqual([]);
  });

  test("stores the password hash outside the user row", async () => {
    const auth = createAuth();
    const userId = await createAccount(auth);

    const [account] = await db
      .select()
      .from(authAccount)
      .where(eq(authAccount.userId, userId));
    expect(account.providerId).toBe("credential");
    expect(account.password).not.toContain(password);
    const [row] = await db.select().from(user).where(eq(user.id, userId));
    expect(row).toMatchObject({
      username: "alice",
      loginName: "alice",
      provider: "username",
      email: null,
    });
  });

  test("ignores case and surrounding spaces in the username", async () => {
    const auth = createAuth();
    const userId = await createAccount(auth);

    await expect(
      signIn(auth, { username: "  Alice ", password })
    ).resolves.toEqual({ status: "ok", userId });
  });

  test("gives the same answer for a wrong password and an unknown username", async () => {
    const auth = createAuth();
    await createAccount(auth);

    await expect(
      signIn(auth, { username: "alice", password: "wrong password!!" })
    ).resolves.toEqual({ status: "invalid" });
    await expect(
      signIn(auth, { username: "nobody", password })
    ).resolves.toEqual({ status: "invalid" });
  });

  test("rejects a disabled account", async () => {
    const auth = createAuth();
    const userId = await createAccount(auth);
    await db.update(user).set({ banned: true }).where(eq(user.id, userId));

    await expect(
      signIn(auth, { username: "alice", password })
    ).resolves.toEqual({ status: "invalid" });
  });

  test("rate-limits repeated attempts from one address", async () => {
    const auth = createAuth();
    await createAccount(auth);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        signIn(auth, { username: "alice", password: "wrong password!!" })
      ).resolves.toEqual({ status: "invalid" });
    }
    await expect(
      signIn(auth, { username: "alice", password })
    ).resolves.toEqual({ status: "rate-limited" });
    // Other addresses are unaffected.
    await expect(
      signIn(auth, { username: "alice", password, ip: "203.0.113.2" })
    ).resolves.toMatchObject({ status: "ok" });
  });

  test("has no sign-up or email sign-in", async () => {
    const auth = createAuth();
    for (const path of ["/api/auth/sign-up/email", "/api/auth/sign-in/email"]) {
      const response = await auth.handler(
        new Request(`http://localhost:5180${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "eve@example.com",
            password,
            name: "eve",
          }),
        })
      );
      expect(response.ok).toBe(false);
    }
    expect(
      await db.select().from(user).where(eq(user.email, "eve@example.com"))
    ).toEqual([]);
  });
});
