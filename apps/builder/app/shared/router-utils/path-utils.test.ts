import { expect, test } from "vitest";
import {
  builderPath,
  builderServerOrigin,
  builderUrl,
  restAssetsUploadPath,
  areBuilderDataUrlsEqual,
} from "./path-utils";

const projectId = "090e6e14-ae50-4b2e-bd22-71733cec05bb";

test("includes an instance deep link in builder paths", () => {
  expect(
    builderPath({
      pageId: "page-id",
      instanceSelector: ["instance-id", "slot-id", "body-id"],
      mode: "content",
    })
  ).toBe(
    "/?pageId=page-id&instance=instance-id%2Cslot-id%2Cbody-id&mode=content"
  );
});

test("includes an instance deep link in builder urls", () => {
  expect(
    builderUrl({
      projectId: "project-id",
      pageId: "page-id",
      instanceSelector: ["instance-id", "body-id"],
      origin: "https://wstd.dev",
    })
  ).toBe(
    "https://wstd.dev/p/project-id/?pageId=page-id&instance=instance-id%2Cbody-id"
  );
});

test("opens projects under /p/<projectId>/", () => {
  expect(
    builderUrl({
      projectId,
      pageId: "page-id",
      origin: "https://builder-123.us-central1.run.app",
    })
  ).toBe(
    `https://builder-123.us-central1.run.app/p/${projectId}/?pageId=page-id`
  );
  // From a project page, too.
  expect(
    builderUrl({
      projectId,
      origin: `https://builder-123.us-central1.run.app/p/${projectId}/`,
    })
  ).toBe(`https://builder-123.us-central1.run.app/p/${projectId}/`);
});

test("a project's server origin is the one project-paths.mjs maps it onto", () => {
  expect(
    builderServerOrigin({
      projectId,
      origin: "https://builder-123.us-central1.run.app",
    })
  ).toBe(`https://p-${projectId}.builder-123.us-central1.run.app`);
});

test("builds the asset upload item route", () => {
  expect(restAssetsUploadPath({ name: "query", width: 100, height: 200 })).toBe(
    "/rest/assets/uploads/query?width=100&height=200"
  );
});

test("instance navigation preserves Builder data but access changes do not", () => {
  const current = new URL(
    builderPath({
      instanceSelector: ["first", "body"],
      authToken: "share-token",
    }),
    "https://wstd.dev"
  );
  const next = new URL(
    builderPath({
      instanceSelector: ["second", "body"],
      authToken: "share-token",
    }),
    current
  );
  expect(areBuilderDataUrlsEqual(current, next)).toBe(true);
  next.searchParams.set("authToken", "other-token");
  expect(areBuilderDataUrlsEqual(current, next)).toBe(false);
});
