#!/bin/sh
set -eu

base_url="${BASE_URL:-http://127.0.0.1}"
admin_phone="${ADMIN_TEST_PHONE:-13900000000}"
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

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/aerogp-smoke.XXXXXX")"
response_file="$work_dir/response.json"
cookie_jar="$work_dir/cookies"
received_media_type=

assert_status() {
  label="$1"
  expected="$2"
  shift 2
  curl_status=0
  curl_meta="$(curl -sS -o "$response_file" -w '%{http_code}\n%{content_type}' "$@")" || curl_status=$?
  actual="$(printf '%s\n' "$curl_meta" | sed -n '1p')"
  received_media_type="$(printf '%s\n' "$curl_meta" | sed -n '2p')"
  if [ "$actual" != "$expected" ]; then
    echo "$label expected $expected but received $actual" >&2
    exit 1
  fi
  case "$expected:$curl_status" in
    4??:22|5??:22|*:0)
      ;;
    *)
      echo "$label curl failed with exit status $curl_status" >&2
      exit 1
      ;;
  esac
  echo "$label=$actual"
}

json_path() {
  script="$1"
  docker compose exec -T api node -e "$script" < "$response_file"
}

assert_json_response() {
  label="$1"
  case "$received_media_type" in
    application/json*)
      ;;
    *)
      echo "$label expected application/json but received ${received_media_type:-no Content-Type}" >&2
      exit 1
      ;;
  esac
  if ! json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data===null||typeof data!=="object"||Array.isArray(data))process.exit(2);});' >/dev/null; then
    echo "$label did not return a JSON object" >&2
    exit 1
  fi
}

assert_json_error() {
  label="$1"
  case "$received_media_type" in
    application/json*)
      ;;
    *)
      echo "$label expected application/json but received ${received_media_type:-no Content-Type}" >&2
      exit 1
      ;;
  esac
  if ! json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(typeof data.error!=="string"||!data.error.trim())process.exit(2);});' >/dev/null; then
    echo "$label did not return the required JSON error contract" >&2
    exit 1
  fi
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
assert_status "system-version" 200 \
  -H 'Cache-Control: no-cache' \
  "$base_url/api/system/version"

admin_password="${ADMIN_TEST_PASSWORD:?ADMIN_TEST_PASSWORD is required}"
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
assert_json_response "admin-events"
event_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);const event=(data.rows||[]).find(item=>item.status === "published" && !item.archivedAt);if(event&&event.id)process.stdout.write(encodeURIComponent(event.id));});')"
if test -z "$event_id"; then
  echo "No published, non-archived event is available for administrator smoke coverage" >&2
  exit 1
fi

assert_status "admin-organizations" 200 \
  -b "$cookie_jar" \
  "$base_url/api/admin/organizations"
assert_json_response "admin-organizations"

assert_status "admin-event-error" 404 \
  -b "$cookie_jar" \
  "$base_url/api/admin/events/__smoke_missing_event__/registrations"
assert_json_error "admin-event-error"

assert_status "admin-organization-error" 404 \
  -b "$cookie_jar" \
  "$base_url/api/admin/organizations/__smoke_missing_organization__"
assert_json_error "admin-organization-error"

assert_status "account-events" 200 \
  -b "$cookie_jar" \
  "$base_url/api/me/events"
# The pre-upgrade query route intentionally does not exist: administrators must
# put the event context in the path and cannot fall back to an implicit event.
assert_status "admin-registrations-legacy-rejected" 404 \
  -b "$cookie_jar" \
  "$base_url/api/admin/registrations"
assert_status "admin-registrations-event" 200 \
  -b "$cookie_jar" \
  "$base_url/api/admin/events/${event_id}/registrations"

assert_status "authenticated-site-settings" 200 \
  -b "$cookie_jar" \
  "$base_url/api/admin/site-settings"
assert_status "authenticated-site-content" 200 \
  -b "$cookie_jar" \
  "$base_url/api/admin/content"
assert_status "unauthenticated-site-settings" 401 \
  "$base_url/api/admin/site-settings"
