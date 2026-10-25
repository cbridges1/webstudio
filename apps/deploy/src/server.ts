// GET /healthz, and POST /wake: look for queued jobs now. The builder can call /wake (its
// wake URL) whenever it queues a job, e.g. to start this service on a platform that stops it
// when idle; a running service picks jobs up from LISTEN/NOTIFY anyway. Waking only makes it
// read the queue, so it needs no secret; set DEPLOY_WAKE_TOKEN to require one regardless.
// Served under any prefix, e.g. http://proxy/deploy/wake.
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { deployPaths } from "@webstudio-is/deploy-protocol";

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export const createDeployerServer = ({
  wake,
  status,
  wakeToken,
}: {
  wake: () => void;
  status: () => Record<string, unknown>;
  wakeToken?: string;
}) =>
  createServer((req: IncomingMessage, res: ServerResponse) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    // Requests carry no body we need.
    req.resume();

    if (req.method === "GET" && pathname.endsWith(deployPaths.health)) {
      sendJson(res, 200, { ok: true, ...status() });
      return;
    }

    if (req.method === "POST" && pathname.endsWith(deployPaths.wake)) {
      if (wakeToken !== undefined) {
        const [scheme, token] = (req.headers.authorization ?? "").split(" ");
        if (
          scheme !== "Bearer" ||
          token === undefined ||
          sameSecret(token, wakeToken) === false
        ) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
      }
      wake();
      sendJson(res, 202, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });
