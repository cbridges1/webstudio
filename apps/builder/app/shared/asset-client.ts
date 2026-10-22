import * as path from "node:path";
import { Readable } from "node:stream";
import { createReadableStreamFromReadable } from "@remix-run/node";
import { maxSize } from "@webstudio-is/asset-uploader";
import {
  createFsAssetObjectStore,
  createS3AssetObjectStore,
} from "@webstudio-is/asset-uploader/server";
import env from "~/env/env.server";

export const fileUploadPath = "public/cgi/asset";

export const getMaxAssetUploadSize = () => maxSize.parse(env.MAX_UPLOAD_SIZE);

export const createAssetClient = () => {
  const maxUploadSize = getMaxAssetUploadSize();
  // Empty values count as unset, as in staged-upload.server.ts.
  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  const region = env.S3_REGION?.trim() || undefined;
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim() || undefined;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() || undefined;
  const bucket = env.S3_BUCKET?.trim() || undefined;
  if (
    endpoint !== undefined &&
    region !== undefined &&
    accessKeyId !== undefined &&
    secretAccessKey !== undefined &&
    bucket !== undefined
  ) {
    return createS3AssetObjectStore({
      endpoint,
      region,
      accessKeyId,
      secretAccessKey,
      bucket,
      acl: env.S3_ACL,
      maxUploadSize,
    });
  } else {
    return createFsAssetObjectStore({
      maxUploadSize,
      fileDirectory: path.join(process.cwd(), fileUploadPath),
    });
  }
};

/**
 * selfhost: reads a stored asset from the configured store (S3-compatible storage such as
 * RustFS, or local files) for the /cgi routes; undefined when it can't be read. Upstream's
 * routes read only local files when RESIZE_ORIGIN is unset, so assets in S3 never loaded.
 */
export const readStoredAsset = async (name: string) => {
  try {
    const { data, contentLength } = await createAssetClient().readFile(name);
    return {
      body: createReadableStreamFromReadable(Readable.from(data)),
      contentLength,
    };
  } catch {
    return;
  }
};
