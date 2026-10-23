import type { TrpcInterfaceClient } from "../shared/shared-router";
import type { Db } from "@webstudio-is/db";
import type { PlanFeatures, Purchase } from "@webstudio-is/plans";
import type { ApiClient } from "../api-compatibility";

/**
 * All necessary parameters for Authorization
 */
type AuthorizationContext =
  | {
      type: "user";
      /**
       * userId of the current authenticated user
       */
      userId: string;
      sessionCreatedAt: number;
      /**
       * Has projectId in the tracked sessions
       */
      isLoggedInToBuilder: (projectId: string) => Promise<boolean>;
    }
  | {
      type: "token";
      /**
       * token URLSearchParams or hostname
       */
      authToken: string;

      /**
       * In case of authToken, this is the ownerId of the project
       */
      ownerId: string;
    }
  | {
      type: "service";
      /**
       * Allow service 2 service communications to skip authorization for view calls
       */
      isServiceCall: boolean;
      /**
       * selfhost: set for a deployer's publish token, which can view only this project.
       * Unset: the builder's own TRPC_SERVER_API_TOKEN.
       */
      projectId?: string;
    }
  | {
      type: "anonymous";
    };

type DomainContext = {
  domainTrpc: TrpcInterfaceClient["domain"];
};

// https://developers.entri.com/docs/install
type EntriContext = {
  entryApi: {
    getEntriToken: () => Promise<{
      token: string;
      applicationId: string;
    }>;
  };
};

type DeployResult = { success: true } | { success: false; error: string };

/**
 * selfhost: sends publishes to the deployer the project's deploy target names (set in
 * the project's settings). Implemented by the builder (deployers.server.ts).
 */
export type DeploymentClient = {
  /** Fails right away when the project has no usable target or the deployer refuses. */
  publish(input: {
    projectId: string;
    buildId: string;
    label: string;
  }): Promise<DeployResult>;
  /** Removes the project's site from its host. */
  unpublish(input: { projectId: string }): Promise<DeployResult>;
};

type DeploymentContext = {
  deployments: DeploymentClient;
  env: {
    BUILDER_ORIGIN: string;
    GITHUB_REF_NAME: string;
    GITHUB_SHA: string | undefined;
    PUBLISHER_HOST: string;
  };
};

type TrpcCache = {
  setMaxAge: (path: string, value: number) => void;
  getMaxAge: (path: string) => number | undefined;
};

type ApiClientContext =
  | {
      type: ApiClient;
      version: string | undefined;
      contractVersion?: string;
    }
  | {
      type: "unknown";
      version: undefined;
      contractVersion?: undefined;
    };

/**
 * AppContext is a global context that is passed to all trpc/api queries/mutations
 * "authorization" is made inside the namespace because eventually there will be
 * logging parameters, potentially "request" cache, etc.
 */
export type AppContext = {
  authorization: AuthorizationContext;
  domain: DomainContext;
  deployment: DeploymentContext;
  entri: EntriContext;
  planFeatures: PlanFeatures;
  purchases: Array<Purchase>;
  apiClient: ApiClientContext;
  trpcCache: TrpcCache;
  db: Db;
  createTokenContext: (token: string) => Promise<AppContext>;
  /**
   * Resolves plan features for a given user ID.
   * Use the shared plan helper when possible so repeated lookups are cached
   * consistently within the request.
   */
  getOwnerPlanFeatures: (userId: string) => Promise<PlanFeatures>;
};
