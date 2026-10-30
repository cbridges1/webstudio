// selfhost: a project's host credentials (e.g. a Firebase service account key), kept in
// ProjectDeployTarget.credentials encrypted with AES-256-GCM. The builder encrypts them when a
// project admin saves them; the deploy service reads and decrypts them from the same database
// when it needs them, so they never travel in requests. Both share DEPLOY_CREDENTIALS_KEY (and
// only that: the deploy service holds no builder secret). Changing the key means entering the
// credentials again. The project ID is bound in as associated data: a value copied to another
// project doesn't decrypt.
//
// Format: `enc1.<base64url IV>.<base64url ciphertext + auth tag>`.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { DeployCredentials } from "./index";

const PREFIX = "enc1";
const TAG_BYTES = 16;

export const CREDENTIALS_KEY_MISSING =
  "DEPLOY_CREDENTIALS_KEY (32+ characters) must be set to store or use deploy credentials";

/** The AES key for DEPLOY_CREDENTIALS_KEY; throws when it's unset or too short. */
export const credentialsKey = (secret: string | undefined) => {
  if (secret === undefined || secret.length < 32) {
    throw new Error(CREDENTIALS_KEY_MISSING);
  }
  return createHmac("sha256", secret)
    .update("webstudio-deploy-credentials")
    .digest();
};

export const encryptCredentials = (
  projectId: string,
  credentials: DeployCredentials,
  key: Buffer
) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(projectId));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${PREFIX}.${iv.toString("base64url")}.${encrypted.toString(
    "base64url"
  )}`;
};

/** The credentials, or undefined when the value can't be decrypted (e.g. a changed key). */
export const decryptCredentials = (
  projectId: string,
  value: string,
  key: Buffer
): DeployCredentials | undefined => {
  const [prefix, iv, data, ...rest] = value.split(".");
  if (
    prefix !== PREFIX ||
    iv === undefined ||
    data === undefined ||
    rest.length > 0
  ) {
    return;
  }
  try {
    const encrypted = Buffer.from(data, "base64url");
    if (encrypted.length < TAG_BYTES) {
      return;
    }
    // authTagLength: without it GCM accepts a truncated tag.
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
      { authTagLength: TAG_BYTES }
    );
    decipher.setAAD(Buffer.from(projectId));
    decipher.setAuthTag(encrypted.subarray(-TAG_BYTES));
    const json = Buffer.concat([
      decipher.update(encrypted.subarray(0, -TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as DeployCredentials)
      : undefined;
  } catch {
    return;
  }
};

/**
 * What the settings show for saved credentials: the account they belong to (a service
 * account's `client_email`, for example), never the secret.
 */
export const describeCredentials = (credentials: DeployCredentials) => {
  for (const field of ["client_email", "email", "account", "username"]) {
    const value = credentials[field];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
};
