// selfhost: each project deploys to its own host, so the published address comes from
// Project.publishedUrl (written by the deploy service) instead of `<domain>.<PUBLISHER_HOST>`.

/**
 * Host of the project's published site, falling back to `<domain>.<publisherHost>`
 * before the first deploy.
 */
export const getPublishedDomain = (
  project: {
    domain: string;
    publishedUrl?: string | null;
  },
  publisherHost: string
): string => {
  const url = project.publishedUrl;
  if (url !== undefined && url !== null) {
    try {
      return new URL(url).host;
    } catch {
      // Not a valid URL; fall back below.
    }
  }
  return `${project.domain}.${publisherHost}`;
};
