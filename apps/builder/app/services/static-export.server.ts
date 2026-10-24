// selfhost: Export → "Build and download static site". Upstream's closed SaaS packaged the
// download; here the builder builds it itself, with the same static site build the deploy
// service uses (@webstudio-is/deploy-protocol/site-build), zips dist/client and serves it at
// /cgi/static/ssg/<buildId>.zip. The build's publishStatus tracks the job, which the Export
// dialog polls.
//
// Needs the Webstudio checkout and pnpm, as the deploy service does: WEBSTUDIO_DIR (default:
// the checkout the builder runs from) and STATIC_EXPORTS_DIR (default: the OS temp dir).
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildStaticSite } from "@webstudio-is/deploy-protocol/site-build";
import { build, eq, maybeOne, project, type Db } from "@webstudio-is/db";
import { createPublishToken } from "./publish-token.server";
import { zipDirectory } from "./zip.server";

const JOB_TIMEOUT_MS = 10 * 60 * 1000;
// Downloads stay this long; each new export clears older ones.
const KEEP_MS = 60 * 60 * 1000;

const exportsDir = () =>
  resolve(
    process.env.STATIC_EXPORTS_DIR ?? join(tmpdir(), "webstudio-static-exports")
  );

// The builder runs from apps/builder in the checkout.
const webstudioDir = () =>
  resolve(process.env.WEBSTUDIO_DIR ?? resolve(process.cwd(), "../.."));

const namePattern = /^([0-9a-f-]{36})\.zip$/;

export const staticExportName = (buildId: string) => `${buildId}.zip`;

/** The build a download name stands for, or undefined when the name isn't one. */
export const parseStaticExportName = (name: string) =>
  namePattern.exec(name)?.[1];

export const staticExportPath = (buildId: string) =>
  join(exportsDir(), staticExportName(buildId));

/** The project a static export belongs to, for the download's permission check. */
export const loadStaticExportProject = async (buildId: string, db: Db) =>
  maybeOne(
    await db
      .select({ projectId: build.projectId, domain: project.domain })
      .from(build)
      .innerJoin(project, eq(project.id, build.projectId))
      .where(eq(build.id, buildId))
  ) ?? undefined;

const clearOldExports = async () => {
  const dir = exportsDir();
  const now = Date.now();
  for (const name of await readdir(dir).catch(() => [])) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined && now - info.mtimeMs > KEEP_MS) {
      await rm(path, { recursive: true, force: true });
    }
  }
};

const setStatus = (
  db: Db,
  buildId: string,
  publishStatus: "PUBLISHED" | "FAILED"
) =>
  db
    .update(build)
    .set({ publishStatus, updatedAt: new Date().toISOString() })
    .where(eq(build.id, buildId));

const runExport = async ({
  db,
  projectId,
  buildId,
  templates,
  builderOrigin,
}: StaticExportJob) => {
  const log = (line: string) =>
    console.info(`[static export ${buildId}] ${line}`);
  const workDir = join(exportsDir(), `work-${buildId}`);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(`timed out after ${JOB_TIMEOUT_MS} ms`),
    JOB_TIMEOUT_MS
  );
  try {
    await mkdir(exportsDir(), { recursive: true });
    await clearOldExports();
    const siteDir = await buildStaticSite({
      webstudioDir: webstudioDir(),
      workDir,
      buildId,
      builderOrigin,
      builderToken: createPublishToken({ projectId, buildId }),
      templates,
      log,
      signal: controller.signal,
    });
    await zipDirectory(siteDir, staticExportPath(buildId));
    await setStatus(db, buildId, "PUBLISHED");
    log("Ready to download");
  } catch (error) {
    log(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    await setStatus(db, buildId, "FAILED").catch(() => {});
  } finally {
    clearTimeout(timeout);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};

type StaticExportJob = {
  db: Db;
  projectId: string;
  buildId: string;
  templates: string[];
  /** Where the site build downloads the build and its assets (`webstudio sync`). */
  builderOrigin: string;
};

// One build at a time: each runs pnpm, vite and the project's code.
let queue = Promise.resolve();

/** Starts building the download in the background; the build's status reports the result. */
export const startStaticExport = (job: StaticExportJob) => {
  queue = queue.then(() => runExport(job));
};
