import { json } from "@remix-run/server-runtime";
import { parsePages } from "@webstudio-is/project-build/persistence";
import { getStaticSiteMapXml } from "@webstudio-is/sdk";
import { parseBuilderUrl } from "@webstudio-is/protocol";
import { isBuilder } from "../router-utils";
import { createContext } from "../context.server";
import { and, build, eq, isNull } from "@webstudio-is/db";

/**
 * This should be a route in SvelteKit, as it can be fetched server-side without an actual HTTP request.
 * Consider moving it to routes if Remix supports similar functionality in the future.
 * Note: Fetching own routes using request.origin is prohibited on Cloudflare Workers.
 * Note: We are not moving this to routes to avoid generating an additional 30MB function on deploy.
 */
export const loader = async ({ request }: { request: Request }) => {
  if (isBuilder(request) === false) {
    throw new Error("Only builder requests are allowed");
  }

  const { projectId } = parseBuilderUrl(request.url);

  if (projectId === undefined) {
    throw new Error("projectId is required");
  }

  const context = await createContext(request);

  const builds = await context.db
    .select({ pages: build.pages, updatedAt: build.updatedAt })
    .from(build)
    .where(and(eq(build.projectId, projectId), isNull(build.deployment)));

  if (builds.length !== 1) {
    throw json({ message: "Build not found" }, { status: 404 });
  }

  const [devBuild] = builds;

  const pages = parsePages(devBuild.pages);

  const siteMap = getStaticSiteMapXml(pages, devBuild.updatedAt);

  return json(siteMap);
};
