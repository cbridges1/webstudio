import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  getMimeTypeByFilename,
  getFileExtension,
  isAllowedExtension,
  decodePathFragment,
} from "@webstudio-is/sdk";
import { readStoredAsset } from "~/shared/asset-client";

// This route serves generic assets without processing
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const basePath = `/cgi/asset/`;

  const url = new URL(request.url);
  const name = decodePathFragment(url.pathname.slice(basePath.length));

  // Allow direct asset access, and from the same origin
  const refererRawUrl = request.headers.get("referer");
  const refererUrl = refererRawUrl === null ? url : new URL(refererRawUrl);
  if (refererUrl.host !== url.host) {
    throw new Response("Forbidden", {
      status: 403,
    });
  }

  // Support absolute urls locally
  if (URL.canParse(name)) {
    return fetch(name);
  }

  // Validate file extension against allowed types
  const extension = getFileExtension(name)?.toLowerCase();
  const contentType = getMimeTypeByFilename(name);

  // Reject files with disallowed extensions or MIME types
  if (
    contentType === "application/octet-stream" ||
    !extension ||
    !isAllowedExtension(extension)
  ) {
    throw new Response("File type not allowed", {
      status: 403,
    });
  }

  const stored = await readStoredAsset(name);

  if (stored === undefined) {
    throw new Response("Not found", {
      status: 404,
    });
  }

  return new Response(stored.body, {
    headers: {
      "content-type": contentType,
      "Access-Control-Allow-Origin": url.origin,
    },
  });
};
