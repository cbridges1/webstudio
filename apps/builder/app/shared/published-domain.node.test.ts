import { describe, test, expect } from "vitest";
import { getPublishedDomain } from "./published-domain";

describe("getPublishedDomain", () => {
  test("uses the deployed site's host", () => {
    expect(
      getPublishedDomain(
        {
          domain: "my-project",
          publishedUrl: "https://my-site.web.app/",
        },
        "wstd.work"
      )
    ).toBe("my-site.web.app");
  });

  test("falls back before the first deploy", () => {
    expect(
      getPublishedDomain(
        { domain: "my-project", publishedUrl: null },
        "wstd.work"
      )
    ).toBe("my-project.wstd.work");
    expect(getPublishedDomain({ domain: "my-project" }, "wstd.work")).toBe(
      "my-project.wstd.work"
    );
  });

  test("falls back on an invalid URL", () => {
    expect(
      getPublishedDomain(
        { domain: "my-project", publishedUrl: "not a url" },
        "wstd.work"
      )
    ).toBe("my-project.wstd.work");
  });
});
