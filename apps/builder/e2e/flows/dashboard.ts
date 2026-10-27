import { dashboardUrl, getProjectIdFromBuilderUrl } from "../test";
import type { Page } from "@playwright/test";
import { createDb, type Db } from "@webstudio-is/db";
import env from "../../app/env/env.server";
import { createBetterAuth } from "../../app/services/better-auth.server";
import {
  createUserAccounts,
  type UserAccounts,
} from "../../app/services/user-accounts.server";

const loginReadyTimeout = 30_000;

export const getWorkerEmail = (
  email: string,
  parallelIndex = process.env.TEST_PARALLEL_INDEX
) => {
  if (parallelIndex === undefined) {
    return email;
  }
  const separatorIndex = email.lastIndexOf("@");
  return `${email.slice(0, separatorIndex)}+worker-${parallelIndex}${email.slice(separatorIndex)}`;
};

/** Every e2e account uses this password; e2e databases are disposable. */
const e2ePassword = "e2e-password-not-secret";

let db: Db | undefined;
const getDb = () => (db ??= createDb(env.DATABASE_URL, { max: 2 }));

let accounts: UserAccounts | undefined;
const getAccounts = () => {
  if (accounts === undefined) {
    const db = getDb();
    accounts = createUserAccounts({
      db,
      auth: createBetterAuth({
        db,
        secret: env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET ?? "",
        baseURL: dashboardUrl,
      }),
    });
  }
  return accounts;
};

/**
 * A username unique to the worker's email: a readable prefix of its local part plus a
 * hash of the whole address (usernames have at most 32 characters).
 */
/**
 * Signs in as the account for this worker's email, creating it on first use (there
 * is no sign-up).
 */
export const loginWithPassword = async ({
  page,
  email,
}: {
  page: Page;
  email: string;
}) => {
  console.info("e2e: opening login");
  await page.goto(`${dashboardUrl}/login`);
  const emailField = page.getByLabel("Email", { exact: true });
  let loginState: "login" | "dashboard";
  try {
    loginState = await Promise.any([
      emailField
        .waitFor({ state: "visible", timeout: loginReadyTimeout })
        .then(() => "login" as const),
      page
        .waitForURL(`${dashboardUrl}/dashboard`, {
          timeout: loginReadyTimeout,
        })
        .then(() => "dashboard" as const),
    ]);
  } catch (error) {
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    throw new Error(
      `Expected login page or dashboard at ${page.url()}. Body: ${bodyText}`,
      { cause: error }
    );
  }
  if (loginState === "dashboard") {
    console.info("e2e: dashboard loaded");
    return;
  }

  const workerEmail = getWorkerEmail(email);
  const accounts = getAccounts();
  if ((await accounts.exists(workerEmail)) === false) {
    await accounts.add({
      name: workerEmail.split("@")[0],
      email: workerEmail,
      password: e2ePassword,
    });
  }

  await emailField.fill(workerEmail);
  await page.getByLabel("Password", { exact: true }).fill(e2ePassword);
  console.info("e2e: submitting sign-in");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${dashboardUrl}/dashboard`);
  console.info("e2e: dashboard loaded");
};

export const createBlankProject = async ({
  page,
  title,
}: {
  page: Page;
  title: string;
}) => {
  const createProjectButton = page.getByRole("button", {
    name: /Create a blank project|New project/,
  });
  try {
    await createProjectButton.waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    throw new Error(
      `Expected dashboard create-project button at ${page.url()}. Body: ${bodyText}`,
      { cause: error }
    );
  }

  console.info("e2e: opening create project dialog");
  await createProjectButton.click();
  await page.getByPlaceholder("My Project").fill(title);
  console.info("e2e: submitting create project");
  await page.getByRole("button", { name: "Create Project" }).click();
  await page.waitForURL(/\/\/p-[^.]+\.localhost:\d+\//);
  console.info(`e2e: created project at ${page.url()}`);

  const projectId = getProjectIdFromBuilderUrl(page.url());
  if (projectId === undefined) {
    throw new Error(`Expected builder URL, received ${page.url()}`);
  }
  return projectId;
};

export const loginAndCreateBlankProject = async ({
  page,
  email,
  title,
}: {
  page: Page;
  email: string;
  title: string;
}) => {
  await loginWithPassword({ page, email });
  return await createBlankProject({ page, title });
};
