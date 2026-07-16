#!/bin/sh
set -eu

base_url="${BASE_URL:-http://127.0.0.1}"
response_file="/tmp/aerogp-smoke-response.json"
trap 'rm -f "$response_file"' EXIT

assert_status() {
  label="$1"
  expected="$2"
  shift 2
  actual="$(curl -sS -o "$response_file" -w '%{http_code}' "$@")"
  if [ "$actual" != "$expected" ]; then
    echo "$label expected $expected but received $actual" >&2
    cat "$response_file" >&2
    exit 1
  fi
  echo "$label=$actual"
}

assert_status "home" 200 "$base_url/"
assert_status "admin" 200 "$base_url/admin/"
assert_status "event-api" 200 "$base_url/api/public/event"

register_status="$(curl -sS -o "$response_file" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d '{"name":"部署持久化测试用户","phone":"13600009999","password":"test-only-123456"}' \
  "$base_url/api/auth/register")"
if [ "$register_status" != "201" ] && [ "$register_status" != "409" ]; then
  echo "register expected 201 or 409 but received $register_status" >&2
  cat "$response_file" >&2
  exit 1
fi
echo "register=$register_status"

assert_status "login" 200 \
  -H 'Content-Type: application/json' \
  -d '{"phone":"13600009999","password":"test-only-123456"}' \
  "$base_url/api/auth/login"
