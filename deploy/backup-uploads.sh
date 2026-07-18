#!/bin/sh
set -eu

umask 077

uploads_dir="${UPLOADS_DIR:-/uploads}"
backups_dir="${BACKUPS_DIR:-/backups}"
scripts_dir="${SCRIPTS_DIR:-/scripts}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
output_dir="${backups_dir}/uploads"
output="${output_dir}/aerogp-uploads-${timestamp}.tar.gz"
temp="${output}.tmp"
trap 'rm -f "$temp"' EXIT HUP INT TERM

test -d "$uploads_dir"
mkdir -p "$output_dir"
rm -f "$temp"

tar -C "$uploads_dir" -czf "$temp" .
/bin/sh "${scripts_dir}/verify-uploads-backup.sh" "$temp"
mv "$temp" "$output"
find "$output_dir" -type f -name 'aerogp-uploads-*.tar.gz' -mtime +7 -delete
printf '%s\n' "$output"
