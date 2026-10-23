// Calls the server the way the builder does: tRPC v10 httpBatchLink with the raw token in
// `Authorization` (packages/trpc-interface/src/shared/client.ts).
import type { AddressInfo } from "node:net";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Publisher } from "./publisher";
import { CUSTOM_DOMAINS_UNSUPPORTED, type DeployerRouter } from "./router";
import { createDeployerServer } from "./server";

const token = "t".repeat(40);
const published: unknown[] = [];

const publisher = {
  status: () => ({ running: undefined, queued: 0 }),
  publish: async (input: unknown) => {
    published.push(input);
    return { success: true as const };
  },
  unpublish: async () => ({ success: false as const, error: "nope" }),
  idle: async () => {},
} as unknown as Publisher;

const server = createDeployerServer({ publisher, token });
let origin: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const client = (authorization: string) =>
  createTRPCProxyClient<DeployerRouter>({
    links: [
      httpBatchLink({
        url: `${origin}/trpc`,
        headers: () => ({
          Authorization: authorization,
          "x-api-client": "service",
        }),
      }),
    ],
  });

const publishInput = {
  buildId: "b1",
  builderOrigin: "https://wstd.dev:5181",
  destination: "saas" as const,
  branchName: "main",
  logProjectName: "Project - p1",
};

describe("deployer server", () => {
  test("serves the builder's publish call", async () => {
    await expect(
      client(token).deployment.publish.mutate(publishInput)
    ).resolves.toEqual({
      success: true,
    });
    expect(published).toEqual([publishInput]);
  });

  test("passes unpublish errors through", async () => {
    await expect(
      client(token).deployment.unpublish.mutate({ domain: "x.wstd.work" })
    ).resolves.toEqual({ success: false, error: "nope" });
  });

  test("answers every domain procedure with a clear message", async () => {
    const api = client(token);
    const expected = { success: false, error: CUSTOM_DOMAINS_UNSUPPORTED };
    await expect(
      api.domain.create.mutate({ domain: "a.com", txtRecord: "t" })
    ).resolves.toEqual(expected);
    await expect(
      api.domain.refresh.mutate({ domain: "a.com" })
    ).resolves.toEqual(expected);
    await expect(
      api.domain.getStatus.query({ domain: "a.com" })
    ).resolves.toEqual(expected);
  });

  test("rejects a wrong or missing token", async () => {
    await expect(
      client("wrong").deployment.publish.mutate(publishInput)
    ).rejects.toThrow();
    const response = await fetch(`${origin}/trpc/deployment.publish?batch=1`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  test("health check needs no token", async () => {
    const response = await fetch(`${origin}/healthz`);
    expect(await response.json()).toEqual({ ok: true, queued: 0 });
  });
});
