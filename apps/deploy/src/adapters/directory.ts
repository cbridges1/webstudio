// Copies the site into a folder that a web server we run (nginx, Caddy) serves, one folder
// per site under the deploy service's DEPLOY_SITES_DIR. Also what local end-to-end tests use.
// The target comes from the builder, so it names a folder under that root, never a path.
import { cp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { HostAdapter } from "./types";

const configSchema = z.object({
  site: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]{0,62}$/,
      "lowercase letters, digits and '-', starting with a letter or digit"
    )
    .describe("Folder name under the deploy service's sites directory"),
  url: z.string().url().describe("Public URL the web server serves it at"),
});

export const createDirectoryAdapter = (
  sitesDir: string
): HostAdapter<z.infer<typeof configSchema>> => ({
  id: "directory",
  label: "Folder on the deploy service",
  configSchema,
  async deploy({ buildDir, config, log }) {
    const path = join(sitesDir, config.site);
    const next = `${path}.next`;
    const previous = `${path}.previous`;
    await rm(next, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
    await cp(buildDir, next, { recursive: true });
    // Swap with renames so the web server never serves a half-copied site.
    await rename(path, previous).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await rename(next, path);
    await rm(previous, { recursive: true, force: true });
    log(`Copied site to ${path}`);
    return { url: config.url };
  },
  async remove({ config, log }) {
    const path = join(sitesDir, config.site);
    await rm(path, { recursive: true, force: true });
    log(`Removed ${path}`);
  },
});
