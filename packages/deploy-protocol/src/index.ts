// selfhost: the HTTP API between the builder and a deploy service (apps/deploy).
//
// A deploy service knows nothing about the builder or its projects. Workspace admins add
// deploy services in the builder (URL and API key); each project picks one and a target on
// it. On Publish the builder sends the build ID, its own address, a token scoped to the
// project and the target. The deploy service downloads the build with the token, deploys
// it and reports the result back to the builder.
//
// Each project's host credentials are entered in the builder and stored encrypted in the
// builder's database (ProjectDeployTarget.credentials, see ./credentials). They never travel
// in requests: requests name the project, and the deploy service reads and decrypts them from
// that database with DEPLOY_CREDENTIALS_KEY. It keeps them in memory for the job only and
// never logs, stores or returns them.
//
// Builder -> deploy service: `Authorization: Bearer <deploy service API key>`.
// Deploy service -> builder: `Authorization: <token from the publish request>`.
import { z } from "zod";

/** A host's credentials, e.g. a Firebase service account key. A secret. */
export const deployCredentials = z.record(z.string(), z.unknown());
export type DeployCredentials = z.infer<typeof deployCredentials>;

/** Where a project deploys: a host on the deploy service and that host's settings. */
export const deployTarget = z.object({
  host: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
});
export type DeployTarget = z.infer<typeof deployTarget>;

export const deployResult = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: z.string() }),
]);
export type DeployResult = z.infer<typeof deployResult>;

export const hostInfo = z.object({
  id: z.string(),
  label: z.string(),
  /** JSON Schema of the host's `config`. */
  config: z.record(z.string(), z.unknown()),
  /** JSON Schema of the host's credentials, or null when it needs none. */
  credentials: z.record(z.string(), z.unknown()).nullable(),
});
export type HostInfo = z.infer<typeof hostInfo>;

export const hostsResponse = z.object({ hosts: z.array(hostInfo) });

export const publishRequest = z.object({
  /** Whose saved credentials the host uses. */
  projectId: z.string().min(1),
  buildId: z.string().min(1),
  builder: z.object({
    /** Where the deploy service downloads the build and reports the result. */
    origin: z.string().url(),
    /** Read access to the project, and permission to report this publish. */
    token: z.string().min(1),
  }),
  target: deployTarget,
  /** For the deploy service's logs only. */
  label: z.string().optional(),
});
export type PublishRequest = z.infer<typeof publishRequest>;

export const targetRequest = z.object({
  /** Whose saved credentials the host uses. */
  projectId: z.string().min(1),
  target: deployTarget,
});
export type TargetRequest = z.infer<typeof targetRequest>;

/** Sent by the deploy service when a publish finishes. */
export const deployReport = z.discriminatedUnion("status", [
  z.object({ status: z.literal("PUBLISHED"), url: z.string().url() }),
  z.object({ status: z.literal("FAILED"), error: z.string() }),
]);
export type DeployReport = z.infer<typeof deployReport>;

export const deployPaths = {
  health: "/healthz",
  hosts: "/v1/hosts",
  validate: "/v1/validate",
  publish: "/v1/publish",
  unpublish: "/v1/unpublish",
} as const;

/** The builder's endpoint for reports, relative to `builder.origin`. */
export const deployReportPath = (buildId: string) =>
  `/rest/deployments/${encodeURIComponent(buildId)}`;

const describeError = (error: unknown) =>
  error instanceof Error
    ? error.cause instanceof Error
      ? `${error.message} (${error.cause.message})`
      : error.message
    : String(error);

/** Calls a deploy service. Failures come back as `{ success: false }`, never thrown. */
export const createDeployServiceClient = ({
  url,
  apiKey,
  fetch: request = globalThis.fetch,
  timeoutMs = 30_000,
}: {
  url: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}) => {
  const base = url.replace(/\/+$/, "");

  const call = async <T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown
  ): Promise<
    { success: true; data: T } | { success: false; error: string }
  > => {
    let response: Response;
    try {
      response = await request(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        success: false,
        error: `Can't reach the deploy service at ${base}: ${describeError(
          error
        )}`,
      };
    }
    if (response.status === 401) {
      return {
        success: false,
        error: "The deploy service rejected its API key",
      };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return {
        success: false,
        error: `The deploy service answered ${response.status} without JSON`,
      };
    }
    const parsed = schema.safeParse(json);
    if (parsed.success === false) {
      const message =
        typeof json === "object" &&
        json !== null &&
        "error" in json &&
        typeof json.error === "string"
          ? json.error
          : `unexpected response (${response.status})`;
      return { success: false, error: `Deploy service: ${message}` };
    }
    return { success: true, data: parsed.data };
  };

  const result = async (path: string, body: unknown): Promise<DeployResult> => {
    const response = await call(path, deployResult, body);
    return response.success ? response.data : response;
  };

  return {
    hosts: () => call(deployPaths.hosts, hostsResponse),
    validate: (input: TargetRequest) => result(deployPaths.validate, input),
    publish: (input: PublishRequest) => result(deployPaths.publish, input),
    unpublish: (input: TargetRequest) => result(deployPaths.unpublish, input),
  };
};

export type DeployServiceClient = ReturnType<typeof createDeployServiceClient>;
