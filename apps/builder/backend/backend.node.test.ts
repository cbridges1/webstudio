import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  createBackend,
  killTree,
  run,
  runningChildren,
  schemaFingerprint,
  enableProcessGroups,
} from "./backend";

const temporaryDirectories: string[] = [];

const createRepositoryFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "webstudio-builder-backend-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "packages/db/drizzle"), { recursive: true });
  await mkdir(join(root, "apps/builder/backend"), { recursive: true });
  await writeFile(
    join(root, "packages/db/drizzle/0000_baseline.sql"),
    "SELECT 1;"
  );
  await writeFile(join(root, "apps/builder/backend/compose.yaml"), "services:");
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

test("schema fingerprint includes new backend files but not tests", async () => {
  const root = await createRepositoryFixture();
  const before = schemaFingerprint(root);

  await writeFile(join(root, "apps/builder/backend/backend.node.test.ts"), "");
  expect(schemaFingerprint(root)).toBe(before);

  await writeFile(join(root, "apps/builder/backend/init.sql"), "SELECT 2;");
  expect(schemaFingerprint(root)).not.toBe(before);
});

test("e2e modes use their own Compose project", async () => {
  const root = await createRepositoryFixture();
  const projectName = (mode: "test" | "snapshot") =>
    createBackend({ mode, root, env: {} }).projectName;

  expect(projectName("test")).toBe("builder-e2e");
  expect(projectName("snapshot")).toBe("builder-e2e");
});

test.runIf(process.platform !== "win32")(
  "killTree stops descendants of a process group",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "backend-kill-"));
    temporaryDirectories.push(directory);
    const survived = join(directory, "survived");
    enableProcessGroups();
    // A parent that starts a descendant ignoring SIGTERM, then waits.
    const finished = run(process.execPath, [
      "-e",
      `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(
        `process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(survived)}, ""), 1500)`
      )}], { stdio: "inherit" }); setTimeout(() => {}, 5000);`,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [child] = runningChildren;
    killTree(child, "SIGKILL");
    await finished;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(existsSync(survived)).toBe(false);
  }
);

test("run reports a missing program", async () => {
  await expect(run("webstudio-no-such-program", [])).rejects.toThrow(
    "webstudio-no-such-program not found"
  );
});

test("automated steps do not read from the caller's terminal", async () => {
  // stdin is closed, so a program waiting for input sees EOF instead of hanging.
  const { code, stdout } = await run(
    process.execPath,
    [
      "-e",
      'let input = ""; process.stdin.on("data", (d) => (input += d)).on("end", () => console.log(JSON.stringify(input)))',
    ],
    { capture: true }
  );
  expect(code).toBe(0);
  expect(stdout.trim()).toBe('""');
});
