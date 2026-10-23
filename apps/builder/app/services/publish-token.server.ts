// selfhost: the token the builder hands a deploy service with each publish. It lets the
// service download that project's builds (`webstudio sync`) and report the publish back,
// nothing else, so the service needs no builder secret of its own.
//
// Format: `wsdeploy.<base64url payload>.<base64url HMAC-SHA256>`, signed with a key derived
// from AUTH_SECRET. Stateless: it expires instead of being revoked.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import env from "~/env/env.server";

const PREFIX = "wsdeploy";
// Long enough for a queued job plus its retries.
const LIFETIME_MS = 2 * 60 * 60 * 1000;

const payloadSchema = z.object({
  projectId: z.string(),
  buildId: z.string(),
  expiresAt: z.number(),
});

export type PublishTokenPayload = z.infer<typeof payloadSchema>;

const signingKey = () => {
  const secret = env.AUTH_SECRET || env.BETTER_AUTH_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error("AUTH_SECRET must be set to publish through a deployer");
  }
  return createHmac("sha256", secret).update("webstudio-deploy-token").digest();
};

const sign = (key: Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest("base64url");

export const createPublishToken = (
  { projectId, buildId }: { projectId: string; buildId: string },
  { now = Date.now(), key = signingKey() } = {}
) => {
  const payload = Buffer.from(
    JSON.stringify({ projectId, buildId, expiresAt: now + LIFETIME_MS })
  ).toString("base64url");
  return `${PREFIX}.${payload}.${sign(key, payload)}`;
};

/** The token's payload, or undefined when it isn't a valid, unexpired publish token. */
export const verifyPublishToken = (
  token: string | null | undefined,
  { now = Date.now(), key }: { now?: number; key?: Buffer } = {}
): PublishTokenPayload | undefined => {
  const [prefix, payload, signature, ...rest] = token?.split(".") ?? [];
  if (
    prefix !== PREFIX ||
    payload === undefined ||
    signature === undefined ||
    rest.length > 0
  ) {
    return;
  }
  const expected = Buffer.from(sign(key ?? signingKey(), payload));
  const given = Buffer.from(signature);
  if (
    expected.length !== given.length ||
    timingSafeEqual(expected, given) === false
  ) {
    return;
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return;
  }
  const parsed = payloadSchema.safeParse(json);
  if (parsed.success === false || parsed.data.expiresAt < now) {
    return;
  }
  return parsed.data;
};

export const isPublishToken = (token: string | null | undefined) =>
  token?.startsWith(`${PREFIX}.`) === true;
