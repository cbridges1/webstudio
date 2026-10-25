// Reads a project's deploy target from the builder's database (ProjectDeployTarget, which the
// builder writes when a project admin saves it): the host and its settings, and separately the
// host credentials, decrypted with DEPLOY_CREDENTIALS_KEY.
import {
  CREDENTIALS_KEY_MISSING,
  credentialsKey,
  decryptCredentials,
} from "@webstudio-is/deploy-protocol/credentials";
import type {
  DeployCredentials,
  DeployTarget,
} from "@webstudio-is/deploy-protocol";
import { eq, maybeOne, projectDeployTarget, type Db } from "@webstudio-is/db";
import { TargetError } from "./targets";

/** The project's saved host and settings, or undefined when it has no target. */
export type LoadTarget = (
  projectId: string
) => Promise<DeployTarget | undefined>;

/** The project's saved credentials for `host`, or undefined when it has none. */
export type LoadCredentials = (
  projectId: string,
  host: string
) => Promise<DeployCredentials | undefined>;

export const createTargetLoader =
  (db: Db): LoadTarget =>
  async (projectId) => {
    const row = maybeOne(
      await db
        .select({
          host: projectDeployTarget.host,
          config: projectDeployTarget.config,
        })
        .from(projectDeployTarget)
        .where(eq(projectDeployTarget.projectId, projectId))
    );
    return row === null
      ? undefined
      : {
          host: row.host,
          config: (row.config ?? {}) as Record<string, unknown>,
        };
  };

export const createCredentialsLoader = ({
  db,
  key,
}: {
  db: Db;
  key?: string;
}): LoadCredentials => {
  return async (projectId, host) => {
    if (key === undefined || key.length < 32) {
      throw new TargetError(CREDENTIALS_KEY_MISSING);
    }
    const row = maybeOne(
      await db
        .select({
          host: projectDeployTarget.host,
          credentials: projectDeployTarget.credentials,
        })
        .from(projectDeployTarget)
        .where(eq(projectDeployTarget.projectId, projectId))
    );
    // Credentials saved for another host don't apply.
    if (row === null || row.credentials === null || row.host !== host) {
      return;
    }
    const credentials = decryptCredentials(
      projectId,
      row.credentials,
      credentialsKey(key)
    );
    if (credentials === undefined) {
      throw new TargetError(
        "The project's saved credentials can't be read (DEPLOY_CREDENTIALS_KEY may differ from the builder's). Enter them again in Project settings → Deploy."
      );
    }
    return credentials;
  };
};
