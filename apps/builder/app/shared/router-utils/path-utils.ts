import type { AUTH_PROVIDERS } from "~/shared/session";
import { getAssetUploadApiUrl } from "@webstudio-is/sdk/runtime";
import { parseBuilderUrl } from "@webstudio-is/protocol";
import { getAuthorizationServerOrigin } from "./origins";
import type { BuilderMode } from "../nano-states/misc";

const searchParams = (params: Record<string, string | undefined | null>) => {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      searchParams.set(key, value);
    }
  }
  const asString = searchParams.toString();
  return asString === "" ? "" : `?${asString}`;
};

export type BuilderLinkParams = {
  pageId?: string;
  instanceSelector?: readonly string[];
  authToken?: string;
  pageHash?: string;
  mode?: BuilderMode;
  safemode?: boolean;
};

export const builderPath = ({
  pageId,
  instanceSelector,
  authToken,
  pageHash,
  mode,
  safemode = false,
}: BuilderLinkParams = {}) => {
  return `/${searchParams({
    pageId,
    instance: instanceSelector?.join(","),
    authToken,
    pageHash,
    mode,
    safemode: safemode ? "true" : undefined,
  })}`;
};

/**
 * selfhost: a project opens at <builder address>/p/<projectId>/, so the builder needs one
 * address and no wildcard domain (project-paths.mjs serves it).
 */
export const builderUrl = ({
  projectId,
  origin,
  ...link
}: BuilderLinkParams & {
  projectId: string;
  origin: string;
}) => {
  const authServerOrigin = getAuthorizationServerOrigin(origin);
  return new URL(`/p/${projectId}${builderPath(link)}`, authServerOrigin).href;
};

/**
 * selfhost: the origin the server sees a project's requests on: project-paths.mjs maps
 * /p/<projectId>/ onto p-<projectId>.<host>.
 */
export const builderServerOrigin = ({
  projectId,
  origin,
}: {
  projectId: string;
  origin: string;
}) => {
  const url = new URL(getAuthorizationServerOrigin(origin));
  url.host = `p-${projectId}.${url.host}`;
  return url.origin;
};

export const dashboardPath = (
  view: "templates" | "search" | "projects" | "settings" = "projects"
) => {
  if (view === "projects") {
    return `/dashboard`;
  }
  return `/dashboard/${view}`;
};

export const dashboardUrl = (props: { origin: string }) => {
  const authServerOrigin = getAuthorizationServerOrigin(props.origin);

  return `${authServerOrigin}/dashboard`;
};

export const cloneProjectUrl = (props: {
  origin: string;
  sourceAuthToken: string;
}) => {
  const authServerOrigin = getAuthorizationServerOrigin(props.origin);

  const searchParams = new URLSearchParams();
  searchParams.set("projectToCloneAuthToken", props.sourceAuthToken);

  return `${authServerOrigin}/dashboard?${searchParams.toString()}`;
};

export const loginPath = (params: {
  error?: (typeof AUTH_PROVIDERS)[keyof typeof AUTH_PROVIDERS];
  message?: string;
  returnTo?: string;
}) => `/login${searchParams(params)}`;

export const logoutPath = () => "/logout";
export const restLogoutPath = () => "/dashboard-logout";

export const authCallbackPath = ({
  provider,
}: {
  provider: "google" | "github";
}) => `/auth/${provider}/callback`;

export const authPath = ({
  provider,
}: {
  provider: "google" | "github" | "password";
}) => `/auth/${provider}`;

export const restAssetsUploadPath = ({
  name,
  width,
  height,
}: {
  name: string;
  width?: number | undefined;
  height?: number | undefined;
}) => {
  const urlSearchParams = new URLSearchParams();
  if (width !== undefined) {
    urlSearchParams.set("width", String(width));
  }
  if (height !== undefined) {
    urlSearchParams.set("height", String(height));
  }

  const query = urlSearchParams.toString();
  if (query !== "") {
    return `${getAssetUploadApiUrl(name)}?${query}`;
  }

  return getAssetUploadApiUrl(name);
};

/**
 * selfhost: the /p/<projectId> a project page was opened under, or "" elsewhere and on the
 * server.
 */
export const getProjectPathPrefix = () => {
  if (typeof window === "undefined") {
    return "";
  }
  const { projectId } = parseBuilderUrl(window.location.href);
  const prefix = `/p/${projectId}`;
  return projectId !== undefined && window.location.pathname.startsWith(prefix)
    ? prefix
    : "";
};

export const getCanvasUrl = () => {
  return `${getProjectPathPrefix()}/canvas`;
};

export const restResourcesLoader = ({ diagnostics = false } = {}) =>
  `/rest/resources-loader${diagnostics ? "?diagnostics=true" : ""}`;

export const marketplacePath = (method: string) =>
  `/builder/marketplace/${method}`;

// Editor navigation does not change the Builder data loaded by the route.
export const areBuilderDataUrlsEqual = (currentUrl: URL, nextUrl: URL) => {
  const current = new URL(currentUrl);
  const next = new URL(nextUrl);
  for (const param of [
    "pageId",
    "instance",
    "instanceId",
    "mode",
    "pageHash",
  ]) {
    current.searchParams.delete(param);
    next.searchParams.delete(param);
  }
  return current.href === next.href;
};
