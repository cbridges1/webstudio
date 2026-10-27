import { describe, expect, test } from "vitest";
import { authAccount, authSession, eq, user } from "@webstudio-is/db";
import { setupTestDb } from "@webstudio-is/db/testing";
import {
  createBetterAuth,
  requestPasswordReset,
  resetPassword,
  signInWithEmail,
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
  email = "alice@example.com",
  name = "Alice"
) => {
  const { user: created } = await auth.api.createUser({
    body: { email, password, name },
  });
  await db
    .update(user)
    .set({ provider: "password" })
    .where(eq(user.id, created.id));
  return created.id;
};

const signIn = (
  auth: ReturnType<typeof createAuth>,
  input: { email: string; password: string; ip?: string }
) =>
  signInWithEmail(auth, {
    email: input.email,
    password: input.password,
    request: new Request("http://localhost:5180/auth/password", {
      method: "POST",
      headers: { "x-forwarded-for": input.ip ?? "203.0.113.1" },
    }),
  });

describe("email sign-in", () => {
  test("signs in with the right password and keeps no Better Auth session", async () => {
    const auth = createAuth();
    const userId = await createAccount(auth);

    await expect(
      signIn(auth, { email: "alice@example.com", password })
    ).resolves.toEqual({ status: "ok", userId });
    expect(await db.select().from(authSession)).toEqual([]);
  });

  test("stores the password hash outside the user row", async () => {
    const auth = createAuth();
    const userId = await createAccount(auth);

    const [row] = await db.select().from(user).where(eq(user.id, userId));
    expect(row).toMatchObject({
      email: "alice@example.com",
      username: "Alice",
      provider: "password",
    });
    expect(JSON.stringify(row)).not.toContain(password);
    const [account] = await db
      .select()
      .from(authAccount)
      .where(eq(authAccount.userId, userId));
    expect(account.providerId).toBe("credential");
    expect(account.password).toMatch(/\S/);
    expect(account.password).not.toBe(password);
  });

  test("ignores case and surrounding spaces in the email", async () => {
    const auth = createAuth();
    const userId = await createAccount(auth);

    await expect(
      signIn(auth, { email: "  Alice@Example.com ", password })
    ).resolves.toEqual({ status: "ok", userId });
  });

  test("gives the same answer for a wrong password and an unknown email", async () => {
    const auth = createAuth();
    await createAccount(auth);

    await expect(
      signIn(auth, { email: "alice@example.com", password: "wrong password!!" })
    ).resolves.toEqual({ status: "invalid" });
    await expect(
      signIn(auth, { email: "nobody@example.com", password })
    ).resolves.toEqual({ status: "invalid" });
  });

  test("rejects a disabled account", async () => {
    const auth = createAuth();
    const userId = await createAccount(auth);
    await db.update(user).set({ banned: true }).where(eq(user.id, userId));

    await expect(
      signIn(auth, { email: "alice@example.com", password })
    ).resolves.toEqual({ status: "invalid" });
  });

  test("rate-limits repeated attempts from one address", async () => {
    const auth = createAuth();
    await createAccount(auth);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        signIn(auth, { email: "nobody@example.com", password })
      ).resolves.toEqual({ status: "invalid" });
    }
    await expect(
      signIn(auth, { email: "alice@example.com", password })
    ).resolves.toEqual({ status: "rate-limited" });
    // Other addresses are unaffected.
    await expect(
      signIn(auth, { email: "alice@example.com", password, ip: "203.0.113.2" })
    ).resolves.toMatchObject({ status: "ok" });
  });

  test("has no sign-up", async () => {
    const auth = createAuth();
    const response = await auth.handler(
      new Request("http://localhost:5180/api/auth/sign-up/email", {
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
    await createAccount(auth);

    expect(
      await requestPasswordReset(auth, {
        email: " Alice@Example.com ",
        request: request(),
      })
    ).toBe("sent");
    expect(sent).toEqual([
      { email: "alice@example.com", name: "Alice", token: expect.any(String) },
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
      signIn(auth, { email: "alice@example.com", password })
    ).resolves.toEqual({ status: "invalid" });
    await expect(
      signIn(auth, { email: "alice@example.com", password: newPassword })
    ).resolves.toMatchObject({ status: "ok" });
  });

  test("answers the same for an unknown email", async () => {
    const { auth, sent } = createResettableAuth();
    await createAccount(auth);
    expect(
      await requestPasswordReset(auth, {
        email: "nobody@example.com",
        request: request(),
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
