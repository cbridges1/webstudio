/**
 * Checks that our Drizzle migrations produce the same database as upstream's
 * (Prisma) migrations, apart from the changes we make on purpose.
 *
 *   tsx scripts/check-schema.ts <empty database url>
 *     Applies every migration in ./drizzle to the empty database, then compares it
 *     with reference/upstream.json.
 *
 *   tsx scripts/check-schema.ts --write-reference <database url>
 *     Writes reference/upstream.json from a database that upstream's migrations
 *     were applied to (done once per upstream upgrade, in an upstream checkout).
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readFingerprint, type SchemaFingerprint } from "./schema-fingerprint";

const referencePath = fileURLToPath(
  new URL("../reference/upstream.json", import.meta.url)
);
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

// Upstream-only bookkeeping and PostgREST helper tables we don't carry.
const upstreamOnlyTables = [
  "_prisma_migrations",
  "domainsVirtual",
  "latestBuildVirtual",
];

/**
 * Entries we change on purpose. Each key (or key prefix ending in "*") may differ
 * from upstream, be missing, or be new.
 */
const intendedChanges: Array<{ key: string; reason: string }> = [
  {
    key: "column ClientReferences.reference",
    reason:
      "default gen_random_uuid() instead of extensions.uuid_generate_v4()",
  },
  {
    key: "column Project.publishedUrl",
    reason: "published site address per project, set by the deploy service",
  },
  {
    key: "view DashboardProject",
    reason: "adds Project.publishedUrl",
  },
  { key: "column User.emailVerified", reason: "Better Auth" },
  { key: "column User.updatedAt", reason: "Better Auth" },
  { key: "column User.role", reason: "Better Auth admin plugin" },
  { key: "column User.banned", reason: "Better Auth admin plugin" },
  { key: "column User.banReason", reason: "Better Auth admin plugin" },
  { key: "column User.banExpires", reason: "Better Auth admin plugin" },
  { key: "column AuthSession.*", reason: "Better Auth tables" },
  { key: "column AuthAccount.*", reason: "Better Auth tables" },
  { key: "column AuthVerification.*", reason: "Better Auth tables" },
  { key: "column AuthRateLimit.*", reason: "Better Auth tables" },
  { key: "constraint AuthSession.*", reason: "Better Auth tables" },
  { key: "constraint AuthAccount.*", reason: "Better Auth tables" },
  { key: "constraint AuthVerification.*", reason: "Better Auth tables" },
  { key: "constraint AuthRateLimit.*", reason: "Better Auth tables" },
  { key: "index Auth*", reason: "Better Auth tables" },
  {
    key: "column Build.publishError",
    reason: "why a publish failed, reported by the deploy service",
  },
  { key: "column DeployJob.*", reason: "the deploy job queue" },
  { key: "constraint DeployJob.*", reason: "the deploy job queue" },
  { key: "index DeployJob_*", reason: "the deploy job queue" },
  { key: "enum DeployJob*", reason: "the deploy job queue" },
  {
    key: "column DeployWorker.*",
    reason: "deploy services seen by the builder",
  },
  {
    key: "constraint DeployWorker.*",
    reason: "deploy services seen by the builder",
  },
  {
    key: "index DeployWorker_*",
    reason: "deploy services seen by the builder",
  },
  { key: "column DeploySettings.*", reason: "app admins' deployer settings" },
  {
    key: "constraint DeploySettings.*",
    reason: "app admins' deployer settings",
  },
  { key: "index DeploySettings_*", reason: "app admins' deployer settings" },
  { key: "column EmailSettings.*", reason: "app admins' SMTP settings" },
  { key: "constraint EmailSettings.*", reason: "app admins' SMTP settings" },
  { key: "index EmailSettings_*", reason: "app admins' SMTP settings" },
  {
    key: "column ProjectDeployTarget.*",
    reason: "each project's deploy target",
  },
  {
    key: "constraint ProjectDeployTarget.*",
    reason: "each project's deploy target",
  },
  {
    key: "index ProjectDeployTarget_*",
    reason: "each project's deploy target",
  },
];

const isIntended = (key: string) =>
  intendedChanges.some((change) =>
    change.key.endsWith("*")
      ? key.startsWith(change.key.slice(0, -1))
      : key === change.key
  );

/**
 * Postgres 16+ prints view definitions without table qualifiers where they are
 * unambiguous (`"projectId"` rather than `build."projectId"`), while the reference
 * was read from Postgres 15. Compare views with every qualifier removed, so the
 * check passes on either version.
 */
const unqualify = (definition: string) =>
  definition.replace(
    /(?<![\w"'])(?:"[^"]+"|[a-z_][a-z0-9_]*)\.(?=["a-z_])/gi,
    ""
  );

const isSame = (key: string, reference?: string, actual?: string) => {
  if (reference === actual) {
    return true;
  }
  if (
    key.startsWith("view ") &&
    reference !== undefined &&
    actual !== undefined
  ) {
    return unqualify(reference) === unqualify(actual);
  }
  return false;
};

const compare = (reference: SchemaFingerprint, actual: SchemaFingerprint) => {
  const problems: string[] = [];
  const keys = new Set([...Object.keys(reference), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) {
    if (isIntended(key) || isSame(key, reference[key], actual[key])) {
      continue;
    }
    if (reference[key] === undefined) {
      problems.push(`+ ${key}: ${actual[key]}`);
    } else if (actual[key] === undefined) {
      problems.push(`- ${key}: ${reference[key]}`);
    } else {
      problems.push(
        `~ ${key}\n    upstream: ${reference[key]}\n    ours:     ${actual[key]}`
      );
    }
  }
  return problems;
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args[0] === "--write-reference") {
    const url = args[1];
    if (url === undefined) {
      throw new Error(
        "Usage: check-schema.ts --write-reference <database url>"
      );
    }
    const fingerprint = await readFingerprint(url, {
      ignoreTables: upstreamOnlyTables,
    });
    await writeFile(referencePath, `${JSON.stringify(fingerprint, null, 2)}\n`);
    console.info(
      `Wrote ${Object.keys(fingerprint).length} entries to ${referencePath}`
    );
    return;
  }

  const url = args[0];
  if (url === undefined) {
    throw new Error("Usage: check-schema.ts <empty database url>");
  }
  const db = drizzle(url);
  await migrate(db, { migrationsFolder });
  await db.$client.end();

  const reference = JSON.parse(
    await readFile(referencePath, "utf8")
  ) as SchemaFingerprint;
  const actual = await readFingerprint(url);
  const problems = compare(reference, actual);
  if (problems.length > 0) {
    console.error(
      `Schema differs from upstream in ${
        problems.length
      } place(s):\n${problems.join("\n")}`
    );
    process.exit(1);
  }
  console.info("Schema matches upstream (apart from intended changes).");
};

await main();
