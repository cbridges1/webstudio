// selfhost: the builder serves its own Webstudio CLI (packages/cli, packed by
// `pnpm --filter webstudio pack:portable`), so agents connect with the CLI that matches this
// builder instead of the published webstudio@latest. The file name carries a content hash,
// so npx never reuses a CLI from before a builder upgrade.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const packagePath = () =>
  process.env.WEBSTUDIO_CLI_PACKAGE ??
  // The builder runs from apps/builder in the checkout.
  resolve(process.cwd(), "../../packages/cli/dist/webstudio-cli.tgz");

let cached: { path: string; mtimeMs: number; hash: string } | undefined;

/** The packed CLI and its short content hash, or undefined when it isn't packed. */
export const loadCliPackage = async () => {
  const path = packagePath();
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) {
    return;
  }
  if (cached?.path !== path || cached.mtimeMs !== info.mtimeMs) {
    const hash = createHash("sha256")
      .update(await readFile(path))
      .digest("hex")
      .slice(0, 12);
    cached = { path, mtimeMs: info.mtimeMs, hash };
  }
  return { path: cached.path, hash: cached.hash };
};

export const cliPackageFileName = (hash: string) => `webstudio-${hash}.tgz`;

export const cliPackageUrl = (origin: string, hash: string) =>
  new URL(`/cli/${cliPackageFileName(hash)}`, origin).href;
