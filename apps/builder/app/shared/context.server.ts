import { type AppContext } from "@webstudio-is/trpc-interface/index.server";
import env from "~/env/env.server";
import { authenticator } from "~/services/auth.server";
import { trpcSharedClient } from "~/services/trpc.server";
import { entryApi } from "./entri/entri-api.server";

import { defaultPlanFeatures } from "@webstudio-is/plans";
import {
  getPlanInfo,
  getAuthorizationOwnerId,
} from "@webstudio-is/plans/index.server";
import { staticEnv } from "~/env/env.static.server";
import {
  authorizationToken,
  eq,
  getDb,
  project,
  type Db,
} from "@webstudio-is/db";
import { builderAuthenticator } from "~/services/builder-auth.server";
import { readLoginSessionBloomFilter } from "~/services/session.server";
import type { BloomFilter } from "~/services/bloom-filter.server";
import { isBuilder, isCanvas } from "./router-utils";
import { createDeploymentClient } from "~/services/deployers.server";
import {
  isPublishToken,
  verifyPublishToken,
} from "~/services/publish-token.server";
import { parseBuilderUrl } from "@webstudio-is/protocol";
import {
  apiClient,
  apiClientHeader,
  apiClientContractVersionHeader,
  apiClientVersionHeader,
} from "@webstudio-is/trpc-interface/api-compatibility";

export const extractAuthFromRequest = async (request: Request) => {
  if (isCanvas(request)) {
    throw new Error("Canvas requests can't have authorization context");
  }
  const url = new URL(request.url);

  const authToken =
    url.searchParams.get("authToken") ??
    request.headers.get("x-auth-token") ??
    undefined;

  const authorizationHeader = request.headers.get("Authorization");
  // selfhost: a deployer syncing a build sends the publish token it was given.
  const publishToken = isPublishToken(authorizationHeader)
    ? verifyPublishToken(authorizationHeader)
    : undefined;
  const isServiceCall =
    publishToken !== undefined || isServiceAuthorization(authorizationHeader);

  // Explicit credentials always win. In particular, an invalid supplied token
  // must fail during context creation instead of falling back to a potentially
  // more privileged browser session.
  const sessionData =
    authToken === undefined && isServiceCall === false
      ? isBuilder(request)
        ? await builderAuthenticator.isAuthenticated(request)
        : await authenticator.isAuthenticated(request)
      : undefined;

  return {
    authToken,
    isServiceCall,
    serviceProjectId: publishToken?.projectId,
    sessionData,
  };
};

/**
 * selfhost: the builder's own service token or a deployer's publish token. Either way the
 * request carries no cookies, so it skips CSRF checks.
 */
export const isServiceRequestAuthorization = (
  authorizationHeader: string | null
) =>
  isServiceAuthorization(authorizationHeader) ||
  (isPublishToken(authorizationHeader) &&
    verifyPublishToken(authorizationHeader) !== undefined);

export const isServiceAuthorization = (authorizationHeader: string | null) => {
  return (
    authorizationHeader != null &&
    env.TRPC_SERVER_API_TOKEN !== undefined &&
    env.TRPC_SERVER_API_TOKEN.length > 0 &&
    authorizationHeader === env.TRPC_SERVER_API_TOKEN
  );
};

const createTokenAuthorizationContext = async (authToken: string, db: Db) => {
  const rows = await db
    .select({ projectId: project.id, userId: project.userId })
    .from(authorizationToken)
    .innerJoin(project, eq(project.id, authorizationToken.projectId))
    .where(eq(authorizationToken.token, authToken));

  if (rows.length !== 1) {
    throw new Error(`Project owner can't be found for token ${authToken}`);
  }

  const ownerId = rows[0].userId;
  if (ownerId === null) {
    throw new Error(`Project ${rows[0].projectId} has null userId`);
  }

  return {
    type: "token" as const,
    authToken,
    ownerId,
  };
};

const createAuthorizationContext = async (
  request: Request,
  db: Db
): Promise<AppContext["authorization"]> => {
  const { authToken, isServiceCall, serviceProjectId, sessionData } =
    await extractAuthFromRequest(request);

  if (isServiceCall) {
    return {
      type: "service",
      isServiceCall: true,
      projectId: serviceProjectId,
    };
  }

  if (authToken != null) {
    return await createTokenAuthorizationContext(authToken, db);
  }

  if (sessionData?.userId != null) {
    const userId = sessionData.userId;

    let loginBloomFilter: BloomFilter | undefined = undefined;

    let isLoggedInToBuilder = async (projectId: string) => {
      if (loginBloomFilter === undefined) {
        loginBloomFilter = await readLoginSessionBloomFilter(request);
      }

      return loginBloomFilter.has(projectId);
    };

    if (isBuilder(request)) {
      isLoggedInToBuilder = async (projectId: string) => {
        const parsedUrl = parseBuilderUrl(request.url);
        return parsedUrl.projectId === projectId;
      };
    }

    return {
      type: "user",
      userId,
      sessionCreatedAt: sessionData.createdAt,
      isLoggedInToBuilder,
    };
  }

  return { type: "anonymous" };
};

const createDomainContext = () => {
  const context: AppContext["domain"] = {
    domainTrpc: trpcSharedClient.domain,
  };

  return context;
};

const getRequestOrigin = (urlStr: string) => {
  const url = new URL(urlStr);

  return url.origin;
};

const createDeploymentContext = (requestUrl: string, db: Db) => {
  const context: AppContext["deployment"] = {
    // selfhost: deployers reach the builder at its main origin, not a project subdomain.
    deployments: createDeploymentClient({
      db,
      builderOrigin: parseBuilderUrl(requestUrl).sourceOrigin,
    }),
    env: {
      BUILDER_ORIGIN: getRequestOrigin(requestUrl),
      GITHUB_REF_NAME: staticEnv.GITHUB_REF_NAME ?? "undefined",
      GITHUB_SHA: staticEnv.GITHUB_SHA ?? undefined,
      PUBLISHER_HOST: env.PUBLISHER_HOST,
    },
  };

  return context;
};

const createEntriContext = () => {
  return {
    entryApi,
  };
};

const createTrpcCache = () => {
  const proceduresMaxAge = new Map<string, number>();
  const setMaxAge = (path: string, value: number) => {
    proceduresMaxAge.set(
      path,
      Math.min(proceduresMaxAge.get(path) ?? Number.MAX_SAFE_INTEGER, value)
    );
  };

  const getMaxAge = (path: string) => proceduresMaxAge.get(path);

  return {
    setMaxAge,
    getMaxAge,
  };
};

const createApiClientContext = (request: Request): AppContext["apiClient"] => {
  const client = apiClient.safeParse(request.headers.get(apiClientHeader));
  if (client.success === false) {
    return {
      type: "unknown",
      version: undefined,
      contractVersion: undefined,
    };
  }

  return {
    type: client.data,
    version: request.headers.get(apiClientVersionHeader) ?? undefined,
    contractVersion:
      request.headers.get(apiClientContractVersionHeader) ?? undefined,
  };
};

/** The process-wide database connection pool. */
export const createDbContext = (): Db => getDb(env.DATABASE_URL);

/**
 * argument buildEnv==="prod" only if we are loading project with production build
 */
export const createContext = async (request: Request): Promise<AppContext> => {
  const db = createDbContext();
  const authorization = await createAuthorizationContext(request, db);

  const resolvePlanInfo = async (auth: AppContext["authorization"]) => {
    const ownerId = getAuthorizationOwnerId(auth);
    if (ownerId === undefined) {
      return {
        planFeatures: defaultPlanFeatures,
        purchases: [] as AppContext["purchases"],
      };
    }
    return (
      (await getPlanInfo([ownerId], { db })).get(ownerId) ?? {
        planFeatures: defaultPlanFeatures,
        purchases: [] as AppContext["purchases"],
      }
    );
  };

  const domain = createDomainContext();
  const deployment = createDeploymentContext(request.url, db);
  const entri = createEntriContext();
  const { planFeatures, purchases } = await resolvePlanInfo(authorization);
  const trpcCache = createTrpcCache();
  const apiClient = createApiClientContext(request);

  const getOwnerPlanFeatures = async (userId: string) => {
    const results = await getPlanInfo([userId], { db });
    return results.get(userId)?.planFeatures ?? defaultPlanFeatures;
  };

  const createTokenContext = async (authToken: string) => {
    const authorization = await createTokenAuthorizationContext(authToken, db);

    const { planFeatures, purchases } = await resolvePlanInfo(authorization);

    return {
      authorization,
      domain,
      deployment,
      entri,
      planFeatures,
      purchases,
      apiClient,
      trpcCache,
      db,
      createTokenContext,
      getOwnerPlanFeatures,
    };
  };

  return {
    authorization,
    domain,
    deployment,
    entri,
    planFeatures,
    purchases,
    apiClient,
    trpcCache,
    db,
    createTokenContext,
    getOwnerPlanFeatures,
  };
};
