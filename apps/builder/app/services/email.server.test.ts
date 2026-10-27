import { afterEach, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_SECRET = "test-auth-secret-that-is-at-least-32-chars";
  process.env.BETTER_AUTH_URL = "https://builder.example.com";
});

import { emailSettings } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import env from "~/env/env.server";
import {
  emailTransport,
  isEmailEnabled,
  loadEmailAdminSettings,
  loadEmailSettings,
  passwordResetEmail,
  removeEmailSettings,
  saveEmailSettings,
  sendEmail,
  sendTestEmail,
  workspaceInviteEmail,
} from "./email.server";

const db = setupTestDb();

const contextFor = (userId: string) =>
  ({ db, authorization: { type: "user", userId } }) as unknown as AppContext;

const originalCreate = emailTransport.create;

afterEach(() => {
  emailTransport.create = originalCreate;
  env.SMTP_HOST = undefined;
  env.SMTP_PORT = undefined;
  env.SMTP_SECURE = undefined;
  env.SMTP_USER = undefined;
  env.SMTP_PASSWORD = undefined;
  env.SMTP_FROM = undefined;
});

/** Records what would be sent, and with which server settings. */
const fakeTransport = (fail?: string) => {
  const sent: { settings: unknown; mail: Record<string, unknown> }[] = [];
  emailTransport.create = (settings) =>
    ({
      sendMail: async (mail: Record<string, unknown>) => {
        if (fail) {
          throw new Error(fail);
        }
        sent.push({ settings, mail });
        return {};
      },
    }) as unknown as ReturnType<typeof originalCreate>;
  return sent;
};

const smtp = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  username: "mailer",
  password: "smtp-secret-password",
  from: "Webstudio <noreply@example.com>",
};

describe("email settings", () => {
  test("are off until set", async () => {
    expect(await isEmailEnabled(db)).toBe(false);
    expect(
      await sendEmail(db, { to: "a@b.c", subject: "s", text: "t" })
    ).toEqual({ sent: false, error: "Email isn't set up" });
  });

  test("admins save them, with the password encrypted and never shown", async () => {
    await seed.user(db, { id: "admin", role: "admin" });
    expect(await saveEmailSettings(smtp, contextFor("admin"))).toEqual({
      source: "app",
      host: "smtp.example.com",
      port: 587,
      secure: false,
      username: "mailer",
      hasPassword: true,
      from: "Webstudio <noreply@example.com>",
    });
    const [row] = await db.select().from(emailSettings);
    expect(row.password).toMatch(/^enc1\./);
    expect(row.password).not.toContain("smtp-secret");
    expect((await loadEmailSettings(db))?.password).toBe(
      "smtp-secret-password"
    );

    // Saving without a password keeps it; without a username drops it.
    await saveEmailSettings({ ...smtp, password: "" }, contextFor("admin"));
    expect((await loadEmailSettings(db))?.password).toBe(
      "smtp-secret-password"
    );
    await saveEmailSettings({ ...smtp, username: "" }, contextFor("admin"));
    expect(await loadEmailSettings(db)).toMatchObject({
      username: null,
      password: null,
    });

    await removeEmailSettings(contextFor("admin"));
    expect(await isEmailEnabled(db)).toBe(false);
  });

  test("only admins manage them", async () => {
    await seed.user(db, { id: "member" });
    await expect(loadEmailAdminSettings(contextFor("member"))).rejects.toThrow(
      "Only admins"
    );
    await expect(saveEmailSettings(smtp, contextFor("member"))).rejects.toThrow(
      "Only admins"
    );
    await expect(
      sendTestEmail({ to: "x@example.com" }, contextFor("member"))
    ).rejects.toThrow("Only admins");
  });

  test("the environment's replace the saved ones and can't be changed", async () => {
    await seed.user(db, { id: "admin", role: "admin" });
    await saveEmailSettings(smtp, contextFor("admin"));
    env.SMTP_HOST = "mail.env.test";
    env.SMTP_SECURE = "true";
    env.SMTP_FROM = "env@example.com";
    expect(await loadEmailSettings(db)).toEqual({
      source: "env",
      host: "mail.env.test",
      port: 465,
      secure: true,
      username: null,
      password: null,
      from: "env@example.com",
    });
    await expect(saveEmailSettings(smtp, contextFor("admin"))).rejects.toThrow(
      "builder's environment"
    );
  });
});

describe("sending", () => {
  test("sends with the saved server", async () => {
    await seed.user(db, { id: "admin", role: "admin" });
    await saveEmailSettings(smtp, contextFor("admin"));
    const sent = fakeTransport();
    expect(
      await sendTestEmail({ to: "admin@example.com" }, contextFor("admin"))
    ).toEqual({ sent: true });
    expect(sent).toEqual([
      {
        settings: expect.objectContaining({
          host: "smtp.example.com",
          username: "mailer",
          password: "smtp-secret-password",
        }),
        mail: expect.objectContaining({
          from: "Webstudio <noreply@example.com>",
          to: "admin@example.com",
          subject: "Webstudio test email",
        }),
      },
    ]);
  });

  test("reports a failure instead of throwing", async () => {
    env.SMTP_HOST = "mail.env.test";
    env.SMTP_FROM = "env@example.com";
    fakeTransport("Connection refused");
    expect(
      await sendEmail(db, { to: "a@example.com", subject: "s", text: "t" })
    ).toEqual({ sent: false, error: "Connection refused" });
  });
});

describe("messages", () => {
  test("a workspace invite links to the dashboard", () => {
    const mail = workspaceInviteEmail({
      to: "bob@example.com",
      inviter: "alice",
      workspaceName: "Marketing <team>",
    });
    expect(mail.subject).toBe(
      "alice invited you to Marketing <team> on Webstudio"
    );
    expect(mail.text).toContain("https://builder.example.com/dashboard");
    // The HTML escapes what users typed.
    expect(mail.html).toContain("Marketing &lt;team&gt;");
    expect(mail.html).not.toContain("<team>");
  });

  test("a password reset links to the reset page with the token", () => {
    const mail = passwordResetEmail({
      to: "alice@example.com",
      token: "reset-token-123",
    });
    expect(mail.text).toContain(
      "https://builder.example.com/login/reset-password?token=reset-token-123"
    );
  });
});
