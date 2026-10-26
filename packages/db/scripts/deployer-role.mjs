// selfhost: creates (or updates) the deploy service's own database login, which can only take
// jobs and read projects' deploy targets (apps/deploy/README.md). Run after the migrations, as
// the database owner:
//
//   DATABASE_URL=... DEPLOY_DB_USER=webstudio_deployer DEPLOY_DB_PASSWORD=... \
//     node scripts/deployer-role.mjs
//
// Plain Node, so it runs from the builder image (for example as a migrate job).
import pg from "pg";

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
const role = process.env.DEPLOY_DB_USER || "webstudio_deployer";
const password = process.env.DEPLOY_DB_PASSWORD;

if (!url) {
  throw new Error("DATABASE_URL is not set");
}
if (/^[a-z_][a-z0-9_]*$/.test(role) === false) {
  throw new Error("DEPLOY_DB_USER must be a lowercase identifier");
}
if (!password || password.length < 16) {
  throw new Error("DEPLOY_DB_PASSWORD must be at least 16 characters");
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const exists = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = $1",
    [role]
  );
  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE ${role} LOGIN`);
  }
  // ALTER ROLE doesn't take parameters; the password is quoted as a literal.
  const quoted = await client.query("SELECT quote_literal($1) AS value", [
    password,
  ]);
  await client.query(
    `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${quoted.rows[0].value}`
  );
  await client.query(`
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role};
GRANT USAGE ON SCHEMA public TO ${role};
GRANT SELECT ("projectId", "host", "config", "credentials") ON "ProjectDeployTarget" TO ${role};
GRANT SELECT ON "DeployJob" TO ${role};
GRANT UPDATE ("status", "error", "result", "attempts", "workerId", "startedAt", "heartbeatAt", "finishedAt") ON "DeployJob" TO ${role};
GRANT SELECT, INSERT, UPDATE, DELETE ON "DeployWorker" TO ${role};
`);
  console.info(`Deploy service login ${role} is ready.`);
} finally {
  await client.end();
}
