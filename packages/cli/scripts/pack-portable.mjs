// selfhost: packs this CLI as a self-contained npm package (dist/webstudio-cli.tgz) that the
// builder serves at /cli/webstudio.json, so `npx -y <builder>/cli/webstudio-<hash>.tgz …`
// runs exactly the builder's version. The workspace packages are already bundled into lib/
// (vite.config.ts); the package keeps only its dependencies from npm.
//
//   node scripts/pack-portable.mjs   (after `pnpm build`)
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cliDir = resolve(import.meta.dirname, "..");
const distDir = join(cliDir, "dist");
const output = join(distDir, "webstudio-cli.tgz");

if (existsSync(join(cliDir, "lib/cli.js")) === false) {
  console.error(
    "The CLI isn't built: run `pnpm --filter webstudio build` first."
  );
  process.exit(1);
}

const source = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
const packageJson = {
  name: source.name,
  version: source.version,
  description: source.description,
  homepage: source.homepage,
  license: source.license,
  type: source.type,
  bin: source.bin,
  files: source.files,
  engines: source.engines,
  dependencies: Object.fromEntries(
    Object.entries(source.dependencies).filter(
      ([name]) => name.startsWith("@webstudio-is/") === false
    )
  ),
};

const stageDir = mkdtempSync(join(tmpdir(), "webstudio-cli-"));
try {
  for (const entry of ["bin.js", "lib", "templates", "LICENSE", "README.md"]) {
    if (existsSync(join(cliDir, entry))) {
      cpSync(join(cliDir, entry), join(stageDir, entry), { recursive: true });
    }
  }
  writeFileSync(
    join(stageDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`
  );
  execFileSync("npm", ["pack", "--silent", "--pack-destination", stageDir], {
    cwd: stageDir,
    stdio: ["ignore", "ignore", "inherit"],
    shell: process.platform === "win32",
  });
  const tarball = readdirSync(stageDir).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) {
    throw new Error("npm pack produced no tarball");
  }
  mkdirSync(distDir, { recursive: true });
  rmSync(output, { force: true });
  renameSync(join(stageDir, tarball), output);
  console.info(`Packed ${output}`);
} finally {
  rmSync(stageDir, { recursive: true, force: true });
}
