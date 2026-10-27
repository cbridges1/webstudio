// For easier detecting the builder URL
const buildProjectDomainPrefix = "p-";

// selfhost: a project opens at /p/<projectId>/ on the builder's own address.
const projectPathRe =
  /^\/p\/(?<uuid>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})(?=\/|$)/;

export const parseBuilderUrl = (urlStr: string) => {
  const url = new URL(urlStr);

  const pathProjectId = url.pathname.match(projectPathRe)?.groups?.uuid;
  if (pathProjectId !== undefined) {
    return {
      projectId: pathProjectId,
      sourceOrigin: url.origin,
    };
  }

  const fragments = url.host.split(".");
  // Regular expression to match the prefix, UUID, and any optional string after '-dot-'
  const re =
    /^(?<prefix>[a-z-]+)(?<uuid>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})(-dot-(?<branch>.*))?/;
  const match = fragments[0].match(re);

  // Extract prefix, projectId (UUID), and branch (if exists)
  const prefix = match?.groups?.prefix;
  const projectId = match?.groups?.uuid;
  const branch = match?.groups?.branch;

  if (prefix !== buildProjectDomainPrefix) {
    return {
      projectId: undefined,
      sourceOrigin: url.origin,
    };
  }

  if (projectId === undefined) {
    return {
      projectId: undefined,
      sourceOrigin: url.origin,
    };
  }

  fragments[0] = fragments[0].replace(re, branch ?? "");

  // Keep the request's protocol: the deployment decides whether that's HTTPS.
  const sourceUrl = new URL(url.origin);
  sourceUrl.host = fragments.filter(Boolean).join(".");

  return {
    projectId,
    sourceOrigin: sourceUrl.origin,
  };
};
