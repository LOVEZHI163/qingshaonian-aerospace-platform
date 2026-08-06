#!/bin/sh
set -eu

umask 077

uploads_dir="${UPLOADS_DIR:-/uploads}"
backups_dir="${BACKUPS_DIR:-/backups}"
scripts_dir="${SCRIPTS_DIR:-/scripts}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
output_dir="${backups_dir}/uploads"
temp=""
reservation=""

cleanup() {
  test -z "$temp" || rm -f "$temp"
  test -z "$reservation" || rm -f "$reservation"
}
trap cleanup EXIT HUP INT TERM

test -d "$uploads_dir"
mkdir -p "$output_dir"
temp="$(mktemp "${output_dir}/.aerogp-upload-archive-XXXXXX")"

tar -C "$uploads_dir" -czf "$temp" .
/bin/sh "${scripts_dir}/verify-uploads-backup.sh" "$temp"
if test -d "$uploads_dir/site-media"; then
  tar -tzf "$temp" | grep -Eq '^\./site-media(/|$)'
fi

while :; do
  reservation="$(mktemp "${output_dir}/.aerogp-upload-name-${timestamp}-XXXXXX")"
  unique_suffix="${reservation##*-}"
  output="${output_dir}/aerogp-uploads-${timestamp}-${unique_suffix}.tar.gz"
  if ln "$temp" "$output"; then
    break
  fi
  if test -e "$output"; then
    rm -f "$reservation"
    reservation=""
    continue
  fi
  exit 1
done

rm -f "$temp" "$reservation"
temp=""
reservation=""
find "$output_dir" -type f -name 'aerogp-uploads-*.tar.gz' -mtime +7 -delete
printf '%s\n' "$output"
