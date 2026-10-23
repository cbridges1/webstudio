// Which host and account each project deploys to. Read from DEPLOY_CONFIG on every job so an
// admin's edits apply without a restart. Credentials are separate files, one per account, in
// DEPLOY_CREDENTIALS_DIR (mounted from the host's secret manager), referenced by name.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AnyHostAdapter, HostAdapter } from "./adapters/types";

const targetSchema = z.object({
  host: z.string(),
  config: z.unknown(),
  /** File name (without .json) in DEPLOY_CREDENTIALS_DIR. Never the secret itself. */
  credentials: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/, "letters, digits, '.', '_' and '-' only")
    .optional(),
});

const fileSchema = z.object({
  projects: z.record(z.string(), targetSchema),
});

export type ResolvedTarget = {
  adapter: HostAdapter<unknown, unknown>;
  config: unknown;
  credentials: unknown;
};

export class TargetError extends Error {}

export const resolveTarget = async ({
  projectId,
  configPath,
  credentialsDir,
  adapters,
}: {
  projectId: string;
  configPath: string;
  credentialsDir: string;
  adapters: Map<string, AnyHostAdapter>;
}): Promise<ResolvedTarget> => {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new TargetError(
      `Can't read deploy config ${configPath}: ${String(error)}`
    );
  }
  const file = fileSchema.safeParse(JSON.parse(raw));
  if (file.success === false) {
    throw new TargetError(`Invalid deploy config: ${file.error.message}`);
  }

  const target = file.data.projects[projectId];
  if (target === undefined) {
    throw new TargetError(
      `This project has no deploy target. Ask an admin to add project ${projectId} to the deploy config.`
    );
  }

  const adapter = adapters.get(target.host);
  if (adapter === undefined) {
    throw new TargetError(
      `Unknown host "${target.host}" for project ${projectId} (known: ${[...adapters.keys()].join(", ")})`
    );
  }

  const config = adapter.configSchema.safeParse(target.config);
  if (config.success === false) {
    throw new TargetError(
      `Invalid ${adapter.id} config for project ${projectId}: ${config.error.message}`
    );
  }

  let credentials: unknown;
  if (adapter.credentialsSchema !== undefined) {
    if (target.credentials === undefined) {
      throw new TargetError(
        `Project ${projectId} uses ${adapter.id} but names no credentials`
      );
    }
    const path = join(credentialsDir, `${target.credentials}.json`);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      throw new TargetError(`Credentials "${target.credentials}" not found`);
    }
    const parsed = adapter.credentialsSchema.safeParse(JSON.parse(content));
    if (parsed.success === false) {
      // Don't echo the error: it can contain parts of the secret.
      throw new TargetError(
        `Credentials "${target.credentials}" are not valid for ${adapter.id}`
      );
    }
    credentials = parsed.data;
  }

  return { adapter, config: config.data, credentials };
};
