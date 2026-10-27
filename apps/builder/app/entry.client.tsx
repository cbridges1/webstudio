// Remix's default browser entry, plus (selfhost) project paths: a project opened at
// /p/<projectId>/ (see project-paths.mjs) is routed below that prefix, as its server renders it
// without one.
import { RemixBrowser } from "@remix-run/react";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { getProjectPathPrefix } from "./shared/router-utils/path-utils";

const projectPath = getProjectPathPrefix();
if (projectPath !== "") {
  (
    window as unknown as { __remixContext: { basename?: string } }
  ).__remixContext.basename = projectPath;
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <RemixBrowser />
    </StrictMode>
  );
});
