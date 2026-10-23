import type { z } from "zod";

export type Log = (line: string) => void;

/**
 * One kind of host. Each project picks a host and its own config and credentials
 * (deploy-targets.json), so every project can deploy to a different account.
 */
export type HostAdapter<Config = unknown, Credentials = unknown> = {
  id: string;
  /** Validates the project's `config` from deploy-targets.json. */
  configSchema: z.ZodType<Config>;
  /** Validates the credential file. `undefined` when the host needs none. */
  credentialsSchema?: z.ZodType<Credentials>;
  deploy(input: {
    buildDir: string;
    config: Config;
    credentials: Credentials;
    log: Log;
  }): Promise<{ url: string }>;
  remove(input: {
    config: Config;
    credentials: Credentials;
    log: Log;
  }): Promise<void>;
};

/** Any registered adapter: each host has its own config and credentials types. */
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyHostAdapter = HostAdapter<any, any>;
