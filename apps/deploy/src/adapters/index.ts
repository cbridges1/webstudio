import { createDirectoryAdapter } from "./directory";
import { createFirebaseAdapter } from "./firebase";
import type { AnyHostAdapter } from "./types";

// Add a host by writing an adapter and registering it here.
export const createAdapters = ({
  sitesDir,
}: {
  /** Root for the directory host; without it that host is off. */
  sitesDir?: string;
}): Map<string, AnyHostAdapter> => {
  const adapters: AnyHostAdapter[] = [createFirebaseAdapter()];
  if (sitesDir !== undefined) {
    adapters.unshift(createDirectoryAdapter(sitesDir));
  }
  return new Map(adapters.map((adapter) => [adapter.id, adapter]));
};
