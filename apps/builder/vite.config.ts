import path, { resolve } from "node:path";
import { defineConfig, loadEnv, type CorsOptions } from "vite";
import { vitePlugin as remix } from "@remix-run/dev";
import { vercelPreset } from "@vercel/remix/vite";
import type { IncomingMessage } from "node:http";
import pc from "picocolors";

import {
  getAuthorizationServerOrigin,
  isBuilderUrl,
} from "./app/shared/router-utils/origins";
import { existsSync } from "node:fs";
import fg from "fast-glob";
import { createProjectPathsMiddleware } from "./project-paths.mjs";

const rootDir = ["..", "../..", "../../.."]
  .map((dir) => path.join(__dirname, dir))
  .find((dir) => existsSync(path.join(dir, ".git")));

const hasPrivateFolders =
  fg.sync([path.join(rootDir ?? "", "packages/*/private-src/*")], {
    ignore: ["**/node_modules/**"],
  }).length > 0;

const conditions = hasPrivateFolders
  ? ["webstudio-private", "webstudio"]
  : ["webstudio"];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const multiplayerRelayProxyTarget =
    process.env.COLLAB_RELAY_PROXY_TARGET ??
    env.COLLAB_RELAY_PROXY_TARGET ??
    "http://127.0.0.1:1999";

  return {
    plugins: [
      remix({
        // selfhost: Vercel's build layout only on Vercel; elsewhere a plain Remix server
        // build that `remix-serve build/server/index.js` runs (the Docker image).
        presets: process.env.VERCEL ? [vercelPreset()] : [],
        future: {
          v3_lazyRouteDiscovery: false,
          v3_relativeSplatPath: false,
          v3_singleFetch: false,
          v3_fetcherPersist: false,
          v3_throwAbortReason: false,
        },
      }),
      {
        name: "request-timing-logger",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            // Some dev proxies can forward HTTP/2 pseudo-headers such as
            // ":method". Remix converts Node headers to Fetch Headers, where
            // those names are invalid and crash before the request reaches app
            // code. Vite still needs a normal req.url, so preserve ":path"
            // before removing the pseudo-headers.
            if (req.url === undefined) {
              const path = req.headers[":path"];
              if (typeof path === "string") {
                req.url = path;
              }
            }
            for (const header of Object.keys(req.headers)) {
              if (header.startsWith(":")) {
                delete req.headers[header];
              }
            }
            // Pre-bundled dep chunks must never be served from a stale browser
            // cache. Vite uses ?v= to bust the cache, but some browsers (or
            // service workers) still serve cached chunks with old hashes,
            // causing duplicate-React errors during hydration. no-store removes
            // the files from the browser cache entirely.
            if (req.url?.includes("/node_modules/.vite/deps/")) {
              res.setHeader("Cache-Control", "no-store");
            }
            const start = Date.now();
            res.on("finish", () => {
              const duration = Date.now() - start;
              if (
                !(
                  req.url?.startsWith("/@") ||
                  req.url?.startsWith("/app") ||
                  req.url?.includes("/node_modules")
                )
              ) {
                console.info(
                  `[${req.method}] ${req.url} - ${duration}ms : ${pc.dim(req.headers.host)}`
                );
              }
            });
            next();
          });
          // selfhost: /p/<projectId>/ project paths, as server.mjs serves them in production.
          server.middlewares.use(createProjectPathsMiddleware());
        },
      },
    ],
    resolve: {
      conditions: [...conditions, "browser", "development|production"],
      alias: [
        {
          find: "~",
          replacement: resolve("app"),
        },

        // rolldown resolves tslib to its CJS build (our resolve.conditions
        // omit "module") and the generated interop leaves `default`
        // undefined, crashing the server bundle at boot. Point it at the
        // ESM build instead.
        {
          find: /^tslib$/,
          replacement: "tslib/tslib.es6.mjs",
        },
      ],
    },
    ssr: {
      resolve: {
        conditions: [...conditions, "node", "development|production"],
      },
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify(mode),
    },
    build: {
      commonjsOptions: {
        esmExternals: true,
      },
    },
    server: {
      // Plain HTTP on localhost; domains and HTTPS belong to the deployment.
      host: "localhost",
      proxy: {
        "/collab-relay": {
          target: multiplayerRelayProxyTarget,
          ws: true,
        },
      },
      cors: ((
        req: IncomingMessage,
        callback: (error: Error | null, options: CorsOptions | null) => void
      ) => {
        // Handle CORS preflight requests in development to mimic Remix production behavior
        if (req.method === "OPTIONS" || req.method === "POST") {
          if (req.headers.origin != null && req.url != null) {
            const url = new URL(req.url, `http://${req.headers.host}`);

            // Allow CORS for /builder-logout path when requested from the authorization server
            if (url.pathname === "/builder-logout" && isBuilderUrl(url.href)) {
              return callback(null, {
                origin: getAuthorizationServerOrigin(url.href),
                preflightContinue: false,
                credentials: true,
              });
            }
          }

          if (req.method === "OPTIONS") {
            // Respond with method not allowed for other preflight requests
            return callback(null, {
              preflightContinue: false,
              optionsSuccessStatus: 405,
            });
          }
        }

        // Disable CORS for all other requests
        return callback(null, {
          origin: false,
        });
      }) as never,
    },
    envPrefix: ["GITHUB_", "PUBLIC_"],
  };
});
