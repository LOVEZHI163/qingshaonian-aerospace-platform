#!/bin/sh
set -eu

# sms-rollback-v1: verify a pre-018 archived release after the SMS-disabled wrapper starts it.
# Output is deliberately limited to non-secret status; this script never prints .env or request bodies.

if [ "$#" -ne 1 ]; then
  echo "usage: $0 ARCHIVED_RELEASE_DIR" >&2
  exit 64
fi

release_dir=$(CDPATH= cd -- "$1" && pwd -P)
compose_file="$release_dir/compose.yaml"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
override_file="$script_dir/legacy-sms-disabled.compose.yaml"
docker_bin=${DOCKER_BIN:-docker}
curl_bin=${CURL_BIN:-curl}
base_url=${BASE_URL:-http://127.0.0.1}
: "${ROLLBACK_SMOKE_PHONE:?ROLLBACK_SMOKE_PHONE is required}"
: "${ROLLBACK_SMOKE_PASSWORD_FILE:?ROLLBACK_SMOKE_PASSWORD_FILE is required}"

if [ ! -f "$compose_file" ] || [ ! -r "$override_file" ]; then
  echo "archived release or SMS rollback override is unavailable" >&2
  exit 66
fi
if [ ! -r "$ROLLBACK_SMOKE_PASSWORD_FILE" ]; then
  echo "ROLLBACK_SMOKE_PASSWORD_FILE is unreadable" >&2
  exit 66
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/aerogp-legacy-rollback-XXXXXX")
chmod 700 "$work_dir"
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM
response_file="$work_dir/response.json"
payload_file="$work_dir/request.json"

compose() {
  env \
    ALIBABA_CLOUD_ACCESS_KEY_ID= \
    ALIBABA_CLOUD_ACCESS_KEY_SECRET= \
    ALIYUN_SMS_SIGN_NAME= \
    ALIYUN_SMS_TEMPLATE_CODE= \
    ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE= \
    ALIYUN_SMS_LOGIN_TEMPLATE_CODE= \
    ALIYUN_SMS_RESET_TEMPLATE_CODE= \
    "$docker_bin" compose \
      --project-directory "$release_dir" \
      -f "$compose_file" \
      -f "$override_file" "$@"
}

assert_status() {
  label="$1"
  expected="$2"
  shift 2
  status=$("$curl_bin" -sS -o "$response_file" -w "%{http_code}" "$@") || {
    echo "$label request failed" >&2
    exit 1
  }
  if [ "$status" != "$expected" ]; then
    echo "$label expected $expected but received $status" >&2
    exit 1
  fi
}

api_node() {
  compose exec -T api node -e "$1"
}

migration_sql="SELECT count(*) FROM schema_migrations WHERE name IN ('017-account-email-recovery.sql', '018-sms-challenge-purposes.sql', '019-team-registration.sql');"
migration_count=$(compose exec -T postgres sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "$1"' \
  sh "$migration_sql" \
  | tr -d '[:space:]')
if [ "$migration_count" != "3" ]; then
  echo "additive migrations 017-019 are not all present" >&2
  exit 1
fi

assert_status "legacy-features" 200 "$base_url/api/public/features"
if ! api_node 'let raw="";process.stdin.on("data",chunk=>raw+=chunk).on("end",()=>{const value=JSON.parse(raw);if(value.smsPasswordResetEnabled!==false||value.emailPasswordResetEnabled!==true)process.exit(2);});' < "$response_file"; then
  echo "legacy feature flags did not keep SMS disabled and email enabled" >&2
  exit 1
fi

cat "$ROLLBACK_SMOKE_PASSWORD_FILE" | \
  compose exec -T -e ROLLBACK_SMOKE_PHONE api node -e 'let password="";process.stdin.on("data",chunk=>password+=chunk).on("end",()=>process.stdout.write(JSON.stringify({phone:process.env.ROLLBACK_SMOKE_PHONE,password})));' \
  > "$payload_file"
chmod 600 "$payload_file"
assert_status "legacy-password-login" 200 \
  -H 'Content-Type: application/json' --data-binary "@$payload_file" \
  "$base_url/api/auth/login"
if ! api_node 'let raw="";process.stdin.on("data",chunk=>raw+=chunk).on("end",()=>{const value=JSON.parse(raw);if(!value.user||!value.user.id)process.exit(2);});' < "$response_file"; then
  echo "legacy password login did not return an authenticated user" >&2
  exit 1
fi

printf '%s' '{"email":"rollback-sms-disabled-check@invalid.example"}' > "$payload_file"
assert_status "legacy-email-reset-request" 200 \
  -H 'Content-Type: application/json' --data-binary "@$payload_file" \
  "$base_url/api/auth/password-reset/email/request"
if ! api_node 'let raw="";process.stdin.on("data",chunk=>raw+=chunk).on("end",()=>{const value=JSON.parse(raw);if(value.ok!==true)process.exit(2);});' < "$response_file"; then
  echo "legacy email password-reset route did not remain available" >&2
  exit 1
fi

printf '%s\n' 'legacy-sms-disabled rollback smoke passed'
