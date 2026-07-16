#!/bin/sh
set -eu

latest="$(find /backups -maxdepth 1 -type f -name 'aerogp-*.dump' | sort | tail -n 1)"
if [ -z "$latest" ] || [ ! -s "$latest" ]; then
  echo "No non-empty AeroGP backup was found." >&2
  exit 1
fi

pg_restore --list "$latest" >/dev/null
size="$(wc -c < "$latest" | tr -d ' ')"
echo "backup-readable=yes"
echo "backup-size-bytes=$size"
