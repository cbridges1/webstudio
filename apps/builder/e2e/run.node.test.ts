import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";

const runE2e = (...args: string[]) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", join(import.meta.dirname, "run.ts"), ...args],
    {
      encoding: "utf8",
      env: { ...process.env, E2E_SKIP_CLEANUP: "true" },
      timeout: 20_000,
    }
  );

test("rejects unknown modes before starting services", () => {
  const result = runE2e("nope");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unknown Builder E2E mode: nope");
});

test("rejects unknown backend modes", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", join(import.meta.dirname, "run.ts"), "run"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        E2E_SKIP_CLEANUP: "true",
        E2E_BACKEND_MODE: "development",
      },
      timeout: 20_000,
    }
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unknown Builder E2E backend mode");
});
