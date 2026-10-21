#!/usr/bin/env bash

builder_backend_init() {
  local mode="${1:?Builder backend mode is required}"
  ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
  local backend_dir="$ROOT_DIR/apps/builder/backend"
  local compose_override="$backend_dir/compose.${mode}.yaml"
  if [ ! -f "$compose_override" ]; then
    echo "Unknown Builder backend mode: $mode" >&2
    return 1
  fi

  if [ "$mode" = "development" ]; then
    export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-builder}"
  else
    # Disposable modes must never share the persistent development volume.
    export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-builder-e2e}"
  fi

  COMPOSE_ENV=(
    --env-file "$ROOT_DIR/apps/builder/.env"
  )
  if [ -f "$ROOT_DIR/apps/builder/.env.development" ]; then
    COMPOSE_ENV+=(--env-file "$ROOT_DIR/apps/builder/.env.development")
  fi
  COMPOSE_FILES=(
    -f "$backend_dir/compose.yaml"
    -f "$compose_override"
  )
}

builder_backend_schema_fingerprint() {
  (
    cd "$ROOT_DIR"
    {
      find packages/db/drizzle -type f -print
      find apps/builder/backend -type f ! -name '*.test.*' -print
    } | LC_ALL=C sort | while IFS= read -r file; do
      if [ -f "$file" ]; then
        printf '%s ' "$file"
        git hash-object "$file"
      else
        printf '%s directory\n' "$file"
      fi
    done
  ) | git hash-object --stdin
}

builder_backend_init_schema_snapshot() {
  SCHEMA_SNAPSHOT="${SCHEMA_SNAPSHOT:-$ROOT_DIR/.cache/builder-e2e/schema-$(builder_backend_schema_fingerprint).sql}"
}

builder_compose() {
  docker compose "${COMPOSE_ENV[@]}" "${COMPOSE_FILES[@]}" "$@"
}

builder_backend_down() {
  builder_compose down "$@"
}

builder_backend_pull_db() {
  builder_compose pull --policy missing db
}

builder_backend_start_db() {
  builder_compose up -d db
}

builder_backend_wait_for_db() {
  local timeout_seconds="${1:-60}"
  local timeout_at
  timeout_at="$(($(date +%s) + timeout_seconds))"

  # Connect over TCP, not the unix socket: the postgres image's entrypoint
  # runs a temporary socket-only server (listen_addresses='') during init,
  # which lets a socket probe pass while host clients (drizzle-kit migrate)
  # still get connection refused.
  until builder_compose exec -T db \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -q -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT 1"' \
    >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$timeout_at" ]; then
      echo "Timed out waiting for database" >&2
      return 1
    fi
    sleep 0.2
  done
}

builder_backend_schema_exists() {
  [ "$(
    builder_compose exec -T db \
      sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT to_regclass('\''public.\"Project\"'\'') IS NOT NULL"'
  )" = "t" ]
}

builder_backend_bootstrap_schema_snapshot() {
  if [ ! -f "$SCHEMA_SNAPSHOT" ]; then
    return 1
  fi

  builder_compose exec -T db \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
    <"$SCHEMA_SNAPSHOT" >/dev/null
}

builder_backend_migrate() {
  pnpm --dir "$ROOT_DIR" --filter=@webstudio-is/db migrate
  if ! builder_backend_schema_exists; then
    echo "Migrations completed without creating the Builder schema" >&2
    return 1
  fi
}

builder_backend_bootstrap() {
  case "${1:-auto}" in
    schema)
      builder_backend_bootstrap_schema_snapshot
      ;;
    migrations)
      builder_backend_migrate
      ;;
    auto)
      if [ -f "$SCHEMA_SNAPSHOT" ]; then
        builder_backend_bootstrap_schema_snapshot
        echo "Bootstrapped database from cached schema $SCHEMA_SNAPSHOT"
      else
        echo "No cached schema found at $SCHEMA_SNAPSHOT; running migrations"
        builder_backend_migrate
        builder_backend_write_schema_snapshot
      fi
      ;;
    *)
      echo "Unknown database bootstrap mode: $1" >&2
      exit 1
      ;;
  esac
}

builder_backend_bootstrap_if_empty() {
  if builder_backend_schema_exists; then
    echo "Database schema already exists; skipping bootstrap"
  else
    builder_backend_bootstrap auto
  fi
}

builder_backend_write_schema_snapshot() {
  mkdir -p "$(dirname "$SCHEMA_SNAPSHOT")"
  local temporary_snapshot="${SCHEMA_SNAPSHOT}.tmp.$$"
  # Dump the application schema and drizzle-kit's migration journal, so later
  # migrations apply on top of a restored snapshot.
  if builder_compose exec -T db \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --schema=public --schema=drizzle --clean --if-exists --no-owner --no-privileges' \
    >"$temporary_snapshot"; then
    mv "$temporary_snapshot" "$SCHEMA_SNAPSHOT"
  else
    rm -f "$temporary_snapshot"
    return 1
  fi
  echo "Wrote $SCHEMA_SNAPSHOT"
}
