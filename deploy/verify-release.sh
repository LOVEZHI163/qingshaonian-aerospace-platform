#!/bin/sh
set -eu

base_url="${BASE_URL:-http://127.0.0.1}"
expected_release="${EXPECTED_RELEASE:?EXPECTED_RELEASE is required}"
umask 077
work_dir=

cleanup() {
  if [ -n "$work_dir" ]; then
    rm -rf "$work_dir"
  fi
}

handle_hup() {
  trap - 0 HUP INT TERM
  cleanup
  exit 129
}

handle_int() {
  trap - 0 HUP INT TERM
  cleanup
  exit 130
}

handle_term() {
  trap - 0 HUP INT TERM
  cleanup
  exit 143
}

trap 'cleanup' 0
trap 'handle_hup' HUP
trap 'handle_int' INT
trap 'handle_term' TERM

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/aerogp-release.XXXXXX")"
version_json="$work_dir/version.json"
admin_html="$work_dir/admin.html"
admin_asset="$work_dir/admin.js"

version_status="$(curl -fsS -o "$version_json" -w '%{http_code}' \
  -H 'Cache-Control: no-cache' \
  "$base_url/api/system/version")"
if [ "$version_status" != 200 ]; then
  echo "system-version expected 200 but received $version_status" >&2
  exit 1
fi

actual_release="$(node -e '
const fs = require("fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).releaseSha;
if (typeof value !== "string" || !value.trim()) process.exit(2);
process.stdout.write(value.trim());
' "$version_json")"
if [ "$actual_release" != "$expected_release" ]; then
  echo "API release does not match EXPECTED_RELEASE" >&2
  exit 1
fi

release_check="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]));' "$expected_release")"
admin_status="$(curl -fsS -o "$admin_html" -w '%{http_code}' \
  "$base_url/admin/index.html?release-check=$release_check")"
if [ "$admin_status" != 200 ]; then
  echo "admin HTML expected 200 but received $admin_status" >&2
  exit 1
fi

asset_path="$(node -e '
const fs = require("fs");
const html = fs.readFileSync(process.argv[1], "utf8");
const matches = [...html.matchAll(/src="(\/admin\/assets\/index-[A-Za-z0-9_-]+\.js)"/g)].map(m => m[1]);
if (matches.length !== 1) process.exit(2);
process.stdout.write(matches[0]);
' "$admin_html")"

asset_status="$(curl -fsS -o "$admin_asset" -w '%{http_code}' "$base_url$asset_path")"
if [ "$asset_status" != 200 ]; then
  echo "admin asset expected 200 but received $asset_status" >&2
  exit 1
fi
if ! grep -F -- "$expected_release" "$admin_asset" >/dev/null; then
  echo "admin asset does not contain EXPECTED_RELEASE" >&2
  exit 1
fi
if grep -F -- '/api/admin/registrations?pageSize=100' "$admin_asset" >/dev/null; then
  echo "admin asset contains the legacy registrations endpoint" >&2
  exit 1
fi

echo "release-consistency=$expected_release"
