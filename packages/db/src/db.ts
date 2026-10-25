import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;

/**
 * A Drizzle database (or transaction) over our schema. The app uses node-postgres;
 * tests use PGlite behind the same type. Both return `{ rows }` from `execute`, but
 * only node-postgres has `rowCount`, so count affected rows with `.returning()`.
 */
export type Db = Omit<NodePgDatabase<Schema>, "$client">;

// Options from old connection strings that node-postgres would forward to the server
// as unknown runtime parameters.
const unsupportedParams = ["pgbouncer", "connection_limit", "pool_timeout"];

const normalizeUrl = (url: string) => {
  const parsed = new URL(url);
  for (const param of unsupportedParams) {
    parsed.searchParams.delete(param);
  }
  return parsed.toString();
};

export const createDb = (
  url: string,
  options: { max?: number } = {}
): NodePgDatabase<Schema> & { $client: pg.Pool } => {
  const pool = new pg.Pool({
    connectionString: normalizeUrl(url),
    max: options.max,
  });
  // An idle connection the server closed (a restart, or Neon suspending its compute) would
  // otherwise crash the process; the pool opens a new one for the next query.
  pool.on("error", (error) => {
    console.warn(`Database connection closed: ${error.message}`);
  });
  return drizzle(pool, { schema });
};

declare global {
  // Reused across dev-server reloads so each reload doesn't open a new pool.
  // eslint-disable-next-line no-var
  var webstudioDb: (NodePgDatabase<Schema> & { $client: pg.Pool }) | undefined;
}

/** The process-wide database for `url`, created on first use. */
export const getDb = (url: string) => {
  globalThis.webstudioDb ??= createDb(url);
  return globalThis.webstudioDb;
};
