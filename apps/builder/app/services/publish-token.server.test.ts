import { describe, expect, test } from "vitest";
import {
  createPublishToken,
  isPublishToken,
  verifyPublishToken,
} from "./publish-token.server";

const key = Buffer.from("k".repeat(32));
const now = Date.UTC(2026, 0, 1);
const ids = { projectId: "project-1", buildId: "build-1" };

describe("publish token", () => {
  test("round-trips its project and build", () => {
    const token = createPublishToken(ids, { now, key });
    expect(isPublishToken(token)).toBe(true);
    expect(verifyPublishToken(token, { now, key })).toEqual({
      ...ids,
      expiresAt: now + 2 * 60 * 60 * 1000,
    });
  });

  test("rejects a token signed with another key", () => {
    const token = createPublishToken(ids, { now, key });
    expect(
      verifyPublishToken(token, { now, key: Buffer.from("x".repeat(32)) })
    ).toBeUndefined();
  });

  test("rejects a changed payload", () => {
    const [prefix, , signature] = createPublishToken(ids, { now, key }).split(
      "."
    );
    const payload = Buffer.from(
      JSON.stringify({ ...ids, projectId: "project-2", expiresAt: now + 1000 })
    ).toString("base64url");
    expect(
      verifyPublishToken(`${prefix}.${payload}.${signature}`, { now, key })
    ).toBeUndefined();
  });

  test("expires", () => {
    const token = createPublishToken(ids, { now, key });
    expect(
      verifyPublishToken(token, { now: now + 3 * 60 * 60 * 1000, key })
    ).toBeUndefined();
  });

  test("ignores other tokens", () => {
    expect(isPublishToken("service-token")).toBe(false);
    expect(verifyPublishToken("service-token", { now, key })).toBeUndefined();
    expect(verifyPublishToken(undefined, { now, key })).toBeUndefined();
  });
});
