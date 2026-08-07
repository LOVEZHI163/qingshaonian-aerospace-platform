#!/bin/sh
set -eu

umask 077

deploy_dir="${DEPLOY_DIR:-/opt/aerogp}"
backups_dir="${BACKUPS_DIR:-${deploy_dir}/backups}"
env_file="${ENV_FILE:-${deploy_dir}/.env}"

fail() {
  echo "Preflight failed: $1" >&2
  exit 1
}

test -d "$deploy_dir" || fail "deployment directory is missing"
test -f "$env_file" || fail "root-only environment file is missing"
test -d "$backups_dir" || fail "backup directory is missing"
test -w "$backups_dir" || fail "backup directory is not writable"
cd "$deploy_dir"

test -f apps/api/src/cli/cleanup-test-business-data.js \
  || fail "test-business-data cleanup command is missing"
test -f apps/api/src/cli/bootstrap-admin.js \
  || fail "administrator bootstrap command is missing"
test -f apps/api/src/data/migrations/007-multi-event-accounts.sql \
  || fail "multi-event migration is missing"
test -f apps/api/src/data/migrations/015-registration-identities-and-organization-leaders.sql \
  || fail "registration identity and organization leader migration is missing"
test -f apps/api/src/cli/postgres-migration-restart-smoke.js \
  || fail "PostgreSQL migration/restart smoke command is missing"
test -s apps/web/public/brand/mark.svg || fail "public brand mark is missing"
test -s apps/web/public/brand/wordmark.svg || fail "public brand wordmark is missing"
grep -Eq '^ARG VITE_PUBLIC_SITE_URL$' Dockerfile.web \
  || fail "web image does not accept the public site origin"
grep -Eq '^[[:space:]]+VITE_PUBLIC_SITE_URL:[[:space:]]+https://aerogp\.cn$' compose.yaml \
  || fail "web image canonical origin is not configured"

session_secret="$(awk '
  index($0, "SESSION_SECRET=") == 1 {
    sub(/^SESSION_SECRET=/, "")
    value = $0
  }
  END { if (value != "") print value }
' "$env_file")"
test "${#session_secret}" -ge 32 || fail "SESSION_SECRET must contain at least 32 characters"
unset session_secret

registration_id_encryption_key="$(awk '
  index($0, "REGISTRATION_ID_ENCRYPTION_KEY=") == 1 {
    sub(/^REGISTRATION_ID_ENCRYPTION_KEY=/, "")
    value = $0
  }
  END { if (value != "") print value }
' "$env_file")"
command -v openssl >/dev/null 2>&1 \
  || fail "openssl is required to validate REGISTRATION_ID_ENCRYPTION_KEY"
registration_id_encryption_key_canonical="$(
  printf '%s' "$registration_id_encryption_key" \
    | openssl base64 -d -A 2>/dev/null \
    | openssl base64 -A 2>/dev/null
)"
registration_id_encryption_key_bytes="$(
  printf '%s' "$registration_id_encryption_key" \
    | openssl base64 -d -A 2>/dev/null \
    | wc -c \
    | tr -d '[:space:]'
)"
test -n "$registration_id_encryption_key" \
  && test "$registration_id_encryption_key_canonical" = "$registration_id_encryption_key" \
  && test "$registration_id_encryption_key_bytes" = "32" \
  || fail "REGISTRATION_ID_ENCRYPTION_KEY must be valid base64 encoding exactly 32 bytes"
unset registration_id_encryption_key registration_id_encryption_key_canonical registration_id_encryption_key_bytes

docker compose config --quiet || fail "Compose configuration is invalid"

latest_dump="$(find "$backups_dir" -maxdepth 1 -type f -name 'aerogp-*.dump' -print | sort | tail -n 1)"
test -n "$latest_dump" || fail "no database dump was found"
test -s "$latest_dump" || fail "latest database dump is empty"
docker compose run --rm --no-deps -T backup pg_restore --list "/backups/$(basename "$latest_dump")" >/dev/null \
  || fail "latest database dump is unreadable"

latest_uploads="$(find "$backups_dir/uploads" -maxdepth 1 -type f -name 'aerogp-uploads-*.tar.gz' -print | sort | tail -n 1)"
test -n "$latest_uploads" || fail "no uploads backup was found"
test -s "$latest_uploads" || fail "latest uploads backup is empty"
docker compose run --rm --no-deps -T backup /bin/sh /scripts/verify-uploads-backup.sh \
  "/backups/uploads/$(basename "$latest_uploads")" >/dev/null \
  || fail "latest uploads backup is unreadable or unsafe"
site_media_state="$(docker compose run --rm --no-deps -T backup /bin/sh -c \
  'if test -d /uploads/site-media; then printf present; else printf absent; fi')"
if test "$site_media_state" = "present"; then
  docker compose run --rm --no-deps -T backup tar -tzf \
    "/backups/uploads/$(basename "$latest_uploads")" \
    | grep -Eq '^\./site-media(/|$)' \
    || fail "latest uploads backup does not contain site-media"
fi

uploads_kb="$(docker compose run --rm --no-deps -T backup du -sk /uploads | awk 'NR == 1 { print $1 }')"
case "$uploads_kb" in
  ''|*[!0-9]*) fail "could not measure uploads volume" ;;
esac
available_kb="$(df -Pk "$backups_dir" | awk 'NR == 2 { print $4 }')"
case "$available_kb" in
  ''|*[!0-9]*) fail "could not measure available disk space" ;;
esac
required_kb="$((uploads_kb * 2 + 1048576))"
test "$available_kb" -gt "$required_kb" \
  || fail "available disk space must exceed twice the uploads size plus 1 GiB"

smoke_database_suffix="$(openssl rand -hex 16)" \
  || fail "could not generate isolated PostgreSQL migration smoke database name"
test "${#smoke_database_suffix}" -eq 32 \
  || fail "isolated PostgreSQL migration smoke database suffix must contain 32 hex characters"
case "$smoke_database_suffix" in
  *[!0-9a-f]*) fail "isolated PostgreSQL migration smoke database suffix must contain only lowercase hex" ;;
esac
smoke_database="aerogp_migration_smoke_${smoke_database_suffix}"
unset smoke_database_suffix

database_names="$(docker compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT datname FROM pg_database"')" \
  || fail "could not inspect PostgreSQL databases before migration smoke"
if printf '%s\n' "$database_names" | grep -Fx "$smoke_database" >/dev/null; then
  fail "isolated PostgreSQL migration smoke database already exists"
fi
unset database_names

smoke_database_created=0
cleanup_smoke_database() {
  if test "$smoke_database_created" = "1"; then
    docker compose exec -T -e MIGRATION_SMOKE_DATABASE="$smoke_database" postgres sh -c \
      'dropdb -U "$POSTGRES_USER" --if-exists --force "$MIGRATION_SMOKE_DATABASE"' >/dev/null 2>&1 \
      || return 1
    smoke_database_created=0
  fi
}
trap cleanup_smoke_database EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

smoke_database_created=1
docker compose exec -T -e MIGRATION_SMOKE_DATABASE="$smoke_database" postgres sh -c \
  'createdb -U "$POSTGRES_USER" "$MIGRATION_SMOKE_DATABASE"' \
  || fail "could not create isolated PostgreSQL migration smoke database"
docker compose run --rm --no-deps -T \
  -e MIGRATION_SMOKE_DATABASE="$smoke_database" api sh -c '
    DATABASE_URL="${DATABASE_URL%/*}/$MIGRATION_SMOKE_DATABASE"
    export DATABASE_URL
    exec node apps/api/src/cli/postgres-migration-restart-smoke.js
  ' || fail "PostgreSQL migration/restart smoke failed"
cleanup_smoke_database || fail "could not remove isolated PostgreSQL migration smoke database"
trap - EXIT HUP INT TERM

for service in postgres api web backup; do
  container_id="$(docker compose ps -q "$service")"
  test -n "$container_id" || fail "$service container is not running"
  state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
  test "$state" = "running healthy" || fail "$service container is not healthy"
done

compose_port_is_published() {
  port_output="$(docker compose port "$1" "$2" 2>/dev/null || true)"
  case "$port_output" in
    *:[1-9][0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

if compose_port_is_published api 4300; then
  fail "API port 4300 must not be published"
fi
if compose_port_is_published postgres 5432; then
  fail "PostgreSQL port 5432 must not be published"
fi
if compose_port_is_published web 80; then
  fail "web port 80 must not be published directly"
fi
compose_port_is_published caddy 80 || fail "Caddy port 80 must be published"
compose_port_is_published caddy 443 || fail "Caddy port 443 must be published"

printf '%s\n' "Upgrade preflight passed."
