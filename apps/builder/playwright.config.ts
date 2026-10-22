import { defineConfig } from "@playwright/test";
import {
  browserContextOptions,
  builderUrl,
  getBrowserLaunchOptions,
} from "./e2e/test";
import { getE2eTestMatch } from "./e2e/test-shards";

// selfhost: the builder is plain HTTP and its cookies are Secure (__Host-). Google
// Chrome keeps Secure cookies on http://localhost; Playwright's bundled Chromium builds
// drop them, so sign-in can't work there. Set E2E_BROWSER_CHANNEL to override.
const browserChannel = process.env.E2E_BROWSER_CHANNEL ?? "chrome";

const testTimeout =
  Number.parseInt(process.env.E2E_TEST_TIMEOUT_MS ?? "", 10) || 120_000;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/e2e",
  timeout: testTimeout,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    ...browserContextOptions,
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    launchOptions: getBrowserLaunchOptions(),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /setup\.ts/,
      use: { browserName: "chromium", channel: browserChannel },
    },
    {
      name: "chromium",
      testMatch: getE2eTestMatch(process.env.E2E_TEST_SHARD),
      dependencies: ["setup"],
      use: { browserName: "chromium", channel: browserChannel },
    },
  ],
  webServer:
    process.env.E2E_BUILDER_URL === undefined
      ? {
          command:
            "pnpm exec tsx --conditions=webstudio ./e2e/serve-built-remix.ts",
          url: builderUrl,
          reuseExistingServer: false,
          timeout: 60_000,
          stdout: "pipe",
          stderr: "pipe",
        }
      : undefined,
});
