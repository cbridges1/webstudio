import { expect, test } from "vitest";
import { projectDeployTarget } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import {
  credentialsKey,
  encryptCredentials,
} from "@webstudio-is/deploy-protocol/credentials";
import { createCredentialsLoader } from "./credentials";

const db = setupTestDb();
const key = "k".repeat(40);
const account = {
  client_email: "deploy@project.iam.gserviceaccount.com",
  private_key: "secret",
};

/** project-1 with a firebase target, its credentials encrypted as the builder does. */
const seedTarget = async (credentials: string | null) => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  await seed.workspace(db, { id: workspaceId, userId: "owner" });
  await seed.project(db, { id: "project-1", userId: "owner", workspaceId });
  await db.insert(projectDeployTarget).values({
    projectId: "project-1",
    host: "firebase",
    config: { site: "s" },
    credentials,
  });
};

test("reads and decrypts a project's saved credentials", async () => {
  await seedTarget(
    encryptCredentials("project-1", account, credentialsKey(key))
  );
  const load = createCredentialsLoader({ db, key });
  expect(await load("project-1", "firebase")).toEqual(account);
  // Not for another host, and nothing for a project without a target.
  expect(await load("project-1", "directory")).toBeUndefined();
  expect(await load("project-2", "firebase")).toBeUndefined();
});

test("says so when the key differs from the builder's", async () => {
  await seedTarget(
    encryptCredentials("project-1", account, credentialsKey(key))
  );
  const load = createCredentialsLoader({ db, key: "o".repeat(40) });
  await expect(load("project-1", "firebase")).rejects.toThrow(
    "can't be read (DEPLOY_CREDENTIALS_KEY may differ"
  );
});

test("needs a database and a key", async () => {
  await expect(
    createCredentialsLoader({ key })("project-1", "firebase")
  ).rejects.toThrow("no DATABASE_URL");
  await expect(
    createCredentialsLoader({ db })("project-1", "firebase")
  ).rejects.toThrow("DEPLOY_CREDENTIALS_KEY");
});
