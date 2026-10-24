// Reads a project's host credentials from the builder's database (ProjectDeployTarget, which
// the builder writes when a project admin saves them) and decrypts them with
// DEPLOY_CREDENTIALS_KEY. Only that column: everything else comes in the request.
import {
  CREDENTIALS_KEY_MISSING,
  credentialsKey,
  decryptCredentials,
} from "@webstudio-is/deploy-protocol/credentials";
import type { DeployCredentials } from "@webstudio-is/deploy-protocol";
import { eq, maybeOne, projectDeployTarget, type Db } from "@webstudio-is/db";
import { TargetError } from "./targets";

/** The project's saved credentials for `host`, or undefined when it has none. */
export type LoadCredentials = (
  projectId: string,
  host: string
) => Promise<DeployCredentials | undefined>;

export const createCredentialsLoader = ({
  db,
  key,
}: {
  /** The builder's database; undefined when this service has no DATABASE_URL. */
  db?: Db;
  key?: string;
}): LoadCredentials => {
  return async (projectId, host) => {
    if (db === undefined) {
      throw new TargetError(
        "This deploy service has no DATABASE_URL, so it can't read the project's credentials"
      );
    }
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
