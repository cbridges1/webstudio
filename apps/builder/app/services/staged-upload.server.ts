import * as path from "node:path";
import { FileStore } from "@tus/file-store";
import { S3Store } from "@tus/s3-store";
import { Server, type DataStore, type Upload } from "@tus/server";
import {
  maxProjectBundleSize,
  stagedUploadPath,
  stagedUploadProjectIdHeader,
} from "@webstudio-is/protocol";
import env from "~/env/env.server";
import { createContext } from "~/shared/context.server";
import { assertProjectBuildPermit as defaultAssertProjectBuildPermit } from "./project-import.server";

const stagedUploadExpiration = 60 * 60 * 1000;
const authTokenHeader = "x-auth-token";
const localUploadDirectory = path.join(process.cwd(), ".webstudio", "uploads");
const s3Env = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET",
] as const;
type StagedUploadStorageEnv = Pick<typeof env, (typeof s3Env)[number]>;

type ReadableDataStore = DataStore & {
  read(
    uploadId: string
  ): NodeJS.ReadableStream | Promise<NodeJS.ReadableStream>;
};

type StagedUploadServerDependencies = {
  assertProjectBuildPermit?: typeof defaultAssertProjectBuildPermit;
  createContext?: typeof createContext;
  datastore?: DataStore;
};

const createStagedUploadStore = (
  environment: StagedUploadStorageEnv = env
): DataStore => {
  const getEnvValue = (name: (typeof s3Env)[number]) => {
    const value = environment[name]?.trim();
    return value === "" ? undefined : value;
  };
  const isS3Configured = s3Env.some((name) => getEnvValue(name) !== undefined);
  if (isS3Configured) {
    const missingEnv = s3Env.filter((name) => getEnvValue(name) === undefined);
    if (missingEnv.length > 0) {
      throw new Error(
        `Staged upload storage is missing required environment variables: ${missingEnv.join(", ")}`
      );
    }
    const endpoint = getEnvValue("S3_ENDPOINT");
    const region = getEnvValue("S3_REGION");
    const accessKeyId = getEnvValue("S3_ACCESS_KEY_ID");
    const secretAccessKey = getEnvValue("S3_SECRET_ACCESS_KEY");
    const bucket = getEnvValue("S3_BUCKET");
    if (
      endpoint === undefined ||
      region === undefined ||
      accessKeyId === undefined ||
      secretAccessKey === undefined ||
      bucket === undefined
    ) {
      throw new Error("Staged upload storage is not configured.");
    }
    return new S3Store({
      expirationPeriodInMilliseconds: stagedUploadExpiration,
      partSize: 8 * 1024 * 1024,
      useTags: false,
      s3ClientConfig: {
        endpoint,
        region,
        bucket,
        // selfhost: path-style URLs (<endpoint>/<bucket>/<key>), as the asset uploader
        // uses. S3-compatible stores such as RustFS don't serve <bucket>.<endpoint>.
        forcePathStyle: true,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      },
    });
  }

  return new FileStore({
    directory: localUploadDirectory,
    expirationPeriodInMilliseconds: stagedUploadExpiration,
  });
};

const assertUploadProject = (upload: Upload, projectId: string) => {
  if (upload.metadata?.projectId !== projectId) {
    throw new Error("Staged upload does not belong to this project.");
  }
};

const getRequiredHeader = (request: Request, name: string, label: string) => {
  const value = request.headers.get(name)?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${label} is required.`);
  }
  return value;
};

const getUploadProjectId = (request: Request) =>
  getRequiredHeader(request, stagedUploadProjectIdHeader, "Project id");

const assertAuthorizedUploadRequest = async (
  request: Request,
  {
    assertProjectBuildPermit = defaultAssertProjectBuildPermit,
    createContext: createRequestContext = createContext,
  }: StagedUploadServerDependencies
) => {
  getRequiredHeader(request, authTokenHeader, "Auth token");

  const projectId = getUploadProjectId(request);
  const context = await createRequestContext(request);
  await assertProjectBuildPermit({ ctx: context, projectId });
};

const createStagedUploadServer = (
  dependencies: StagedUploadServerDependencies = {}
) =>
  new Server({
    path: stagedUploadPath,
    datastore: dependencies.datastore ?? createStagedUploadStore(),
    maxSize: maxProjectBundleSize,
    relativeLocation: true,
    respectForwardedHeaders: true,
    allowedHeaders: [authTokenHeader, stagedUploadProjectIdHeader],
    async onIncomingRequest(request) {
      await assertAuthorizedUploadRequest(
        request as unknown as Request,
        dependencies
      );
    },
    async onUploadCreate(request, upload) {
      const projectId = getUploadProjectId(request as unknown as Request);
      if (upload.metadata?.projectId !== projectId) {
        throw new Error("Upload project id does not match request project id.");
      }
      return { metadata: { ...upload.metadata, projectId } };
    },
  });

const stagedUploadServer = createStagedUploadServer();

export const handleStagedUploadRequest = async (request: Request) => {
  return await stagedUploadServer.handleWeb(request);
};

const readText = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

export const readStagedUploadText = async ({
  projectId,
  uploadId,
}: {
  projectId: string;
  uploadId: string;
}) => {
  const datastore = stagedUploadServer.datastore as ReadableDataStore;
  const upload = await datastore.getUpload(uploadId);
  assertUploadProject(upload, projectId);
  return await readText(await datastore.read(uploadId));
};

/**
 * selfhost: removes a staged upload. S3Store.remove aborts the multipart upload first, which
 * S3 (and RustFS) answers with NoSuchUpload once the upload has completed; @tus/s3-store's
 * check for that never matches the SDK's error, so it threw before deleting the objects and
 * every import left its bundle in the bucket. Delete the objects directly in that case.
 */
const removeUpload = async (datastore: DataStore, uploadId: string) => {
  try {
    await datastore.remove(uploadId);
  } catch (error) {
    if (
      datastore instanceof S3Store &&
      (error as { Code?: string } | undefined)?.Code === "NoSuchUpload"
    ) {
      const { client, bucket } = datastore as unknown as {
        client: { deleteObjects: (input: unknown) => Promise<unknown> };
        bucket: string;
      };
      await client.deleteObjects({
        Bucket: bucket,
        Delete: {
          Objects: [{ Key: uploadId }, { Key: `${uploadId}.info` }],
        },
      });
      return;
    }
    throw error;
  }
};

export const removeStagedUpload = async (uploadId: string) => {
  await removeUpload(stagedUploadServer.datastore, uploadId);
};

export const __testing__ = {
  createStagedUploadStore,
  removeUpload,
  createStagedUploadServer,
};
