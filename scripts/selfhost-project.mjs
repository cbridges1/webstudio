// selfhost: `npm run dev`, `npm run cli`, `npm run mcp` and `npm run setup` in this checkout run
// the same commands in the self-hosting project that runs this fork (its stack, its deployment
// CLI). That project is WEBSTUDIO_SELFHOST_DIR, or a folder next to this checkout whose
// package.json has `"webstudioSelfhost": true`.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const checkoutDir = resolve(import.meta.dirname, "..");

const isSelfhostProject = (dir) => {
  try {
    return (
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
        .webstudioSelfhost === true
    );
  } catch {
    return false;
  }
};

const findProject = () => {
  if (process.env.WEBSTUDIO_SELFHOST_DIR) {
    return resolve(process.env.WEBSTUDIO_SELFHOST_DIR);
  }
  const parent = dirname(checkoutDir);
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name))
    .find((dir) => dir !== checkoutDir && isSelfhostProject(dir));
};

const projectDir = findProject();
const command = process.argv[2];
// `cli` is its own script there; everything else goes through selfhost.mjs.
const entry =
  projectDir &&
  join(
    projectDir,
    command === "cli" ? "scripts/cli.mjs" : "scripts/selfhost.mjs"
  );

if (entry === undefined || existsSync(entry) === false) {
  console.error(
    "No self-hosting project found next to this checkout (a folder whose package.json has\n" +
      '"webstudioSelfhost": true). Check it out beside this one, or set WEBSTUDIO_SELFHOST_DIR.'
  );
  process.exit(1);
}

// Ctrl+C reaches the child directly; wait for it to finish stopping.
process.on("SIGINT", () => {});
const args = process.argv.slice(command === "cli" ? 3 : 2);
const child = spawn(process.execPath, [entry, ...args], {
  cwd: projectDir,
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 130));
});
