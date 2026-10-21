import { expect, test } from "vitest";
import { getBrowserLaunchOptions, getProjectBuilderUrl } from "./test";

test("needs no host mapping: project hosts are subdomains of localhost", () => {
  expect(getBrowserLaunchOptions("http://localhost:3000")).toEqual({});
  expect(
    new URL(
      getProjectBuilderUrl({
        projectId: "00000000-0000-4000-8000-000000000001",
      })
    ).hostname
  ).toBe("p-00000000-0000-4000-8000-000000000001.localhost");
});

test("does not override host resolution for remote Builder URLs", () => {
  expect(getBrowserLaunchOptions("https://builder.example.com")).toEqual({});
});
