// selfhost: projects open at /p/<projectId>/ on the builder's own address, so a deployment
// needs one address and no wildcard domain (builderUrl in shared/router-utils/path-utils.ts).
//
// The builder tells a project's builder and canvas apart from the dashboard by origin:
// p-<projectId>.<builder host> (parseBuilderUrl). This middleware runs before Remix and maps a
// path request onto that origin, so the rest of the app works unchanged:
//
//   /p/<id>/rest/x on builder.example.com  →  p-<id>.builder.example.com/rest/x
//
// Requests a project page makes (fetches, images, the canvas iframe) whose path has no prefix
// are mapped by their Referer, as on a subdomain they'd have gone to the project's origin.
// Origin, Referer and Sec-Fetch-Site are rewritten to what the browser would have sent there,
// and redirects to a p-<id>. origin are mapped back to /p/<id>/. Plain Node (req, res, next),
// shared by the Vite dev server (vite.config.ts) and the production server (server.mjs).

const uuid =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const pathPrefix = new RegExp(`^/p/(${uuid})(?=/|\\?|$)`);
const projectHost = new RegExp(`^p-(${uuid})\\.(.+)$`);

/**
 * The project in a path (/p/<id>/...) and the path without it, or undefined.
 * @param {string} path
 */
export const parseProjectPath = (path) => {
  const match = path.match(pathPrefix);
  if (match === null) {
    return;
  }
  const rest = path.slice(match[0].length);
  return {
    projectId: match[1],
    path: rest.startsWith("/") ? rest : `/${rest}`,
  };
};

/**
 * Rewrites a URL on a project's origin (p-<id>.<host>) to /p/<id>/ on <host>; relative URLs
 * (/x) are a project's when `projectId` is given. Anything else is returned unchanged.
 * @param {string} value
 * @param {{ host: string, projectId?: string, relativeToProject: boolean }} options
 */
export const toProjectPathUrl = (
  value,
  { host, projectId, relativeToProject }
) => {
  if (value.startsWith("/") && value.startsWith("//") === false) {
    return relativeToProject && projectId !== undefined
      ? `/p/${projectId}${value}`
      : value;
  }
  if (URL.canParse(value) === false) {
    return value;
  }
  const url = new URL(value);
  const match = url.host.match(projectHost);
  if (match === null || match[2] !== host) {
    return value;
  }
  url.host = host;
  url.pathname = `/p/${match[1]}${url.pathname}`;
  return url.href;
};

/**
 * Rewrites every p-<id>.<host> URL in a header value (a Content-Security-Policy's sources).
 * @param {string} value
 * @param {string} host
 */
export const toProjectPathSources = (value, host) => {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(https?:)//p-(${uuid})\\.${escaped}(/[^\\s;,]*)?`,
    "g"
  );
  return value.replace(
    re,
    (_match, scheme, projectId, path) =>
      `${scheme}//${host}/p/${projectId}${path ?? "/"}`
  );
};

/** @param {string | string[] | undefined} value */
const first = (value) => (Array.isArray(value) ? value[0] : value);

/**
 * The project of the page a request came from (its Referer on this host), or undefined.
 * @param {string | undefined} referer
 * @param {string} host
 */
const refererProject = (referer, host) => {
  if (referer === undefined || URL.canParse(referer) === false) {
    return;
  }
  const url = new URL(referer);
  if (url.host !== host) {
    return;
  }
  const parsed = parseProjectPath(url.pathname);
  return parsed && { ...parsed, url };
};

/**
 * @param {string} origin
 * @param {string} host
 * @param {string | undefined} projectId
 */
const virtualOrigin = (origin, host, projectId) => {
  if (projectId === undefined || URL.canParse(origin) === false) {
    return origin;
  }
  const url = new URL(origin);
  if (url.host !== host) {
    return origin;
  }
  url.host = `p-${projectId}.${host}`;
  return url.origin;
};

/**
 * Express/Connect middleware: (req, res, next).
 * @returns {(req: any, res: any, next: (error?: unknown) => void) => void}
 */
export const createProjectPathsMiddleware = () => (req, res, next) => {
  const host = first(req.headers["x-forwarded-host"]) ?? req.headers.host;
  if (typeof host !== "string" || typeof req.url !== "string") {
    next();
    return;
  }
  const referer = first(req.headers.referer);
  const page = refererProject(referer, host);
  const fromPath = parseProjectPath(req.url);
  // A project page's own requests (not top-level navigations, which choose where they go).
  const inferred =
    fromPath === undefined &&
    page !== undefined &&
    first(req.headers["sec-fetch-dest"]) !== "document"
      ? page.projectId
      : undefined;
  const projectId = fromPath?.projectId ?? inferred;
  // Any response may send the browser to a project (the dashboard's OAuth authorize does).
  rewriteRedirects(res, host, projectId);
  if (projectId === undefined && page === undefined) {
    next();
    return;
  }

  if (projectId !== undefined) {
    const path = fromPath?.path ?? req.url;
    req.url = path;
    if (req.originalUrl !== undefined) {
      req.originalUrl = path;
    }
    const target = `p-${projectId}.${host}`;
    req.headers.host = target;
    if (req.headers["x-forwarded-host"] !== undefined) {
      req.headers["x-forwarded-host"] = target;
    }
  }

  // What the browser would have sent from the page's origin (p-<id>.<host> for a project page).
  const pageProjectId =
    page?.projectId ?? (referer === undefined ? projectId : undefined);
  const origin = first(req.headers.origin);
  if (origin !== undefined) {
    req.headers.origin = virtualOrigin(origin, host, pageProjectId);
  }
  if (page !== undefined) {
    const url = new URL(page.url);
    url.host = `p-${page.projectId}.${host}`;
    url.pathname = page.path.split("?")[0];
    req.headers.referer = url.href;
  }
  if (
    first(req.headers["sec-fetch-site"]) === "same-origin" &&
    pageProjectId !== projectId
  ) {
    // Different p-<id>. subdomains (or one and the main host) are same-site, not same-origin.
    req.headers["sec-fetch-site"] = "same-site";
  }

  next();
};

/**
 * Maps Location (and Remix's X-Remix-Redirect) back from p-<id>.<host> to /p/<id>/, and the
 * project origins a Content-Security-Policy allows.
 * @param {any} res
 * @param {string} host
 * @param {string | undefined} projectId the request's project, for relative redirects
 */
const rewriteRedirects = (res, host, projectId) => {
  /** @param {string} name @param {unknown} value */
  const rewrite = (name, value) => {
    const key = name.toLowerCase();
    if (key === "content-security-policy" && typeof value === "string") {
      return toProjectPathSources(value, host);
    }
    if (
      (key !== "location" && key !== "x-remix-redirect") ||
      typeof value !== "string"
    ) {
      return value;
    }
    // A data request's redirect is relative to the client router's basename already.
    return toProjectPathUrl(value, {
      host,
      projectId,
      relativeToProject: key === "location",
    });
  };
  const setHeader = res.setHeader.bind(res);
  res.setHeader = (/** @type {string} */ name, /** @type {unknown} */ value) =>
    setHeader(name, rewrite(name, value));
  if (typeof res.appendHeader === "function") {
    const appendHeader = res.appendHeader.bind(res);
    res.appendHeader = (
      /** @type {string} */ name,
      /** @type {unknown} */ value
    ) => appendHeader(name, rewrite(name, value));
  }
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (
    /** @type {number} */ status,
    /** @type {unknown[]} */ ...rest
  ) => {
    const headers = rest.find(
      (item) => item !== null && typeof item === "object"
    );
    if (headers !== undefined && Array.isArray(headers) === false) {
      for (const [name, value] of Object.entries(headers)) {
        /** @type {Record<string, unknown>} */ (headers)[name] = rewrite(
          name,
          value
        );
      }
    }
    return writeHead(status, ...rest);
  };
};
