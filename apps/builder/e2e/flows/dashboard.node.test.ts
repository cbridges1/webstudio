import { expect, test } from "vitest";
import { getWorkerEmail, getWorkerUsername } from "./dashboard";

test("isolates login identities between parallel Playwright workers", () => {
  expect(getWorkerEmail("editor@webstudio.test", "0")).toBe(
    "editor+worker-0@webstudio.test"
  );
  expect(getWorkerEmail("editor@webstudio.test", "1")).toBe(
    "editor+worker-1@webstudio.test"
  );
});

test("derives a distinct valid username for each worker email", () => {
  const long = "slot-keyboard-navigator-multi-select-e2e@webstudio.test";
  const usernames = [
    getWorkerUsername(getWorkerEmail(long, "0")),
    getWorkerUsername(getWorkerEmail(long, "1")),
    getWorkerUsername("editor@webstudio.test"),
  ];
  for (const username of usernames) {
    expect(username).toMatch(/^[a-z0-9_.-]{3,32}$/);
  }
  expect(new Set(usernames).size).toBe(3);
  expect(getWorkerUsername("editor@webstudio.test")).toBe(
    getWorkerUsername("editor@webstudio.test")
  );
});
