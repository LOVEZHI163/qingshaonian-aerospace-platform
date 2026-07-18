#!/bin/sh
set -eu

archive="${1:?usage: verify-uploads-backup.sh ARCHIVE}"
test -f "$archive"
test -s "$archive"

listing="$(mktemp)"
verbose_listing="$(mktemp)"
trap 'rm -f "$listing" "$verbose_listing"' EXIT HUP INT TERM

tar -tzf "$archive" > "$listing"
tar -tvzf "$archive" > "$verbose_listing"
test -s "$listing"

if ! awk '
  /^\// { exit 1 }
  {
    count = split($0, parts, "/")
    for (part_index = 1; part_index <= count; part_index += 1) {
      if (parts[part_index] == "..") exit 1
    }
  }
' "$listing"; then
  echo "Uploads backup contains an unsafe path" >&2
  exit 1
fi

if ! awk '
  substr($0, 1, 1) == "l" || substr($0, 1, 1) == "h" { exit 1 }
' "$verbose_listing"; then
  echo "Uploads backup contains a symbolic or hard link" >&2
  exit 1
fi

printf '%s\n' "Uploads backup verified: $(basename "$archive")"
