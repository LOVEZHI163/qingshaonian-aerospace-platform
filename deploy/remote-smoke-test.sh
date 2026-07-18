#!/bin/sh
set -eu

base_url="${BASE_URL:-http://127.0.0.1}"
admin_phone="${ADMIN_TEST_PHONE:-13900000000}"
admin_password="${ADMIN_TEST_PASSWORD:?ADMIN_TEST_PASSWORD is required}"
response_file="/tmp/aerogp-smoke-response-$$.json"
cookie_jar="/tmp/aerogp-smoke-cookie-$$"
trap 'rm -f "$response_file" "$cookie_jar"' EXIT HUP INT TERM
umask 077

assert_status() {
  label="$1"
  expected="$2"
  shift 2
  actual="$(curl -sS -o "$response_file" -w '%{http_code}' "$@")"
  if [ "$actual" != "$expected" ]; then
    echo "$label expected $expected but received $actual" >&2
    exit 1
  fi
  echo "$label=$actual"
}

assert_status "home" 200 "$base_url/"
assert_status "admin" 200 "$base_url/admin/"
assert_status "event-api" 200 "$base_url/api/public/event"

if printf '%s' "$admin_phone$admin_password" | LC_ALL=C grep -q '[[:cntrl:]]'; then
  echo "Administrator smoke-test credentials must be single-line values" >&2
  exit 1
fi
escaped_phone="$(printf '%s' "$admin_phone" | sed 's/\\/\\\\/g; s/"/\\"/g')"
escaped_password="$(printf '%s' "$admin_password" | sed 's/\\/\\\\/g; s/"/\\"/g')"
login_payload="{\"phone\":\"${escaped_phone}\",\"password\":\"${escaped_password}\"}"

printf '%s' "$login_payload" | \
  assert_status "login" 200 \
    -c "$cookie_jar" \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    "$base_url/api/auth/login"

unset admin_password escaped_password login_payload

assert_status "authenticated-admin-events" 200 \
  -b "$cookie_jar" \
  "$base_url/api/admin/events"
assert_status "unauthenticated-admin-events" 401 \
  "$base_url/api/admin/events"
