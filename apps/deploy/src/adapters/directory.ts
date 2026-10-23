// Copies the site into a directory served by a web server we run (nginx, Caddy) on a VPS.
// Also what local end-to-end tests use.
import { cp, rename, rm } from "node:fs/promises";
import { z } from "zod";
import type { HostAdapter } from "./types";

const configSchema = z.object({
  /** Directory the web server serves for this site. Replaced on every deploy. */
  path: z.string().min(1),
  /** Public URL of the site. */
  url: z.string().url(),
});

export const directoryAdapter: HostAdapter<z.infer<typeof configSchema>> = {
  id: "directory",
  configSchema,
  async deploy({ buildDir, config, log }) {
    const next = `${config.path}.next`;
    const previous = `${config.path}.previous`;
    await rm(next, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
    await cp(buildDir, next, { recursive: true });
    // Swap with renames so the web server never serves a half-copied site.
    await rename(config.path, previous).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    );
    await rename(next, config.path);
    await rm(previous, { recursive: true, force: true });
    log(`Copied site to ${config.path}`);
    return { url: config.url };
  },
  async remove({ config, log }) {
    await rm(config.path, { recursive: true, force: true });
    log(`Removed ${config.path}`);
  },
};
