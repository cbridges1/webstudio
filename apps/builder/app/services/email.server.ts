// selfhost: email over SMTP, for workspace invites and password resets.
//
// The SMTP server comes from the builder's environment (SMTP_HOST, SMTP_PORT, SMTP_SECURE,
// SMTP_USER, SMTP_PASSWORD, SMTP_FROM) or, when SMTP_HOST isn't set, from what an app admin
// saves in the dashboard (Settings → Email; EmailSettings, the password encrypted with a
// key derived from AUTH_SECRET). Without either, the builder sends no email: invites stay
// in-app notifications and "Forgot password?" is hidden.
import nodemailer from "nodemailer";
import { z } from "zod";
import { emailSettings, eq, maybeOne, type Db } from "@webstudio-is/db";
import {
  AuthorizationError,
  type AppContext,
} from "@webstudio-is/trpc-interface/index.server";
import {
  credentialsKey,
  decryptCredentials,
  encryptCredentials,
} from "@webstudio-is/deploy-protocol/credentials";
import env from "~/env/env.server";
import { isAppAdmin } from "./deployers.server";

/** The builder's public address, for links in emails. */
export const builderOrigin = () =>
  env.BETTER_AUTH_URL ??
  env.DEPLOYMENT_URL ??
  `http://localhost:${env.PORT ?? 3000}`;

type SmtpSettings = {
  /** "env": from the builder's environment, which the app can't change. */
  source: "env" | "app";
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password: string | null;
  from: string;
};

// The password is bound to this label, so a value copied from elsewhere doesn't decrypt.
const PASSWORD_AAD = "smtp-password";
const passwordKey = () => credentialsKey(env.AUTH_SECRET);

const encryptPassword = (password: string) =>
  encryptCredentials(PASSWORD_AAD, { password }, passwordKey());

const decryptPassword = (stored: string) => {
  try {
    const value = decryptCredentials(PASSWORD_AAD, stored, passwordKey());
    return typeof value?.password === "string" ? value.password : undefined;
  } catch {
    return;
  }
};

/** The environment's SMTP server, else the one saved in the app, else undefined. */
export const loadEmailSettings = async (
  db: Db
): Promise<SmtpSettings | undefined> => {
  if (env.SMTP_HOST !== undefined) {
    const secure = env.SMTP_SECURE === "true";
    return {
      source: "env",
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? (secure ? 465 : 587),
      secure,
      username: env.SMTP_USER ?? null,
      password: env.SMTP_PASSWORD ?? null,
      from: env.SMTP_FROM ?? "",
    };
  }
  const row = maybeOne(await db.select().from(emailSettings));
  if (row === null) {
    return;
  }
  return {
    source: "app",
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    password:
      row.password === null ? null : (decryptPassword(row.password) ?? null),
    from: row.from,
  };
};

export const isEmailEnabled = async (db: Db) =>
  (await loadEmailSettings(db)) !== undefined;

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

/** Makes the SMTP connection; tests replace it. */
export const emailTransport = {
  create: (settings: SmtpSettings) =>
    nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth:
        settings.username === null
          ? undefined
          : { user: settings.username, pass: settings.password ?? "" },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    }) as Pick<nodemailer.Transporter, "sendMail">,
};

export type SendResult = { sent: true } | { sent: false; error: string };

/** Sends with the configured SMTP server. Never throws: failures come back as the error. */
export const sendEmail = async (
  db: Db,
  message: EmailMessage
): Promise<SendResult> => {
  const settings = await loadEmailSettings(db);
  if (settings === undefined) {
    return { sent: false, error: "Email isn't set up" };
  }
  try {
    await emailTransport.create(settings).sendMail({
      from: settings.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { sent: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Sending email failed: ${reason}`);
    return { sent: false, error: reason };
  }
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** A short message with one link, as text and HTML. */
const linkEmail = ({
  to,
  subject,
  lines,
  linkLabel,
  url,
  footer,
}: {
  to: string;
  subject: string;
  lines: string[];
  linkLabel: string;
  url: string;
  footer?: string;
}): EmailMessage => ({
  to,
  subject,
  text: [
    ...lines,
    "",
    `${linkLabel}: ${url}`,
    ...(footer ? ["", footer] : []),
  ].join("\n"),
  html: [
    ...lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p><a href="${escapeHtml(url)}">${escapeHtml(linkLabel)}</a></p>`,
    ...(footer ? [`<p style="color:#666">${escapeHtml(footer)}</p>`] : []),
  ].join("\n"),
});

export const workspaceInviteEmail = ({
  to,
  inviter,
  workspaceName,
}: {
  to: string;
  inviter: string;
  workspaceName: string;
}) =>
  linkEmail({
    to,
    subject: `${inviter} invited you to ${workspaceName} on Webstudio`,
    lines: [
      `${inviter} invited you to the workspace "${workspaceName}" on Webstudio.`,
      "Sign in and accept the invitation from the notifications in your dashboard.",
    ],
    linkLabel: "Open the dashboard",
    url: new URL("/dashboard", builderOrigin()).href,
  });

export const passwordResetEmail = ({
  to,
  username,
  token,
}: {
  to: string;
  username: string;
  token: string;
}) => {
  const url = new URL("/login/reset-password", builderOrigin());
  url.searchParams.set("token", token);
  return linkEmail({
    to,
    subject: "Reset your Webstudio password",
    lines: [
      `Someone asked to reset the password of the Webstudio account "${username}".`,
      "The link works once, for one hour.",
    ],
    linkLabel: "Choose a new password",
    url: url.href,
    footer:
      "If it wasn't you, ignore this email: your password stays the same.",
  });
};

// App admins: the SMTP server.

const assertAppAdmin = async (context: AppContext) => {
  if (
    context.authorization.type !== "user" ||
    (await isAppAdmin(context.db, context.authorization.userId)) === false
  ) {
    throw new AuthorizationError("Only admins can set up email");
  }
};

export const emailSettingsInput = z.object({
  host: z.string().trim().min(1, "Enter the SMTP server"),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  /** Empty: no login. */
  username: z.string().trim().optional(),
  /** Empty or missing keeps the saved password. */
  password: z.string().optional(),
  from: z.string().trim().min(3, "Enter the From address"),
});

/** What the browser may see: never the password. */
export const loadEmailAdminSettings = async (context: AppContext) => {
  await assertAppAdmin(context);
  const settings = await loadEmailSettings(context.db);
  if (settings === undefined) {
    return { source: "none" as const };
  }
  return {
    source: settings.source,
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    username: settings.username,
    hasPassword: settings.password !== null,
    from: settings.from,
  };
};

const assertNotFromEnv = () => {
  if (env.SMTP_HOST !== undefined) {
    throw new Error(
      "Email is set by the builder's environment (SMTP_HOST, …), so it can't be changed here"
    );
  }
};

export const saveEmailSettings = async (
  input: z.infer<typeof emailSettingsInput>,
  context: AppContext
) => {
  await assertAppAdmin(context);
  assertNotFromEnv();
  const current = maybeOne(await context.db.select().from(emailSettings));
  const username = input.username || null;
  const values = {
    host: input.host,
    port: input.port,
    secure: input.secure,
    username,
    // No login, no password; otherwise a new one or the saved one.
    password:
      username === null
        ? null
        : input.password
          ? encryptPassword(input.password)
          : (current?.password ?? null),
    from: input.from,
    updatedAt: new Date().toISOString(),
  };
  if (current === null) {
    await context.db.insert(emailSettings).values(values);
  } else {
    await context.db
      .update(emailSettings)
      .set(values)
      .where(eq(emailSettings.id, current.id));
  }
  return await loadEmailAdminSettings(context);
};

export const removeEmailSettings = async (context: AppContext) => {
  await assertAppAdmin(context);
  assertNotFromEnv();
  await context.db.delete(emailSettings);
};

export const sendTestEmail = async (
  { to }: { to: string },
  context: AppContext
) => {
  await assertAppAdmin(context);
  return await sendEmail(context.db, {
    to,
    subject: "Webstudio test email",
    text: `This is a test email from the Webstudio builder at ${builderOrigin()}. Email works.`,
  });
};
