import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";
import type { Db } from "./db";
import type { Database } from "./types";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * An in-process Postgres (PGlite) with every migration applied. Each call starts
 * an empty database.
 */
export const createTestDb = async (): Promise<
  Db & { close: () => Promise<void> }
> => {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return Object.assign(db as unknown as Db, { close: () => client.close() });
};

/** Removes every row from every table, keeping the schema. */
export const resetTestDb = async (db: Db) => {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  if (rows.length === 0) {
    return;
  }
  const names = rows.map((row) => `"${row.tablename}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE ${names} RESTART IDENTITY CASCADE`));
};

/**
 * Registers vitest hooks for a test database shared by the file and emptied before
 * each test. Returns a stand-in that forwards to the database once it's ready, so it
 * can be put into contexts at module level.
 *
 * @example
 * const db = setupTestDb();
 * const context = { ...createTestContext(db), authorization: { type: "service" } };
 */
export const setupTestDb = (): Db => {
  let db: (Db & { close: () => Promise<void> }) | undefined;
  beforeAll(async () => {
    db = await createTestDb();
  });
  beforeEach(async () => {
    if (db !== undefined) {
      await resetTestDb(db);
    }
  });
  afterAll(async () => {
    await db?.close();
  });
  return new Proxy({} as Db, {
    get(_target, property) {
      if (db === undefined) {
        throw new Error("The test database is only available inside tests");
      }
      const value = Reflect.get(db, property, db);
      return typeof value === "function" ? value.bind(db) : value;
    },
  });
};

type Insert<Name extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][Name] extends { Insert: infer Row }
    ? Row
    : never;

/**
 * Inserts rows with sensible defaults for required columns, returning what was
 * stored. Missing users (owners, members) are created too.
 */
export const seed = {
  user: async (db: Db, row: Partial<Insert<"User">> & { id: string }) => {
    const [stored] = await db
      .insert(schema.user)
      .values(row)
      .onConflictDoNothing()
      .returning();
    return stored;
  },

  workspace: async (
    db: Db,
    row: Partial<Insert<"Workspace">> & { id: string; userId: string }
  ) => {
    await seed.user(db, { id: row.userId });
    const [stored] = await db
      .insert(schema.workspace)
      .values({ name: "Workspace", ...row })
      .returning();
    return stored;
  },

  workspaceMember: async (db: Db, row: Insert<"WorkspaceMember">) => {
    await seed.user(db, { id: row.userId });
    const [stored] = await db
      .insert(schema.workspaceMember)
      .values(row)
      .returning();
    return stored;
  },

  project: async (db: Db, row: Partial<Insert<"Project">> & { id: string }) => {
    if (typeof row.userId === "string") {
      await seed.user(db, { id: row.userId });
    }
    const [stored] = await db
      .insert(schema.project)
      .values({ title: "Project", domain: `domain-${row.id}`, ...row })
      .returning();
    return stored;
  },

  build: async (
    db: Db,
    row: Partial<Insert<"Build">> & { id: string; projectId: string }
  ) => {
    const [stored] = await db
      .insert(schema.build)
      .values({ pages: "{}", ...row })
      .returning();
    return stored;
  },

  file: async (db: Db, row: Partial<Insert<"File">> & { name: string }) => {
    const [stored] = await db
      .insert(schema.file)
      .values({
        format: "png",
        size: 1,
        status: "UPLOADED",
        ...row,
      })
      .returning();
    return stored;
  },

  assetFolder: async (
    db: Db,
    row: Partial<Insert<"AssetFolder">> & { id: string; projectId: string }
  ) => {
    const [stored] = await db
      .insert(schema.assetFolder)
      .values({ name: row.id, ...row })
      .returning();
    return stored;
  },

  /** An asset and, unless it exists, its uploaded file. */
  asset: async (
    db: Db,
    row: Partial<Insert<"Asset">> & {
      id: string;
      projectId: string;
      name: string;
    },
    fileRow: Partial<Insert<"File">> = {}
  ) => {
    await db
      .insert(schema.file)
      .values({
        format: "png",
        size: 1,
        status: "UPLOADED",
        uploaderProjectId: row.projectId,
        ...fileRow,
        name: row.name,
      })
      .onConflictDoNothing();
    const [stored] = await db.insert(schema.asset).values(row).returning();
    return stored;
  },

  authorizationToken: async (
    db: Db,
    row: Partial<Insert<"AuthorizationToken">> & {
      token: string;
      projectId: string;
    }
  ) => {
    const [stored] = await db
      .insert(schema.authorizationToken)
      .values(row)
      .returning();
    return stored;
  },
};

type QueryKind = "select" | "insert" | "update" | "delete";

type QueryHook = (event: {
  kind: QueryKind;
  table: unknown;
  rows: unknown;
}) => Promise<void> | void;

/**
 * Wraps a database so `hook` runs after each awaited query, before its result is
 * returned. Lets tests make changes "concurrently", e.g. between two queries.
 * `table` is the table passed to `from()` / `insert()` / `update()` / `delete()`.
 */
export const withQueryHook = (inner: Db, hook: QueryHook): Db => {
  const wrap = (builder: object, kind: QueryKind, table: unknown): object =>
    new Proxy(builder, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "then" && typeof value === "function") {
          return (
            onFulfilled?: (rows: unknown) => unknown,
            onRejected?: (error: unknown) => unknown
          ) =>
            (target as Promise<unknown>)
              .then(async (rows) => {
                await hook({ kind, table, rows });
                return rows;
              })
              .then(onFulfilled, onRejected);
        }
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          // Keep wrapping the query builder chain (builders are thenable).
          if (
            result === null ||
            typeof result !== "object" ||
            typeof (result as { then?: unknown }).then !== "function"
          ) {
            return result;
          }
          return wrap(result, kind, property === "from" ? args[0] : table);
        };
      },
    });

  return new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      if (
        property === "select" ||
        property === "insert" ||
        property === "update" ||
        property === "delete"
      ) {
        return (...args: unknown[]) =>
          wrap(value.apply(target, args), property, args[0]);
      }
      return value.bind(target);
    },
  });
};
