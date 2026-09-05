#!/bin/sh
set -eu

umask 077

backup_once() {
  rm -f /tmp/aerogp-backup-alive
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="/backups/aerogp-${stamp}.dump"
  temp="${target}.tmp"

  rm -f "$temp"
  pg_dump --format=custom --no-owner --no-privileges --file="$temp"
  test -s "$temp"
  pg_restore --list "$temp" >/dev/null
  mv "$temp" "$target"
  /bin/sh /scripts/backup-uploads.sh
  find /backups -type f -name 'aerogp-*.dump' -mtime +7 -delete
  echo "Created $target"
}

backup_once
touch /tmp/aerogp-backup-alive

if [ "${1:-}" = "once" ]; then
  exit 0
fi

while :; do
  sleep "${BACKUP_INTERVAL_SECONDS:-86400}"
  backup_once
  touch /tmp/aerogp-backup-alive
done
