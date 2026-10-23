// Builds a published Webstudio build as a static site, using the Webstudio checkout's own CLI and
// packages (the same version as the builder, so the bundle contract always matches). Mirrors the
// upstream SSG smoke test (packages/cli/scripts/test-ssg-package.ts).
import { spawn, spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Log } from "./adapters/types";

const isWindows = process.platform === "win32";

// pnpm, npm and the webstudio CLI are .cmd shims on Windows, which only run through the
// shell; quote arguments for cmd.exe there.
const quoteForCmd = (arg: string) =>
  /[\s"&|<>^]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;

/** Stops a build command and everything it started. */
const killTree = (pid: number) => {
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  // Its own process group (detached), so this reaches pnpm/vite's children too.
  process.kill(-pid, "SIGKILL");
};

// Workspace fixture whose dependencies are the workspace's SSG runtime packages.
const SSG_FIXTURE = "ssg-cloudflare-pages";

export type RunCommand = (
  command: string,
  args: string[],
  options: { cwd: string; log: Log; signal: AbortSignal; redact?: string[] }
) => Promise<void>;

export const runCommand: RunCommand = (
  command,
  args,
  { cwd, log, signal, redact = [] }
) =>
  new Promise((resolve, reject) => {
    const hide = (text: string) =>
      redact
        .reduce((result, secret) => result.split(secret).join("***"), text)
        // Drop terminal colors and cursor codes from CLI spinners.
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    log(`$ ${hide([command, ...args].join(" "))}`);
    const child = spawn(command, isWindows ? args.map(quoteForCmd) : args, {
      cwd,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: isWindows === false,
      shell: isWindows,
      windowsHide: true,
    });
    const onAbort = () => {
      if (child.pid !== undefined) {
        try {
          killTree(child.pid);
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim() !== "") {
          log(hide(line));
        }
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        reject(new Error(`${command} was stopped: ${String(signal.reason)}`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`${command} ${args[0] ?? ""} exited with code ${code}`)
        );
      }
    });
  });

/**
 * Generates and builds the site in `workDir` and returns the directory to upload.
 */
export const buildStaticSite = async ({
  webstudioDir,
  workDir,
  buildId,
  builderOrigin,
  serviceToken,
  log,
  signal,
  run = runCommand,
}: {
  webstudioDir: string;
  workDir: string;
  buildId: string;
  builderOrigin: string;
  serviceToken: string;
  log: Log;
  signal: AbortSignal;
  run?: RunCommand;
}): Promise<string> => {
  // A fresh copy of the fixture with its dependencies (hardlinked from the pnpm store). The
  // checkout is a pnpm workspace; knowbra-webstudio's scripts put its pinned pnpm on PATH.
  await run(
    "pnpm",
    ["--dir", webstudioDir, "--filter", SSG_FIXTURE, "deploy", workDir],
    { cwd: webstudioDir, log, signal }
  );
  // Drop the fixture's own project data and pages.
  await rm(join(workDir, "pages"), { recursive: true, force: true });
  await rm(join(workDir, ".webstudio"), { recursive: true, force: true });

  const cli = join(workDir, "node_modules", ".bin", "webstudio");
  await run(
    cli,
    [
      "sync",
      "--buildId",
      buildId,
      "--origin",
      builderOrigin,
      "--authToken",
      serviceToken,
    ],
    { cwd: workDir, log, signal, redact: [serviceToken] }
  );
  await run(cli, ["build", "--template", "ssg", "--template", "internal"], {
    cwd: workDir,
    log,
    signal,
  });
  await run("npm", ["run", "build"], { cwd: workDir, log, signal });

  return join(workDir, "dist", "client");
};
