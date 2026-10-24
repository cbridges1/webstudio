// selfhost: downloads a static site that Export built (static-export.server.ts), for people
// who can edit its project.
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { authorizeProject } from "@webstudio-is/trpc-interface/index.server";
import { createContext } from "~/shared/context.server";
import { privateNoStoreResponseHeaders } from "~/services/cache-control.server";
import {
  loadStaticExportProject,
  parseStaticExportName,
  staticExportPath,
} from "~/services/static-export.server";

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: privateNoStoreResponseHeaders,
  });

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const buildId = parseStaticExportName(params.name ?? "");
  if (buildId === undefined) {
    return notFound();
  }
  const context = await createContext(request);
  const exported = await loadStaticExportProject(buildId, context.db);
  if (
    exported === undefined ||
    (await authorizeProject.hasProjectPermit(
      { projectId: exported.projectId, permit: "edit" },
      context
    )) === false
  ) {
    return notFound();
  }
  const path = staticExportPath(buildId);
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) {
    return notFound();
  }
  return new Response(
    Readable.toWeb(createReadStream(path)) as ReadableStream,
    {
      headers: {
        ...privateNoStoreResponseHeaders,
        "Content-Type": "application/zip",
        "Content-Length": String(info.size),
        "Content-Disposition": `attachment; filename="${exported.domain}.zip"`,
      },
    }
  );
};
