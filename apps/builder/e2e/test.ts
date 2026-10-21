import { parseBuilderUrl } from "@webstudio-is/protocol";
import {
  test as base,
  type Browser,
  type BrowserContextOptions,
} from "@playwright/test";
const builderPort = process.env.PORT ?? "3000";

export const builderUrl =
  process.env.E2E_BUILDER_URL ?? `http://localhost:${builderPort}`;

const builderUrlObject = new URL(builderUrl);

export const dashboardUrl = `${builderUrlObject.protocol}//localhost:${builderUrlObject.port}`;

export const browserContextOptions: BrowserContextOptions = {
  permissions: ["clipboard-read", "clipboard-write"],
};

/**
 * Chromium resolves `localhost` and `*.localhost` (the project builder hosts) to
 * loopback by itself, so no runs need host mapping.
 */
export const getBrowserLaunchOptions = (_url = builderUrl) => ({});

export const newBrowserContext = (browser: Browser) =>
  browser.newContext(browserContextOptions);

export const withBrowserContext = async <Result>(
  browser: Browser,
  run: (
    context: Awaited<ReturnType<typeof newBrowserContext>>
  ) => Promise<Result> | Result
) => {
  const context = await newBrowserContext(browser);
  try {
    return await run(context);
  } finally {
    await context.close();
  }
};

export const test = base;

export const newIsolatedPage = async (browser: Browser) => {
  const context = await newBrowserContext(browser);
  return {
    page: await context.newPage(),
    close: () => context.close(),
  };
};

export const getProjectBuilderUrl = ({
  projectId,
  authToken,
  mode,
  features,
}: {
  projectId: string;
  authToken?: string;
  mode?: "content" | "preview";
  features?: string[];
}) => {
  const url = new URL(dashboardUrl);
  url.hostname = `p-${projectId}.localhost`;
  if (authToken !== undefined) {
    url.searchParams.set("authToken", authToken);
  }
  if (mode !== undefined) {
    url.searchParams.set("mode", mode);
  }
  if (features !== undefined && features.length > 0) {
    url.searchParams.set("features", features.join(","));
  }
  return url.href;
};

export const getProjectIdFromBuilderUrl = (url: string) => {
  return parseBuilderUrl(url).projectId;
};
