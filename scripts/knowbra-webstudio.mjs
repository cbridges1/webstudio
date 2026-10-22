// selfhost: `npm run dev`, `npm run cli` and `npm run setup` in this checkout run the same
// commands in knowbra-webstudio, the project that runs this fork (Postgres + RustFS, the
// builder, Drizzle Studio and the deploy service). It's found next to this checkout
// (../knowbra-webstudio) or at KNOWBRA_WEBSTUDIO_DIR.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const checkoutDir = resolve(import.meta.dirname, "..");
const projectDir = resolve(
  process.env.KNOWBRA_WEBSTUDIO_DIR ?? join(checkoutDir, "../knowbra-webstudio")
);
const entry = join(projectDir, "scripts/selfhost.mjs");

if (existsSync(entry) === false) {
  console.error(
    `knowbra-webstudio not found at ${projectDir}.\n` +
      "Clone https://github.com/cbridges1/knowbra-webstudio next to this checkout, or set KNOWBRA_WEBSTUDIO_DIR."
  );
  process.exit(1);
}

// Ctrl+C reaches the child directly; wait for it to finish stopping.
process.on("SIGINT", () => {});
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  cwd: projectDir,
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 130));
});
