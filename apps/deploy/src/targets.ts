// Resolves a target from the builder to its host adapter, validated config and credentials.
// Credentials are files in DEPLOY_CREDENTIALS_DIR (mounted from the host's secret manager),
// one per account; the builder only names one.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DeployTarget, HostInfo } from "@webstudio-is/deploy-protocol";
import type { AnyHostAdapter, HostAdapter } from "./adapters/types";

export type ResolvedTarget = {
  adapter: HostAdapter<unknown, unknown>;
  config: unknown;
  credentials: unknown;
};

export class TargetError extends Error {}

const readCredentials = async (
  adapter: AnyHostAdapter,
  credentialsDir: string,
  name: string
) => {
  let content: string;
  try {
    content = await readFile(join(credentialsDir, `${name}.json`), "utf8");
  } catch {
    return {
      success: false as const,
      error: `Credentials "${name}" not found`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    json = undefined;
  }
  const parsed = adapter.credentialsSchema?.safeParse(json);
  if (parsed === undefined || parsed.success === false) {
    // Don't echo the error: it can contain parts of the secret.
    return {
      success: false as const,
      error: `Credentials "${name}" are not valid for ${adapter.label}`,
    };
  }
  return { success: true as const, data: parsed.data };
};

export const resolveTarget = async ({
  target,
  credentialsDir,
  adapters,
}: {
  target: DeployTarget;
  credentialsDir: string;
  adapters: Map<string, AnyHostAdapter>;
}): Promise<ResolvedTarget> => {
  const adapter = adapters.get(target.host);
  if (adapter === undefined) {
    throw new TargetError(
      `This deploy service has no "${target.host}" host (it has: ${[...adapters.keys()].join(", ")})`
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
    if (target.credentials === undefined) {
      throw new TargetError(`${adapter.label} needs credentials`);
    }
    const result = await readCredentials(
      adapter,
      credentialsDir,
      target.credentials
    );
    if (result.success === false) {
      throw new TargetError(result.error);
    }
    credentials = result.data;
  }

  return { adapter, config: config.data, credentials };
};

/** The hosts for the builder's settings, each with the credentials valid for it. */
export const describeHosts = async ({
  credentialsDir,
  adapters,
}: {
  credentialsDir: string;
  adapters: Map<string, AnyHostAdapter>;
}): Promise<HostInfo[]> => {
  const names = await readdir(credentialsDir)
    .then((files) =>
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -".json".length))
        .sort()
    )
    .catch(() => []);

  return Promise.all(
    [...adapters.values()].map(async (adapter) => ({
      id: adapter.id,
      label: adapter.label,
      config: z.toJSONSchema(adapter.configSchema, { io: "input" }),
      credentials:
        adapter.credentialsSchema === undefined
          ? null
          : (
              await Promise.all(
                names.map(async (name) =>
                  (await readCredentials(adapter, credentialsDir, name)).success
                    ? name
                    : undefined
                )
              )
            ).filter((name) => name !== undefined),
    }))
  );
};
