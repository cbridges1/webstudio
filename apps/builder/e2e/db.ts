import {
  and,
  authorizationToken,
  asset,
  build,
  createDb,
  desc,
  eq,
  file,
  isNull,
  one,
  project,
  sql,
  type Database,
} from "@webstudio-is/db";
import env from "../app/env/env.server";

const db = createDb(env.DATABASE_URL, { max: 2 });

/** Removes every row from every application table, keeping the schema. */
export const resetDatabase = async () => {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  if (rows.length === 0) {
    return;
  }
  const names = rows.map((row) => `"${row.tablename}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`));
};

/** Resolves once the database accepts queries. */
export const waitForDatabase = async (timeoutMs = 30_000) => {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await db.execute(sql`SELECT 1`);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for the database: ${String(lastError)}`);
};

type Tables = Database["public"]["Tables"];

export const updateBuild = async (id: string, row: Tables["Build"]["Update"]) =>
  one(await db.update(build).set(row).where(eq(build.id, id)).returning());

export const updateProject = async (
  id: string,
  row: Tables["Project"]["Update"]
) =>
  one(await db.update(project).set(row).where(eq(project.id, id)).returning());

export const insertAuthorizationToken = async (
  row: Tables["AuthorizationToken"]["Insert"]
) => one(await db.insert(authorizationToken).values(row).returning());

export const insertFile = async (row: Tables["File"]["Insert"]) =>
  one(await db.insert(file).values(row).returning());

export const insertAsset = async (row: Tables["Asset"]["Insert"]) =>
  one(await db.insert(asset).values(row).returning());

export const loadDevBuild = async ({
  projectId,
}: {
  projectId: string;
}): Promise<Tables["Build"]["Row"]> =>
  one(
    await db
      .select()
      .from(build)
      .where(and(eq(build.projectId, projectId), isNull(build.deployment)))
      .orderBy(desc(build.createdAt))
      .limit(1)
  );
