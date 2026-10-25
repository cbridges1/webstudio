import pg from "pg";

export type Listener = { close: () => Promise<void> };

/**
 * LISTENs on `channel` over its own connection and keeps it open: after an error or a closed
 * connection (a database restart, or Neon suspending its compute) it reconnects with backoff
 * and calls `onConnect` again, so the caller can catch up on what it missed. Notifications
 * sent while disconnected are lost; treat them as hints, not as the source of truth.
 *
 * Needs a direct connection: transaction-mode poolers (PgBouncer, Neon's `-pooler` host)
 * accept LISTEN but never deliver notifications.
 */
export const listen = ({
  url,
  channel,
  onNotify,
  onConnect,
  log = (line) => console.info(line),
  maxBackoffMs = 30_000,
}: {
  url: string;
  channel: string;
  onNotify: (payload: string | undefined) => void;
  onConnect?: () => void;
  log?: (line: string) => void;
  maxBackoffMs?: number;
}): Listener => {
  let client: pg.Client | undefined;
  let closed = false;
  let backoff = 1000;
  let retry: NodeJS.Timeout | undefined;

  /** Closes a connection we're done with; its late errors must not crash the process. */
  const retire = async (old: pg.Client | undefined) => {
    old?.removeAllListeners();
    old?.on("error", () => {});
    await old?.end().catch(() => {});
  };

  const scheduleReconnect = (reason: string) => {
    if (closed || retry !== undefined) {
      return;
    }
    log(`LISTEN ${channel} lost (${reason}); reconnecting in ${backoff} ms`);
    const old = client;
    client = undefined;
    void retire(old);
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, backoff);
    backoff = Math.min(backoff * 2, maxBackoffMs);
  };

  const connect = async () => {
    // Detects a connection that died silently (e.g. a dropped network path).
    const next = new pg.Client({ connectionString: url, keepAlive: true });
    client = next;
    next.on("error", (error) => scheduleReconnect(error.message));
    next.on("end", () => scheduleReconnect("connection closed"));
    next.on("notification", (message) => {
      if (message.channel === channel) {
        onNotify(message.payload);
      }
    });
    try {
      await next.connect();
      await next.query(`LISTEN "${channel.replaceAll('"', '""')}"`);
    } catch (error) {
      scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    if (closed) {
      await retire(next);
      return;
    }
    backoff = 1000;
    onConnect?.();
  };

  void connect();

  return {
    close: async () => {
      closed = true;
      clearTimeout(retry);
      const last = client;
      client = undefined;
      await retire(last);
    },
  };
};
