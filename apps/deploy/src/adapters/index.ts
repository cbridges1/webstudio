import { directoryAdapter } from "./directory";
import { createFirebaseAdapter } from "./firebase";
import type { AnyHostAdapter } from "./types";

// Add a host by writing an adapter and registering it here.
export const createAdapters = (): Map<string, AnyHostAdapter> =>
  new Map<string, AnyHostAdapter>([
    [directoryAdapter.id, directoryAdapter],
    ["firebase", createFirebaseAdapter()],
  ]);
