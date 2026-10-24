// Access tokens for a Google service account (JWT bearer grant), without google-auth-library.
import { createSign } from "node:crypto";
import { z } from "zod";

export const serviceAccountSchema = z
  .object({
    client_email: z.string().email(),
    private_key: z.string().min(1),
    token_uri: z.string().url().default("https://oauth2.googleapis.com/token"),
    // In every JSON key; the Firebase host creates missing sites in this project.
    project_id: z.string().min(1).optional(),
  })
  .describe(
    "A service account's JSON key (Google Cloud console → IAM → Service accounts → Keys) with the Firebase Hosting Admin role"
  );

export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

const base64url = (input: string | Buffer) =>
  (typeof input === "string" ? Buffer.from(input) : input).toString(
    "base64url"
  );

export const createAssertion = (
  account: ServiceAccount,
  scopes: string[],
  now = Math.floor(Date.now() / 1000)
) => {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: scopes.join(" "),
      aud: account.token_uri,
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(account.private_key))}`;
};

export const getAccessToken = async (
  account: ServiceAccount,
  scopes: string[],
  fetchImpl: typeof fetch = fetch
) => {
  const response = await fetchImpl(account.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: createAssertion(account, scopes),
    }),
  });
  const body = (await response.json()) as {
    access_token?: string;
    error_description?: string;
  };
  if (response.ok === false || body.access_token === undefined) {
    throw new Error(
      `Google token request failed (${response.status}): ${
        body.error_description ?? "no access token"
      }`
    );
  }
  return body.access_token;
};
