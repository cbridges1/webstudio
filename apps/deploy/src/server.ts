import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { z } from "zod";
import {
  deployPaths,
  publishRequest,
  targetRequest,
} from "@webstudio-is/deploy-protocol";
import type { Publisher } from "./publisher";

const MAX_BODY_BYTES = 1024 * 1024;

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

class BadRequest extends Error {}

const readJson = async <T>(req: IncomingMessage, schema: z.ZodType<T>) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new BadRequest("Request body is too large");
    }
    chunks.push(chunk as Buffer);
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("Request body isn't JSON");
  }
  const parsed = schema.safeParse(json);
  if (parsed.success === false) {
    throw new BadRequest(`Invalid request: ${parsed.error.message}`);
  }
  return parsed.data;
};

/** The deploy API (@webstudio-is/deploy-protocol) plus an unauthenticated GET /healthz. */
export const createDeployerServer = ({
  publisher,
  apiKey,
}: {
  publisher: Publisher;
  apiKey: string;
}) => {
  const routes: Record<string, (req: IncomingMessage) => Promise<unknown>> = {
    [`GET ${deployPaths.hosts}`]: async () => ({
      hosts: publisher.hosts(),
    }),
    [`POST ${deployPaths.validate}`]: async (req) =>
      publisher.validate(await readJson(req, targetRequest)),
    [`POST ${deployPaths.publish}`]: async (req) =>
      publisher.publish(await readJson(req, publishRequest)),
    [`POST ${deployPaths.unpublish}`]: async (req) =>
      publisher.unpublish(await readJson(req, targetRequest)),
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Served under any prefix, e.g. http://proxy/deploy/v1/publish.
    const { pathname } = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && pathname.endsWith(deployPaths.health)) {
      sendJson(res, 200, { ok: true, ...publisher.status() });
      return;
    }

    const [scheme, key] = (req.headers.authorization ?? "").split(" ");
    if (
      scheme !== "Bearer" ||
      key === undefined ||
      sameSecret(key, apiKey) === false
    ) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const route = Object.entries(routes).find(([name]) => {
      const [method, path] = name.split(" ");
      return req.method === method && pathname.endsWith(path);
    });
    if (route === undefined) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    try {
      sendJson(res, 200, await route[1](req));
    } catch (error) {
      if (error instanceof BadRequest) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error(`${route[0]}: ${String(error)}`);
      sendJson(res, 500, { error: "Internal error" });
    }
  });
};
