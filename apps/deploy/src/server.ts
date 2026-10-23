import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import type { Publisher } from "./publisher";
import { createRouter } from "./router";

const sameSecret = (given: string | undefined, expected: string) => {
  if (given === undefined) {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * Serves the tRPC API under any path prefix (e.g. TRPC_SERVER_URL=http://deployer:3001/trpc)
 * plus an unauthenticated GET /healthz.
 */
export const createDeployerServer = ({
  publisher,
  token,
}: {
  publisher: Publisher;
  token: string;
}) => {
  const trpc = createHTTPHandler({
    router: createRouter(publisher),
    onError: ({ path, error }) => {
      console.error(`tRPC ${path ?? "?"}: ${error.message}`);
    },
  });

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, ...publisher.status() });
      return;
    }

    // The builder sends the shared token as the raw Authorization header value.
    if (sameSecret(req.headers.authorization, token) === false) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    // Procedure paths are the last segment: /trpc/deployment.publish -> /deployment.publish
    const segments = url.pathname.split("/").filter(Boolean);
    req.url = `/${segments.at(-1) ?? ""}${url.search}`;
    trpc(req, res);
  });
};
