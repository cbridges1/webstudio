// Resolves a project's saved target to its host adapter, validated config and credentials.
// All of it comes from the builder's database (store.ts); this service keeps the credentials
// in memory for the job only.
import { z } from "zod";
import type { HostInfo } from "@webstudio-is/deploy-protocol";
import type { AnyHostAdapter, HostAdapter } from "./adapters/types";
import type { LoadCredentials, LoadTarget } from "./store";

export type ResolvedTarget = {
  adapter: HostAdapter<unknown, unknown>;
  config: unknown;
  credentials: unknown;
};

export class TargetError extends Error {}

export const resolveTarget = async ({
  projectId,
  adapters,
  loadTarget,
  loadCredentials,
}: {
  projectId: string;
  adapters: Map<string, AnyHostAdapter>;
  loadTarget: LoadTarget;
  loadCredentials: LoadCredentials;
}): Promise<ResolvedTarget> => {
  const target = await loadTarget(projectId);
  if (target === undefined) {
    throw new TargetError(
      "This project has no deploy target. Choose one in Project settings → Deploy."
    );
  }
  const adapter = adapters.get(target.host);
  if (adapter === undefined) {
    throw new TargetError(
      `This deploy service has no "${target.host}" host (it has: ${[
        ...adapters.keys(),
      ].join(", ")})`
    );
  }

  const config = adapter.configSchema.safeParse(target.config);
  if (config.success === false) {
    throw new TargetError(
      `Invalid ${adapter.label} settings: ${z.prettifyError(config.error)}`
    );
  }

  let credentials: unknown;
  if (adapter.credentialsSchema !== undefined) {
    const saved = await loadCredentials(projectId, target.host);
    if (saved === undefined) {
      throw new TargetError(
        `${adapter.label} needs credentials: add them in Project settings → Deploy`
      );
    }
    const parsed = adapter.credentialsSchema.safeParse(saved);
    if (parsed.success === false) {
      // Name the fields only: messages can quote parts of the secret.
      const fields = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join("."))),
      ].filter((field) => field !== "");
      throw new TargetError(
        `The credentials aren't valid for ${adapter.label}${
          fields.length > 0 ? ` (check ${fields.join(", ")})` : ""
        }`
      );
    }
    credentials = parsed.data;
  }

  return { adapter, config: config.data, credentials };
};

/** The hosts for the builder's settings form. */
export const describeHosts = (
  adapters: Map<string, AnyHostAdapter>
): HostInfo[] =>
  [...adapters.values()].map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    config: z.toJSONSchema(adapter.configSchema, { io: "input" }),
    credentials:
      adapter.credentialsSchema === undefined
        ? null
        : z.toJSONSchema(adapter.credentialsSchema, { io: "input" }),
  }));
