#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT_DIR/apps/builder/backend/lib.sh"
builder_backend_init development

# The migrations read the database settings like the builder does: the environment
# first, then apps/builder/.env.development, then apps/builder/.env.
read_builder_env() {
  (cd "$ROOT_DIR/apps/builder" && node -e '
    for (const file of [".env.development", ".env"]) {
      try { process.loadEnvFile(file); } catch {}
    }
    process.stdout.write(process.env[process.argv[1]] ?? "");
  ' "$1")
}
export DATABASE_URL="${DATABASE_URL:-$(read_builder_env DATABASE_URL)}"
export DIRECT_URL="${DIRECT_URL:-$(read_builder_env DIRECT_URL)}"
builder_backend_init_schema_snapshot

cleanup() {
  if [ "${LOCAL_DEV_CLEANUP:-${LOCAL_DEV_START_BUILDER:-true}}" != "true" ]; then
    return
  fi

  local down_args=(--remove-orphans)
  if [ "${LOCAL_DEV_CLEANUP_VOLUMES:-false}" = "true" ]; then
    down_args+=(--volumes)
  fi
  builder_backend_down "${down_args[@]}"
}

trap cleanup EXIT

if [ "${LOCAL_DEV_RESET_DB:-false}" = "true" ]; then
  builder_backend_down --volumes --remove-orphans
fi

builder_backend_start_db
builder_backend_wait_for_db
builder_backend_bootstrap_if_empty
# Apply migrations added since the database was created (a no-op when it's current).
builder_backend_migrate

if [ "${LOCAL_DEV_START_BUILDER:-true}" = "true" ]; then
  pnpm --dir "$ROOT_DIR" --filter=@webstudio-is/builder dev
fi
