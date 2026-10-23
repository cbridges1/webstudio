// Calls the server the way the builder does, through @webstudio-is/deploy-protocol's client.
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createDeployServiceClient,
  type PublishRequest,
} from "@webstudio-is/deploy-protocol";
import type { Publisher } from "./publisher";
import { createDeployerServer } from "./server";

const apiKey = "k".repeat(40);
const published: unknown[] = [];

const publisher = {
  status: () => ({ running: undefined, queued: 0 }),
  hosts: async () => [
    { id: "directory", label: "Folder", config: {}, credentials: null },
  ],
  validate: async () => ({ success: true as const }),
  publish: async (input: unknown) => {
    published.push(input);
    return { success: true as const };
  },
  unpublish: async () => ({ success: false as const, error: "nope" }),
  idle: async () => {},
} as unknown as Publisher;

const server = createDeployerServer({ publisher, apiKey });
let origin: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const target = { host: "directory", config: { site: "p1" } };
const publishRequest: PublishRequest = {
  buildId: "b1",
  builder: { origin: "https://builder.example.com", token: "t" },
  target,
};

describe("deployer server", () => {
  test("serves the builder's calls", async () => {
    const client = createDeployServiceClient({ url: origin, apiKey });
    expect(await client.publish(publishRequest)).toEqual({ success: true });
    expect(published).toEqual([publishRequest]);
    expect(await client.unpublish(target)).toEqual({
      success: false,
      error: "nope",
    });
    expect(await client.validate(target)).toEqual({ success: true });
    expect(await client.hosts()).toEqual({
      success: true,
      data: {
        hosts: [
          { id: "directory", label: "Folder", config: {}, credentials: null },
        ],
      },
    });
  });

  test("works behind a path prefix", async () => {
    const client = createDeployServiceClient({
      url: `${origin}/deploy/`,
      apiKey,
    });
    expect(await client.validate(target)).toEqual({ success: true });
  });

  test("rejects a wrong API key", async () => {
    const client = createDeployServiceClient({ url: origin, apiKey: "wrong" });
    expect(await client.publish(publishRequest)).toEqual({
      success: false,
      error: "The deploy service rejected its API key",
    });
  });

  test("rejects an invalid request", async () => {
    const response = await fetch(`${origin}/v1/publish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ buildId: "b1" }),
    });
    expect(response.status).toBe(400);
  });

  test("reports an unreachable service", async () => {
    const client = createDeployServiceClient({
      url: "http://127.0.0.1:1",
      apiKey,
    });
    const result = await client.validate(target);
    expect(result.success === false && result.error).toMatch(
      /^Can't reach the deploy service/
    );
  });

  test("health check needs no key", async () => {
    const response = await fetch(`${origin}/healthz`);
    expect(await response.json()).toEqual({ ok: true, queued: 0 });
  });
});
