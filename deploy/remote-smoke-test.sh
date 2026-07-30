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

json_path() {
  script="$1"
  docker compose exec -T api node -e "$script" < "$response_file"
}

assert_status "healthz" 200 "$base_url/healthz"
assert_status "home" 200 "$base_url/"
assert_status "admin" 200 "$base_url/admin/"
assert_status "public-home" 200 "$base_url/api/public/home"

event_path="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);const event=data.featuredEvent||(data.concurrentEvents||[])[0];if(event&&event.slug)process.stdout.write("/api/public/events/"+encodeURIComponent(event.slug));});')"
if test -n "$event_path"; then
  assert_status "public-event" 200 "$base_url$event_path"
else
  echo "public-event-skipped=no-public-event"
fi

assert_status "public-content" 200 "$base_url/api/public/content?pageSize=1"
content_path="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);const row=(data.rows||[])[0];if(row&&row.slug)process.stdout.write("/api/public/content/"+encodeURIComponent(row.slug));});')"
if test -n "$content_path"; then
  assert_status "public-content-detail" 200 "$base_url$content_path"
else
  echo "public-content-detail-skipped=no-public-content"
fi

assert_status "sitemap" 200 "$base_url/api/public/sitemap.xml"
assert_status "brand-mark" 200 "$base_url/brand/mark.svg"
assert_status "brand-wordmark" 200 "$base_url/brand/wordmark.svg"

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

assert_status "admin-events" 200 \
  -b "$cookie_jar" \
  "$base_url/api/admin/events"
event_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);const event=(data.rows||[]).find(item=>item.status === "published" && !item.archivedAt);if(event&&event.id)process.stdout.write(encodeURIComponent(event.id));});')"
if test -z "$event_id"; then
  echo "No published, non-archived event is available for administrator smoke coverage" >&2
  exit 1
fi

assert_status "account-events" 200 \
  -b "$cookie_jar" \
  "$base_url/api/me/events"
assert_status "admin-registrations-event" 200 \
  -b "$cookie_jar" \
  "$base_url/api/admin/events/${event_id}/registrations"
# The pre-upgrade query route intentionally does not exist: administrators must
# put the event context in the path and cannot fall back to an implicit event.
assert_status "admin-registrations-legacy-rejected" 404 \
  -b "$cookie_jar" \
  "$base_url/api/admin/registrations"

assert_status "authenticated-site-settings" 200 \
  -b "$cookie_jar" \
  "$base_url/api/admin/site-settings"
assert_status "authenticated-site-content" 200 \
  -b "$cookie_jar" \
  "$base_url/api/admin/content"
assert_status "unauthenticated-site-settings" 401 \
  "$base_url/api/admin/site-settings"
