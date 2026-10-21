import pg from "pg";

/**
 * A normalized description of the `public` schema, read from the Postgres catalog:
 * columns, constraints, indexes, views and enums. Used to check that our Drizzle
 * migrations produce the same database as upstream's migrations.
 */
export type SchemaFingerprint = Record<string, string>;

export const readFingerprint = async (
  connectionString: string,
  { ignoreTables = [] }: { ignoreTables?: string[] } = {}
): Promise<SchemaFingerprint> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const entries: SchemaFingerprint = {};
    const ignored = new Set(ignoreTables);

    const enums = await client.query<{ name: string; labels: string }>(`
      SELECT t.typname AS name, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      GROUP BY t.typname`);
    for (const row of enums.rows) {
      entries[`enum ${row.name}`] = row.labels;
    }

    const columns = await client.query<{
      table: string;
      column: string;
      type: string;
      notnull: boolean;
      default: string | null;
      generated: string;
    }>(`
      SELECT c.relname AS table, a.attname AS column,
        format_type(a.atttypid, a.atttypmod) AS type,
        a.attnotnull AS notnull,
        pg_get_expr(d.adbin, d.adrelid) AS default,
        a.attgenerated AS generated
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`);
    for (const row of columns.rows) {
      if (ignored.has(row.table)) {
        continue;
      }
      const generated = row.generated === "s" ? " generated" : "";
      const def = row.default === null ? "" : ` default ${row.default}`;
      entries[`column ${row.table}.${row.column}`] =
        `${row.type}${row.notnull ? " not null" : ""}${generated}${def}`;
    }

    const constraints = await client.query<{
      table: string;
      name: string;
      def: string;
    }>(`
      SELECT c.relname AS table, con.conname AS name, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'`);
    for (const row of constraints.rows) {
      if (ignored.has(row.table)) {
        continue;
      }
      entries[`constraint ${row.table}.${row.name}`] = row.def;
    }

    const indexes = await client.query<{
      table: string;
      name: string;
      def: string;
    }>(`
      SELECT tablename AS table, indexname AS name, indexdef AS def
      FROM pg_indexes WHERE schemaname = 'public'`);
    for (const row of indexes.rows) {
      if (ignored.has(row.table)) {
        continue;
      }
      entries[`index ${row.name}`] = row.def;
    }

    const views = await client.query<{ name: string; def: string }>(`
      SELECT viewname AS name, definition AS def
      FROM pg_views WHERE schemaname = 'public'`);
    for (const row of views.rows) {
      entries[`view ${row.name}`] = row.def.replace(/\s+/g, " ").trim();
    }

    return Object.fromEntries(
      Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))
    );
  } finally {
    await client.end();
  }
};
