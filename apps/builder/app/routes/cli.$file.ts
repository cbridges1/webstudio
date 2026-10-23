// selfhost: GET /cli/webstudio.json names this builder's CLI package; GET
// /cli/webstudio-<hash>.tgz downloads it (cli-package.server.ts). Public: the CLI holds no
// secrets, and agents fetch it with npx before they have any credentials.
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { parseBuilderUrl } from "@webstudio-is/protocol";
import {
  cliPackageFileName,
  cliPackageUrl,
  loadCliPackage,
} from "~/services/cli-package.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const cliPackage = await loadCliPackage();
  if (cliPackage === undefined) {
    return json(
      { error: "This builder doesn't serve a CLI package." },
      { status: 404 }
    );
  }

  if (params.file === "webstudio.json") {
    const { sourceOrigin } = parseBuilderUrl(request.url);
    return json(
      { package: cliPackageUrl(sourceOrigin, cliPackage.hash) },
      { headers: { "Cache-Control": "no-cache" } }
    );
  }

  if (params.file === cliPackageFileName(cliPackage.hash)) {
    return new Response(
      Readable.toWeb(createReadStream(cliPackage.path)) as ReadableStream,
      {
        headers: {
          "Content-Type": "application/gzip",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      }
    );
  }

  return json({ error: "Not found" }, { status: 404 });
};
