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

docker compose config --quiet || fail "Compose configuration is invalid"

session_secret="$(awk '
  index($0, "SESSION_SECRET=") == 1 {
    sub(/^SESSION_SECRET=/, "")
    value = $0
  }
  END { if (value != "") print value }
' "$env_file")"
test "${#session_secret}" -ge 32 || fail "SESSION_SECRET must contain at least 32 characters"
unset session_secret

latest_dump="$(find "$backups_dir" -maxdepth 1 -type f -name 'aerogp-*.dump' -print | sort | tail -n 1)"
test -n "$latest_dump" || fail "no database dump was found"
test -s "$latest_dump" || fail "latest database dump is empty"
docker compose exec -T backup pg_restore --list "/backups/$(basename "$latest_dump")" >/dev/null \
  || fail "latest database dump is unreadable"

latest_uploads="$(find "$backups_dir/uploads" -maxdepth 1 -type f -name 'aerogp-uploads-*.tar.gz' -print | sort | tail -n 1)"
test -n "$latest_uploads" || fail "no uploads backup was found"
test -s "$latest_uploads" || fail "latest uploads backup is empty"
docker compose exec -T backup /bin/sh /scripts/verify-uploads-backup.sh \
  "/backups/uploads/$(basename "$latest_uploads")" >/dev/null \
  || fail "latest uploads backup is unreadable or unsafe"

uploads_kb="$(docker compose exec -T backup du -sk /uploads | awk 'NR == 1 { print $1 }')"
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

for service in postgres api web backup; do
  container_id="$(docker compose ps -q "$service")"
  test -n "$container_id" || fail "$service container is not running"
  state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
  test "$state" = "running healthy" || fail "$service container is not healthy"
done

test -z "$(docker compose port api 4300 2>/dev/null || true)" \
  || fail "API port 4300 must not be published"
test -z "$(docker compose port postgres 5432 2>/dev/null || true)" \
  || fail "PostgreSQL port 5432 must not be published"
test -n "$(docker compose port web 80 2>/dev/null || true)" \
  || fail "web port 80 must be published"

printf '%s\n' "Upgrade preflight passed."
