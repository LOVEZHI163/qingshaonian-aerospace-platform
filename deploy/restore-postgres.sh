#!/bin/sh
set -eu

if [ "${CONFIRM_RESTORE:-}" != "yes" ]; then
  echo "Set CONFIRM_RESTORE=yes to restore a backup." >&2
  exit 1
fi

backup_file="${1:-}"
if [ -z "$backup_file" ] || [ ! -s "$backup_file" ]; then
  echo "Pass a non-empty .dump file as the first argument." >&2
  exit 1
fi

pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --dbname="$PGDATABASE" \
  "$backup_file"
