import { describe, expect, test } from "vitest";
import { authAccount, authSession, eq, user } from "@webstudio-is/db";
import { setupTestDb } from "@webstudio-is/db/testing";
import {
  createBetterAuth,
  requestPasswordReset,
  resetPassword,
  signInWithUsername,
} from "./better-auth.server";

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

  test("signs in with the account's email instead of the username", async () => {
    const auth = createAuth();
    const userId = await createAccount(auth, "alice", {
      email: "alice@example.com",
    });

    await expect(
      signIn(auth, { username: " Alice@Example.com ", password })
    ).resolves.toEqual({ status: "ok", userId });
    await expect(
      signIn(auth, {
        username: "alice@example.com",
        password: "wrong password!!",
      })
    ).resolves.toEqual({ status: "invalid" });
    await expect(
      signIn(auth, { username: "bob@example.com", password })
    ).resolves.toEqual({ status: "invalid" });
  });

  test("an account without an email can't sign in with its placeholder", async () => {
    const auth = createAuth();
    await createAccount(auth);

    await expect(
      signIn(auth, { username: "alice@users.invalid", password })
    ).resolves.toEqual({ status: "invalid" });
  });

  test("email sign-ins count against the rate limit", async () => {
    const auth = createAuth();
    await createAccount(auth, "alice", { email: "alice@example.com" });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await signIn(auth, { username: "nobody@example.com", password });
    }
    await expect(
      signIn(auth, { username: "alice@example.com", password })
    ).resolves.toEqual({ status: "rate-limited" });
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

describe("password reset", () => {
  const request = (ip = "203.0.113.9") =>
    new Request("http://localhost:5180/login/forgot-password", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
    });

  const createResettableAuth = () => {
    const sent: { email: string; name: string; token: string }[] = [];
    const auth = createBetterAuth({
      db,
      secret: "test-secret-that-is-long-enough-for-better-auth",
      baseURL: "http://localhost:5180",
      sendResetPassword: async ({ user, token }) => {
        sent.push({ email: user.email, name: user.name, token });
      },
    });
    return { auth, sent };
  };

  test("emails a token that sets a new password once", async () => {
    const { auth, sent } = createResettableAuth();
    await createAccount(auth, "alice", { email: "alice@example.com" });

    expect(
      await requestPasswordReset(auth, {
        email: " Alice@Example.com ",
        request: request(),
      })
    ).toBe("sent");
    expect(sent).toEqual([
      { email: "alice@example.com", name: "alice", token: expect.any(String) },
    ]);
    const { token } = sent[0];

    expect(
      await resetPassword(auth, {
        token,
        password: "short",
        request: request(),
      })
    ).toMatchObject({ status: "invalid-password" });
    const newPassword = "a whole new password, long enough";
    expect(
      await resetPassword(auth, {
        token,
        password: newPassword,
        request: request(),
      })
    ).toEqual({ status: "ok" });
    // Once only.
    expect(
      await resetPassword(auth, {
        token,
        password: "and another long password",
        request: request(),
      })
    ).toEqual({ status: "invalid-token" });

    await expect(
      signIn(auth, { username: "alice", password })
    ).resolves.toEqual({ status: "invalid" });
    await expect(
      signIn(auth, { username: "alice", password: newPassword })
    ).resolves.toMatchObject({ status: "ok" });
  });

  test("answers the same for an unknown email or an account without one", async () => {
    const { auth, sent } = createResettableAuth();
    await createAccount(auth, "bob");
    expect(
      await requestPasswordReset(auth, {
        email: "nobody@example.com",
        request: request(),
      })
    ).toBe("sent");
    // bob's placeholder address isn't his email.
    expect(
      await requestPasswordReset(auth, {
        email: "bob@users.invalid",
        request: request("203.0.113.10"),
      })
    ).toBe("sent");
    expect(sent).toEqual([]);
  });

  test("limits requests per client address", async () => {
    const { auth } = createResettableAuth();
    const results = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      results.push(
        await requestPasswordReset(auth, {
          email: "x@example.com",
          request: request("203.0.113.20"),
        })
      );
    }
    expect(results).toEqual(["sent", "sent", "sent", "rate-limited"]);
  });
});
