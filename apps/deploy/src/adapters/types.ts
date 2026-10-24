import type { z } from "zod";

export type Log = (line: string) => void;

/**
 * One kind of host. Each project's target (set in the builder) picks a host, its config and
 * its credentials, so every project can deploy to a different account.
 */
export type HostAdapter<Config = unknown, Credentials = unknown> = {
  id: string;
  /** Shown in the builder. */
  label: string;
  /** Validates the target's `config`. It comes from the builder, so never trust paths in it. */
  configSchema: z.ZodType<Config>;
  /**
   * Validates the project's saved credentials (read from the builder's database). `undefined` when the host needs none. Its
   * `.describe()` tells people what to paste in the builder.
   */
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
