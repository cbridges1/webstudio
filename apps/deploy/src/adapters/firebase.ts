// Firebase Hosting through its REST API (what firebase-tools does under the hood):
// create the site when it doesn't exist, create a version, list file hashes, upload the
// missing files, finalize, release.
// https://firebase.google.com/docs/hosting/api-deploy
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { getAccessToken, serviceAccountSchema } from "./google-auth";
import type { HostAdapter } from "./types";

const API = "https://firebasehosting.googleapis.com/v1beta1";
const SCOPES = [
  "https://www.googleapis.com/auth/firebase.hosting",
  "https://www.googleapis.com/auth/cloud-platform",
];
const POPULATE_BATCH = 1000;
const UPLOAD_CONCURRENCY = 8;

const configSchema = z.object({
  site: z
    .string()
    .min(1)
    .describe(
      'Hosting site name. The Firebase project ID is put in front unless it\'s already there ("blog" in project "acme" → acme-blog.web.app), since site IDs are unique across all of Firebase. Created on the first publish when it doesn\'t exist'
    ),
  project: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Firebase project to create the site in, when it isn't the service account's own"
    ),
  url: z
    .string()
    .url()
    .optional()
    .describe("Public URL when it isn't https://<site>.web.app"),
  hostingConfig: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Firebase hosting config: headers, redirects, cleanUrls, ..."),
});

type Config = z.infer<typeof configSchema>;
type Credentials = z.infer<typeof serviceAccountSchema>;

/** A failed Hosting API call: its status and Firebase's own message. */
class FirebaseApiError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(message: string, status: number, detail: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** The Firebase project the site belongs to: the configured one, else the service account's. */
const projectFor = (config: Config, credentials: Credentials) =>
  config.project ?? credentials.project_id;

/**
 * The Hosting site ID: the configured site with the project ID in front (site IDs are global
 * across Firebase, so "blog" alone is likely taken). A site that already starts with the
 * project ID, or is the project's default site, is used as it is.
 */
export const siteIdFor = (config: Config, credentials: Credentials) => {
  const project = projectFor(config, credentials);
  if (
    project === undefined ||
    config.site === project ||
    config.site.startsWith(`${project}-`)
  ) {
    return config.site;
  }
  return `${project}-${config.site}`;
};

const listFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
};

export const createFirebaseAdapter = (
  fetchImpl: typeof fetch = fetch
): HostAdapter<Config, Credentials> => {
  const call = async <T>(
    token: string,
    method: string,
    url: string,
    body?: unknown
  ): Promise<T> => {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (response.ok === false) {
      let detail = text;
      try {
        detail =
          (JSON.parse(text) as { error?: { message?: string } }).error
            ?.message ?? text;
      } catch {
        // Not JSON: keep the text.
      }
      throw new FirebaseApiError(
        `Firebase Hosting ${method} ${url.replace(API, "")} failed (${response.status}): ${text}`,
        response.status,
        detail
      );
    }
    return (text === "" ? {} : JSON.parse(text)) as T;
  };

  /** Creates the site in its project when Firebase doesn't have it yet. */
  const ensureSite = async (
    token: string,
    siteId: string,
    config: Config,
    credentials: Credentials,
    log: (line: string) => void
  ) => {
    const project = projectFor(config, credentials);
    if (project === undefined) {
      // No project to look in (a key without project_id): publishing reports a missing site.
      return;
    }
    const sites = `${API}/projects/${encodeURIComponent(project)}/sites`;
    try {
      await call(token, "GET", `${sites}/${encodeURIComponent(siteId)}`);
      return;
    } catch (error) {
      if (error instanceof FirebaseApiError === false || error.status !== 404) {
        throw error;
      }
    }
    log(`Creating Firebase Hosting site ${siteId} in project ${project}`);
    try {
      await call(
        token,
        "POST",
        `${sites}?siteId=${encodeURIComponent(siteId)}`,
        {}
      );
    } catch (error) {
      if (error instanceof FirebaseApiError) {
        throw new Error(
          `Couldn't create Firebase Hosting site "${siteId}" in project "${project}" (${error.status}): ${error.detail}. Site IDs are unique across all of Firebase, so another project may have it; choose another site ID in Project settings → Deploy.`
        );
      }
      throw error;
    }
  };

  return {
    id: "firebase",
    label: "Firebase Hosting",
    configSchema,
    credentialsSchema: serviceAccountSchema,

    async deploy({ buildDir, config, credentials, log }) {
      const token = await getAccessToken(credentials, SCOPES, fetchImpl);
      const siteId = siteIdFor(config, credentials);
      const site = encodeURIComponent(siteId);
      await ensureSite(token, siteId, config, credentials, log);

      const files = new Map<string, { hash: string; gzipped: Buffer }>();
      for (const file of await listFiles(buildDir)) {
        const gzipped = gzipSync(await readFile(file), { level: 9 });
        const hash = createHash("sha256").update(gzipped).digest("hex");
        const path = `/${relative(buildDir, file).split(sep).join("/")}`;
        files.set(path, { hash, gzipped });
      }
      if (files.size === 0) {
        throw new Error(`Nothing to deploy: ${buildDir} is empty`);
      }

      const version = await call<{ name: string }>(
        token,
        "POST",
        `${API}/sites/${site}/versions`,
        { config: config.hostingConfig ?? {} }
      );
      log(`Created version ${version.name} with ${files.size} files`);

      const byHash = new Map(
        [...files.values()].map((file) => [file.hash, file.gzipped])
      );
      const required = new Set<string>();
      let uploadUrl: string | undefined;
      const entries = [...files.entries()];
      for (let start = 0; start < entries.length; start += POPULATE_BATCH) {
        const batch = Object.fromEntries(
          entries
            .slice(start, start + POPULATE_BATCH)
            .map(([path, file]) => [path, file.hash])
        );
        const result = await call<{
          uploadRequiredHashes?: string[];
          uploadUrl?: string;
        }>(token, "POST", `${API}/${version.name}:populateFiles`, {
          files: batch,
        });
        uploadUrl = result.uploadUrl ?? uploadUrl;
        for (const hash of result.uploadRequiredHashes ?? []) {
          required.add(hash);
        }
      }

      if (required.size > 0) {
        if (uploadUrl === undefined) {
          throw new Error("Firebase Hosting returned no upload URL");
        }
        const queue = [...required];
        const upload = async () => {
          for (let hash = queue.pop(); hash !== undefined; hash = queue.pop()) {
            const response = await fetchImpl(`${uploadUrl}/${hash}`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/octet-stream",
              },
              body: new Uint8Array(byHash.get(hash)!),
            });
            if (response.ok === false) {
              throw new Error(
                `Firebase Hosting upload failed (${response.status}): ${await response.text()}`
              );
            }
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(UPLOAD_CONCURRENCY, queue.length) },
            upload
          )
        );
      }
      log(
        `Uploaded ${required.size} new files (${files.size - required.size} unchanged)`
      );

      await call(token, "PATCH", `${API}/${version.name}?updateMask=status`, {
        status: "FINALIZED",
      });
      await call(
        token,
        "POST",
        `${API}/sites/${site}/releases?versionName=${encodeURIComponent(version.name)}`
      );
      const url = config.url ?? `https://${siteId}.web.app`;
      log(`Released ${version.name} to ${url}`);
      return { url };
    },

    async remove({ config, credentials, log }) {
      const token = await getAccessToken(credentials, SCOPES, fetchImpl);
      // A Hosting site can't be emptied; a SITE_DISABLE release takes it offline.
      await call(
        token,
        "POST",
        `${API}/sites/${encodeURIComponent(siteIdFor(config, credentials))}/releases`,
        { type: "SITE_DISABLE" }
      );
      log(`Disabled Firebase Hosting site ${siteIdFor(config, credentials)}`);
    },
  };
};
