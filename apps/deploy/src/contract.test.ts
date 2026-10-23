// Fails when the Webstudio checkout's deployment/domain contract changes, so an upstream upgrade
// can't silently break Publish. Compares procedure names, kinds, and input/output schemas.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createRouter } from "./router";
import type { Publisher } from "./publisher";

// The checkout this service is in (apps/deploy).
const webstudioDir = join(import.meta.dirname, "../../..");

type Procedure = {
  _def: {
    inputs: z.ZodType[];
    output?: z.ZodType;
    query?: boolean;
    mutation?: boolean;
  };
};

// `z.undefined()` (used in domain outputs) has no JSON Schema form; it becomes {} on both sides.
const toJSONSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { unrepresentable: "any" });

const describeRouter = (procedures: Record<string, Procedure>) =>
  Object.fromEntries(
    Object.entries(procedures)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, { _def }]) => [
        name,
        {
          kind: _def.query
            ? "query"
            : _def.mutation
              ? "mutation"
              : "subscription",
          inputs: _def.inputs.map(toJSONSchema),
          output:
            _def.output === undefined ? undefined : toJSONSchema(_def.output),
        },
      ])
  );

describe("contract with the Webstudio checkout", () => {
  test("matches upstream sharedRouter", async () => {
    const { sharedRouter } = (await import(
      pathToFileURL(
        join(
          webstudioDir,
          "packages/trpc-interface/src/shared/shared-router.ts"
        )
      ).href
    )) as { sharedRouter: { _def: { procedures: Record<string, Procedure> } } };

    const ours = createRouter({} as Publisher) as unknown as {
      _def: { procedures: Record<string, Procedure> };
    };

    expect(describeRouter(ours._def.procedures)).toEqual(
      describeRouter(sharedRouter._def.procedures)
    );
  });
});
