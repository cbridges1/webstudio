// Removes dependency, build and cache directories across the checkout (`npm run clean:deep`).
import { readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const directories = new Set([
  "node_modules",
  "lib",
  "build",
  "dist",
  ".vite",
  ".cache",
  ".pnpm-store",
]);
const isRemovableFile = (name) =>
  name === ".eslintcache" || name.endsWith(".tsbuildinfo");

console.info("Removing dependency, build, and cache directories...");

const clean = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (directories.has(entry.name)) {
        rmSync(path, { recursive: true, force: true });
      } else if (entry.name !== ".git") {
        clean(path);
      }
    } else if (isRemovableFile(entry.name)) {
      rmSync(path, { force: true });
    }
  }
};
clean(rootDir);

console.info("Cleanup completed.");
