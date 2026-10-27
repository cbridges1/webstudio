// selfhost: the production server (npm start, the Docker image). What remix-serve does (static
// files, compression, the Remix handler), plus project paths (project-paths.mjs) in front:
// projects open at /p/<projectId>/.
//
//   node server.mjs [build/server/index.js]
//
// PORT (default 3000) and HOST (default all interfaces) choose where it listens.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequestHandler } from "@remix-run/express";
import { installGlobals } from "@remix-run/node";
import compression from "compression";
import express from "express";
import { createProjectPathsMiddleware } from "./project-paths.mjs";

process.env.NODE_ENV = process.env.NODE_ENV ?? "production";

const buildPath = resolve(process.argv[2] ?? "build/server/index.js");
const build = await import(pathToFileURL(buildPath).href);
installGlobals({ nativeFetch: build.future.v3_singleFetch });

const app = express();
app.disable("x-powered-by");
app.use(compression());
// Before the static files, so /p/<id>/favicon.ico finds public/favicon.ico.
app.use(createProjectPathsMiddleware());
app.use(
  build.publicPath,
  express.static(build.assetsBuildDirectory, { immutable: true, maxAge: "1y" })
);
app.use(express.static("public", { maxAge: "1h" }));
app.all("*", createRequestHandler({ build, mode: process.env.NODE_ENV }));

const port = Number(process.env.PORT ?? 3000);
const onListen = () => console.info(`Builder listening on port ${port}`);
const server = process.env.HOST
  ? app.listen(port, process.env.HOST, onListen)
  : app.listen(port, onListen);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close(console.error));
}
