#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$script_dir/smoke-credentials.sh"

base_url="${BASE_URL:-http://127.0.0.1}"
admin_phone="${ADMIN_TEST_PHONE:-13900000000}"
remote_smoke_auth_only="${REMOTE_SMOKE_AUTH_ONLY:-false}"
case "$remote_smoke_auth_only" in
  true|false) ;;
  *) echo "REMOTE_SMOKE_AUTH_ONLY must be true or false" >&2; exit 1 ;;
esac
umask 077
work_dir=

cleanup() {
  cleanup_failed=0
  if [ -n "${smoke_registration_container_file:-}" ]; then
    if smoke_remove_container_registration_token "$smoke_registration_container_file"; then
      smoke_registration_container_file=
    else
      cleanup_failed=1
    fi
  fi
  if command -v cleanup_submission_smoke >/dev/null 2>&1; then
    cleanup_submission_smoke || cleanup_failed=1
  fi
  if command -v cleanup_organization_smoke >/dev/null 2>&1; then
    cleanup_organization_smoke || cleanup_failed=1
  fi
  if [ -n "$work_dir" ]; then
    rm -rf "$work_dir" || cleanup_failed=1
  fi
  return "$cleanup_failed"
}

handle_exit() {
  status="$?"
  trap - 0 HUP INT TERM
  if ! cleanup; then
    echo "release smoke cleanup failed after exit status $status" >&2
    if [ "$status" -eq 0 ]; then
      status=1
    fi
  fi
  exit "$status"
}

handle_signal() {
  signal="$1"
  status="$2"
  trap - 0 HUP INT TERM
  if ! cleanup; then
    echo "release smoke cleanup failed while handling $signal" >&2
  fi
  exit "$status"
}

trap 'handle_exit' 0
trap 'handle_signal HUP 129' HUP
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/aerogp-smoke.XXXXXX")"
response_file="$work_dir/response.json"
cookie_jar="$work_dir/cookies"
received_media_type=
smoke_event_id=
smoke_event_name=
smoke_source_event_id=
smoke_event_cleanup_pending=0
smoke_user_id=
smoke_user_name=
smoke_user_phone=
smoke_user_cleanup_pending=0
smoke_organization_id=
smoke_organization_name=
smoke_organization_user_id=
smoke_organization_phone=
smoke_foreign_organization_id=
smoke_foreign_organization_name=
smoke_foreign_organization_user_id=
smoke_foreign_organization_phone=
smoke_organization_token=
smoke_organization_cleaned=0
smoke_foreign_organization_cleaned=0
smoke_organization_cleanup_pending=0
smoke_foreign_organization_cleanup_pending=0

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

add_student_id() {
  student_id="$1"
  STUDENT_ID="$student_id" docker compose exec -T -e STUDENT_ID api node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk).on("end", () => {
      const data = JSON.parse(input);
      data.studentIdNumber = process.env.STUDENT_ID;
      process.stdout.write(JSON.stringify(data));
    });
  '
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

assert_json_error_code() {
  label="$1"
  expected_code="$2"
  assert_json_error "$label"
  if ! EXPECTED_CODE="$expected_code" docker compose exec -T -e EXPECTED_CODE api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.code!==process.env.EXPECTED_CODE)process.exit(2);});' < "$response_file" >/dev/null; then
    echo "$label did not return the expected stable error code" >&2
    exit 1
  fi
}

assert_status "healthz" 200 "$base_url/healthz"
assert_status "home" 200 "$base_url/"
assert_status "admin" 200 "$base_url/admin/"
assert_status "public-home" 200 "$base_url/api/public/home"

assert_status "public-features" 200 "$base_url/api/public/features"
assert_json_response "public-features"
sms_feature_state="$work_dir/sms-feature-state"
if ! json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);for(const name of ["smsRegistrationEnabled","smsLoginEnabled","smsPasswordResetEnabled"]){if(typeof data[name]!=="boolean")process.exit(2);process.stdout.write(String(data[name])+"\n");}});' > "$sms_feature_state"; then
  echo "public-features did not return three boolean SMS feature flags" >&2
  exit 1
fi
sms_registration_enabled="$(sed -n '1p' "$sms_feature_state")"
sms_login_enabled="$(sed -n '2p' "$sms_feature_state")"
sms_password_reset_enabled="$(sed -n '3p' "$sms_feature_state")"

check_sms_request_when_disabled() {
  label="$1"
  feature_enabled="$2"
  endpoint="$3"
  case "$feature_enabled" in
    true)
      echo "$label=enabled-no-send"
      ;;
    false)
      printf '%s' '{"phone":"13800000001","captchaVerifyParam":""}' | \
      assert_status "$label-disabled" 503 \
        -H 'Content-Type: application/json' --data-binary @- \
        "$base_url$endpoint"
      assert_json_error "$label-disabled"
      ;;
    *)
      echo "$label feature flag was not boolean" >&2
      exit 1
      ;;
  esac
}

check_sms_request_when_disabled \
  "sms-registration" "$sms_registration_enabled" "/api/auth/register/sms/request"
check_sms_request_when_disabled \
  "sms-login" "$sms_login_enabled" "/api/auth/sms-login/request"
check_sms_request_when_disabled \
  "sms-reset" "$sms_password_reset_enabled" "/api/auth/password-reset/sms/request"

printf '%s' '{"email":"nobody-smoke@example.invalid","captchaVerifyParam":""}' | \
assert_status "email-reset-request" 200 \
  -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/auth/password-reset/email/request"
assert_json_response "email-reset-request"

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
# Successful boundary check emits: organization-relations-unauthenticated=401
assert_status "organization-relations-unauthenticated" 401 \
  -X GET \
  "$base_url/api/me/organization-relations"

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

assert_status "organization-memberships-admin-forbidden" 403 \
  -b "$cookie_jar" \
  -X GET \
  "$base_url/api/organization/memberships"

assert_status "organization-records-shell" 200 \
  -b "$cookie_jar" \
  "$base_url/admin/?view=organizationRecords"

assert_status "admin-events" 200 \
  -b "$cookie_jar" \
  "$base_url/api/admin/events"
assert_json_response "admin-events"
event_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);const event=(data.rows||[]).find(item=>item.status === "published" && !item.archivedAt);if(event&&event.id)process.stdout.write(encodeURIComponent(event.id));});')"
if test -z "$event_id"; then
  echo "No published, non-archived event is available for administrator smoke coverage" >&2
  exit 1
fi
smoke_source_event_id="$event_id"

assert_status "admin-organizations" 200 \
  -b "$cookie_jar" \
  "$base_url/api/admin/organizations"
assert_json_response "admin-organizations"

assert_status "admin-users" 200 \
  -b "$cookie_jar" \
  "$base_url/api/users"
assert_json_response "admin-users"
if ! json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const rows=JSON.parse(input).rows||[];if(rows.some(row=>"password" in row||"sessionVersion" in row))process.exit(2);});' >/dev/null; then
  echo "admin-users leaked a sensitive DTO field" >&2
  exit 1
fi

credential_path="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const row=(JSON.parse(input).rows||[]).find(item=>(item.documents||[]).some(document=>document.isCurrent));const doc=row&&(row.documents||[]).find(document=>document.isCurrent);if(row&&doc)process.stdout.write("/api/organizations/"+encodeURIComponent(row.id)+"/credential/"+encodeURIComponent(doc.id));});')"
if test -n "$credential_path"; then
  assert_status "admin-organization-credential" 200 -b "$cookie_jar" "$base_url$credential_path"
else
  echo "admin-organization-credential-skipped=no-current-credential"
fi

if ! docker compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"' sh \
  "SELECT 1 FROM schema_migrations WHERE name = '012-membership-data-normalization.sql'" \
  | grep -qx 1; then
  echo "membership migration 012 is not recorded" >&2
  exit 1
fi
echo "membership-migration-012=applied"
if ! docker compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"' sh \
  "SELECT 1 FROM schema_migrations WHERE name = '013-organization-account-lifecycle.sql'" \
  | grep -qx 1; then
  echo "organization account lifecycle migration 013 is not recorded" >&2
  exit 1
fi
echo "organization-account-lifecycle-migration-013=applied"
if ! docker compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"' sh \
  "SELECT 1 FROM schema_migrations WHERE name = '014-organization-deletion-history.sql'" \
  | grep -qx 1; then
  echo "organization deletion history migration 014 is not recorded" >&2
  exit 1
fi
echo "organization-deletion-history-migration-014=applied"

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

if test "$remote_smoke_auth_only" = true; then
  echo "remote-smoke=PARTIAL-auth-only-test-contract" >&2
  exit 3
fi
if test "$sms_registration_enabled" = false; then
  echo "registration-dependent-smoke=skipped-feature-disabled"
  exit 0
fi

refresh_submission_cleanup_events() {
  cleanup_events_response="$work_dir/cleanup-events.json"
  curl -sS -f -o "$cleanup_events_response" -b "$cookie_jar" "$base_url/api/admin/events"
}

recover_submission_smoke_event_id() {
  test "$smoke_event_cleanup_pending" -eq 1 || return 0
  refresh_submission_cleanup_events || return 1
  recovered_event_id="$(EXPECTED_NAME="$smoke_event_name" EXPECTED_TOKEN="$submission_token" SOURCE_EVENT_ID="$smoke_source_event_id" docker compose exec -T -e EXPECTED_NAME -e EXPECTED_TOKEN -e SOURCE_EVENT_ID api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const rows=JSON.parse(input).rows||[];const expectedName=process.env.EXPECTED_NAME;const expectedToken=process.env.EXPECTED_TOKEN;const sourceEventId=process.env.SOURCE_EVENT_ID;const matches=rows.filter(event=>event.name === expectedName&&event.name.includes(expectedToken)&&event.id !== sourceEventId);if(matches.length>1)process.exit(2);if(matches[0])process.stdout.write(encodeURIComponent(matches[0].id));});' < "$cleanup_events_response")" || return 1
  if test -z "$recovered_event_id"; then
    smoke_event_cleanup_pending=0
    return 0
  fi
  if test -n "$smoke_event_id" && test "$smoke_event_id" != "$recovered_event_id"; then
    return 1
  fi
  smoke_event_id="$recovered_event_id"
}

verify_submission_smoke_event_target() {
  event_id="$1"
  require_archived="$2"
  require_project="$3"
  test -n "$event_id" && test -n "$smoke_event_name" && test -n "$submission_token" && test -n "$smoke_source_event_id" || return 1
  if test "$require_project" -eq 1; then test -n "$smoke_project_id" || return 1; fi
  EXPECTED_ID="$event_id" EXPECTED_PROJECT_ID="$smoke_project_id" EXPECTED_NAME="$smoke_event_name" EXPECTED_TOKEN="$submission_token" SOURCE_EVENT_ID="$smoke_source_event_id" REQUIRE_ARCHIVED="$require_archived" REQUIRE_PROJECT="$require_project" docker compose exec -T -e EXPECTED_ID -e EXPECTED_PROJECT_ID -e EXPECTED_NAME -e EXPECTED_TOKEN -e SOURCE_EVENT_ID -e REQUIRE_ARCHIVED -e REQUIRE_PROJECT api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);const rows=data.rows||[];const sourceEventId=process.env.SOURCE_EVENT_ID;const event=rows.find(row=>row.id===process.env.EXPECTED_ID);const project=(data.projects||[]).find(row=>row.id===process.env.EXPECTED_PROJECT_ID);if(!event||event.name !== process.env.EXPECTED_NAME||!event.name.includes(process.env.EXPECTED_TOKEN)||event.id === sourceEventId||(process.env.REQUIRE_PROJECT === "1"&&(!project||project.eventId !== event.id)))process.exit(2);if(process.env.REQUIRE_ARCHIVED === "1"&&(!event.archivedAt||event.isCurrent))process.exit(2);});' < "$cleanup_events_response" >/dev/null
}

verify_submission_smoke_event_absent() {
  deleted_event_id="$1"
  test -n "$deleted_event_id" || return 1
  refresh_submission_cleanup_events || return 1
  EXPECTED_ID="$deleted_event_id" docker compose exec -T -e EXPECTED_ID api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const rows=JSON.parse(input).rows||[];if(rows.some(row=>row.id===process.env.EXPECTED_ID))process.exit(2);});' < "$cleanup_events_response" >/dev/null
}

refresh_submission_cleanup_users() {
  cleanup_submission_users_response="$work_dir/cleanup-submission-users.json"
  curl -sS -f -o "$cleanup_submission_users_response" -b "$cookie_jar" "$base_url/api/users"
}

recover_submission_smoke_user_id() {
  test "$smoke_user_cleanup_pending" -eq 1 || return 0
  refresh_submission_cleanup_users || return 1
  recovered_user_id="$(EXPECTED_NAME="$smoke_user_name" EXPECTED_PHONE="$smoke_user_phone" EXPECTED_TOKEN="$submission_token" docker compose exec -T -e EXPECTED_NAME -e EXPECTED_PHONE -e EXPECTED_TOKEN api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const rows=JSON.parse(input).rows||[];const matches=rows.filter(user=>user.type==="ordinary"&&user.name===process.env.EXPECTED_NAME&&user.name.includes(process.env.EXPECTED_TOKEN)&&user.phone===process.env.EXPECTED_PHONE);if(matches.length>1)process.exit(2);if(matches[0])process.stdout.write(encodeURIComponent(matches[0].id));});' < "$cleanup_submission_users_response")" || return 1
  if test -z "$recovered_user_id"; then
    smoke_user_cleanup_pending=0
    smoke_user_id=
    return 0
  fi
  if test -n "$smoke_user_id" && test "$smoke_user_id" != "$recovered_user_id"; then
    return 1
  fi
  smoke_user_id="$recovered_user_id"
}

verify_submission_smoke_user_target() {
  test -n "$smoke_user_id" && test -n "$smoke_user_name" && test -n "$smoke_user_phone" && test -n "$submission_token" || return 1
  EXPECTED_ID="$smoke_user_id" EXPECTED_NAME="$smoke_user_name" EXPECTED_PHONE="$smoke_user_phone" EXPECTED_TOKEN="$submission_token" docker compose exec -T -e EXPECTED_ID -e EXPECTED_NAME -e EXPECTED_PHONE -e EXPECTED_TOKEN api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const rows=JSON.parse(input).rows||[];const matches=rows.filter(user=>user.id===process.env.EXPECTED_ID&&user.type==="ordinary"&&user.name===process.env.EXPECTED_NAME&&user.name.includes(process.env.EXPECTED_TOKEN)&&user.phone===process.env.EXPECTED_PHONE);if(matches.length!==1)process.exit(2);});' < "$cleanup_submission_users_response" >/dev/null
}

cleanup_submission_event_smoke() {
  test "$smoke_event_cleanup_pending" -eq 1 || return 0
  recover_submission_smoke_event_id || {
    echo "submission-smoke-cleanup could not recover the exact temporary event" >&2
    return 1
  }
  test "$smoke_event_cleanup_pending" -eq 1 || return 0
  refresh_submission_cleanup_events || return 1
  verify_submission_smoke_event_target "$smoke_event_id" 0 0 || return 1
  refresh_submission_cleanup_events || return 1
  verify_submission_smoke_event_target "$smoke_event_id" 0 0 || return 1
  curl -sS -f -o /dev/null -b "$cookie_jar" -X POST \
    "$base_url/api/admin/events/$smoke_event_id/archive" || return 1
  refresh_submission_cleanup_events || return 1
  verify_submission_smoke_event_target "$smoke_event_id" 1 0 || return 1
  cleanup_payload="{\"confirmName\":\"$smoke_event_name\"}"
  printf '%s' "$cleanup_payload" | curl -sS -f -o /dev/null -b "$cookie_jar" \
    -H 'Content-Type: application/json' --data-binary @- \
    -X DELETE "$base_url/api/admin/events/$smoke_event_id" || return 1
  verify_submission_smoke_event_absent "$smoke_event_id" || return 1
  smoke_event_cleanup_pending=0
  smoke_event_id=
}

cleanup_submission_user_smoke() {
  test "$smoke_user_cleanup_pending" -eq 1 || return 0
  recover_submission_smoke_user_id || return 1
  test "$smoke_user_cleanup_pending" -eq 1 || return 0
  refresh_submission_cleanup_users || return 1
  verify_submission_smoke_user_target || return 1
  curl -sS -f -o /dev/null -b "$cookie_jar" -X DELETE \
    "$base_url/api/admin/users/$smoke_user_id" || return 1
  smoke_user_cleanup_pending=0
  smoke_user_id=
}

cleanup_submission_smoke() {
  cleanup_failed=0
  cleanup_submission_event_smoke || cleanup_failed=1
  cleanup_submission_user_smoke || cleanup_failed=1
  if test "$cleanup_failed" -ne 0; then
    echo "submission-smoke-cleanup=failed" >&2
    return 1
  fi
  echo "submission-smoke-cleanup=ok"
}

refresh_organization_cleanup_records() {
  cleanup_users_response="$work_dir/cleanup-users.json"
  cleanup_organizations_response="$work_dir/cleanup-organizations.json"
  curl -sS -f -o "$cleanup_users_response" -b "$cookie_jar" "$base_url/api/users" || return 1
  curl -sS -f -o "$cleanup_organizations_response" -b "$cookie_jar" "$base_url/api/admin/organizations"
}

recover_organization_fixture() {
  recovery_phone="$1"
  recovery_owner_name="$2"
  recovery_organization_name="$3"
  recovered_user_id="$(EXPECTED_PHONE="$recovery_phone" EXPECTED_NAME="$recovery_owner_name" docker compose exec -T -e EXPECTED_PHONE -e EXPECTED_NAME api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const rows=JSON.parse(input).rows||[];const matches=rows.filter(row=>row.type==="organization"&&row.phone===process.env.EXPECTED_PHONE&&row.name===process.env.EXPECTED_NAME);if(matches.length>1)process.exit(2);if(matches[0])process.stdout.write(encodeURIComponent(matches[0].id));});' < "$cleanup_users_response")" || return 1
  recovered_organization_id="$(EXPECTED_NAME="$recovery_organization_name" EXPECTED_TOKEN="$smoke_organization_token" docker compose exec -T -e EXPECTED_NAME -e EXPECTED_TOKEN api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const rows=JSON.parse(input).rows||[];const matches=rows.filter(organization=>organization.name === process.env.EXPECTED_NAME&&organization.name.includes(process.env.EXPECTED_TOKEN));if(matches.length>1)process.exit(2);if(matches[0])process.stdout.write(encodeURIComponent(matches[0].id));});' < "$cleanup_organizations_response")" || return 1
  if test -z "$recovered_user_id" && test -z "$recovered_organization_id"; then
    return 2
  fi
  test -n "$recovered_user_id" && test -n "$recovered_organization_id" || return 1
  EXPECTED_ID="$recovered_organization_id" EXPECTED_NAME="$recovery_organization_name" EXPECTED_TOKEN="$smoke_organization_token" EXPECTED_USER_ID="$recovered_user_id" docker compose exec -T -e EXPECTED_ID -e EXPECTED_NAME -e EXPECTED_TOKEN -e EXPECTED_USER_ID api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const rows=JSON.parse(input).rows||[];const matches=rows.filter(organization=>organization.id===process.env.EXPECTED_ID&&organization.name === process.env.EXPECTED_NAME&&organization.name.includes(process.env.EXPECTED_TOKEN)&&organization.ownerUserId===process.env.EXPECTED_USER_ID);if(matches.length!==1)process.exit(2);});' < "$cleanup_organizations_response" >/dev/null || return 1
  printf '%s\n%s\n' "$recovered_user_id" "$recovered_organization_id"
}

recover_organization_smoke_ids() {
  test -n "$smoke_organization_token" || return 0
  refresh_organization_cleanup_records || return 1
  if test "$smoke_organization_cleanup_pending" -eq 1; then
    recovered_ids="$(recover_organization_fixture "$smoke_organization_phone" "组织冒烟负责人" "$smoke_organization_name")" || recovered_status=$?
    case "${recovered_status:-0}" in
      0)
        recovered_user_id="$(printf '%s\n' "$recovered_ids" | sed -n '1p')"
        recovered_organization_id="$(printf '%s\n' "$recovered_ids" | sed -n '2p')"
        if test -n "$smoke_organization_user_id" && test "$smoke_organization_user_id" != "$recovered_user_id"; then return 1; fi
        if test -n "$smoke_organization_id" && test "$smoke_organization_id" != "$recovered_organization_id"; then return 1; fi
        smoke_organization_user_id="$recovered_user_id"
        smoke_organization_id="$recovered_organization_id"
        ;;
      2) smoke_organization_cleanup_pending=0 ;;
      *) return 1 ;;
    esac
    unset recovered_status
  fi
  if test "$smoke_foreign_organization_cleanup_pending" -eq 1; then
    recovered_ids="$(recover_organization_fixture "$smoke_foreign_organization_phone" "外部组织负责人" "$smoke_foreign_organization_name")" || recovered_status=$?
    case "${recovered_status:-0}" in
      0)
        recovered_user_id="$(printf '%s\n' "$recovered_ids" | sed -n '1p')"
        recovered_organization_id="$(printf '%s\n' "$recovered_ids" | sed -n '2p')"
        if test -n "$smoke_foreign_organization_user_id" && test "$smoke_foreign_organization_user_id" != "$recovered_user_id"; then return 1; fi
        if test -n "$smoke_foreign_organization_id" && test "$smoke_foreign_organization_id" != "$recovered_organization_id"; then return 1; fi
        smoke_foreign_organization_user_id="$recovered_user_id"
        smoke_foreign_organization_id="$recovered_organization_id"
        ;;
      2) smoke_foreign_organization_cleanup_pending=0 ;;
      *) return 1 ;;
    esac
    unset recovered_status
  fi
}

verify_organization_cleanup_target() {
  organization_id="$1"
  organization_name="$2"
  organization_user_id="$3"
  organization_phone="$4"
  organization_owner_name="$5"
  test -n "$organization_id" && test -n "$organization_user_id" && test -n "$smoke_organization_token" || return 1
  EXPECTED_ID="$organization_user_id" EXPECTED_PHONE="$organization_phone" EXPECTED_NAME="$organization_owner_name" docker compose exec -T -e EXPECTED_ID -e EXPECTED_PHONE -e EXPECTED_NAME api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const rows=JSON.parse(input).rows||[];const matches=rows.filter(row=>row.id===process.env.EXPECTED_ID&&row.type==="organization"&&row.phone===process.env.EXPECTED_PHONE&&row.name===process.env.EXPECTED_NAME);if(matches.length!==1)process.exit(2);});' < "$cleanup_users_response" >/dev/null || return 1
  EXPECTED_ID="$organization_id" EXPECTED_NAME="$organization_name" EXPECTED_TOKEN="$smoke_organization_token" EXPECTED_USER_ID="$organization_user_id" docker compose exec -T -e EXPECTED_ID -e EXPECTED_NAME -e EXPECTED_TOKEN -e EXPECTED_USER_ID api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const rows=JSON.parse(input).rows||[];const matches=rows.filter(row=>row.id===process.env.EXPECTED_ID&&row.name===process.env.EXPECTED_NAME&&row.name.includes(process.env.EXPECTED_TOKEN)&&row.ownerUserId===process.env.EXPECTED_USER_ID);if(matches.length!==1)process.exit(2);});' < "$cleanup_organizations_response" >/dev/null
}

cleanup_organization_target() {
  organization_id="$1"
  organization_name="$2"
  organization_user_id="$3"
  organization_phone="$4"
  organization_owner_name="$5"
  refresh_organization_cleanup_records || return 1
  verify_organization_cleanup_target "$organization_id" "$organization_name" "$organization_user_id" "$organization_phone" "$organization_owner_name" || return 1
  printf '%s' '{"status":"disabled"}' | curl -sS -f -o /dev/null -b "$cookie_jar" \
    -H 'Content-Type: application/json' --data-binary @- \
    -X PATCH "$base_url/api/admin/organizations/$organization_id/status" || return 1
  refresh_organization_cleanup_records || return 1
  verify_organization_cleanup_target "$organization_id" "$organization_name" "$organization_user_id" "$organization_phone" "$organization_owner_name" || return 1
  cleanup_payload="{\"confirmName\":\"$organization_name\"}"
  printf '%s' "$cleanup_payload" | curl -sS -f -o /dev/null -b "$cookie_jar" \
    -H 'Content-Type: application/json' --data-binary @- \
    -X POST "$base_url/api/admin/organizations/$organization_id/credential-cleanup" || return 1
  refresh_organization_cleanup_records || return 1
  verify_organization_cleanup_target "$organization_id" "$organization_name" "$organization_user_id" "$organization_phone" "$organization_owner_name" || return 1
  curl -sS -f -o /dev/null -b "$cookie_jar" -X DELETE "$base_url/api/admin/users/$organization_user_id"
}

cleanup_organization_smoke() {
  test -n "$smoke_organization_token" || return 0
  if test "$smoke_organization_cleanup_pending" -ne 1 && test "$smoke_foreign_organization_cleanup_pending" -ne 1; then
    return 0
  fi
  recover_organization_smoke_ids || {
    echo "organization-smoke-cleanup could not recover exact temporary identities" >&2
    return 1
  }
  if test "$smoke_organization_cleanup_pending" -eq 1 && test "$smoke_organization_cleaned" -ne 1; then
    cleanup_organization_target "$smoke_organization_id" "$smoke_organization_name" "$smoke_organization_user_id" "$smoke_organization_phone" "组织冒烟负责人" || return 1
    smoke_organization_cleaned=1
    smoke_organization_cleanup_pending=0
  fi
  if test "$smoke_foreign_organization_cleanup_pending" -eq 1 && test "$smoke_foreign_organization_cleaned" -ne 1; then
    cleanup_organization_target "$smoke_foreign_organization_id" "$smoke_foreign_organization_name" "$smoke_foreign_organization_user_id" "$smoke_foreign_organization_phone" "外部组织负责人" || return 1
    smoke_foreign_organization_cleaned=1
    smoke_foreign_organization_cleanup_pending=0
  fi
  echo "organization-smoke-cleanup=ok"
}

submission_token="$(date +%s)-$$"
smoke_event_name="上传冒烟-$submission_token"
smoke_event_cleanup_pending=1
printf '{"name":"%s"}' "$smoke_event_name" | \
assert_status "submission-event-copy" 201 \
  -b "$cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/admin/events/$smoke_source_event_id/copy"
assert_json_response "submission-event-copy"
smoke_event_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.event&&data.event.id)process.stdout.write(encodeURIComponent(data.event.id));});')"
smoke_project_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);const project=(data.projects||[])[0];if(project&&project.id)process.stdout.write(encodeURIComponent(project.id));});')"
if test -z "$smoke_event_id" || test -z "$smoke_project_id"; then
  echo "Submission smoke fixture creation returned no event or project" >&2
  exit 1
fi
refresh_submission_cleanup_events
if ! verify_submission_smoke_event_target "$smoke_event_id" 0 1; then
  echo "Submission smoke fixture did not match the copied event and project" >&2
  exit 1
fi
printf '%s' '{"registrationMode":"force_open"}' | \
assert_status "submission-event-registration-open" 200 \
  -b "$cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  -X PATCH "$base_url/api/admin/events/$smoke_event_id"

smoke_organization_token="$(date +%s)-$$"
smoke_organization_name="组织冒烟-$smoke_organization_token"
smoke_foreign_organization_name="外部组织冒烟-$smoke_organization_token"
smoke_organization_phone="138$(printf '%s' "owner-$smoke_organization_token" | cksum | awk '{printf "%08d", $1 % 100000000}')"
smoke_foreign_organization_phone="139$(printf '%s' "foreign-$smoke_organization_token" | cksum | awk '{printf "%08d", $1 % 100000000}')"
smoke_organization_credit_code="91330300$(printf '%s' "owner-$smoke_organization_token" | cksum | awk '{printf "%010d", $1}')"
smoke_foreign_organization_credit_code="91330300$(printf '%s' "foreign-$smoke_organization_token" | cksum | awk '{printf "%010d", $1}')"
smoke_organization_password="Smoke-${smoke_organization_token}!o"
smoke_foreign_organization_password="Smoke-${smoke_organization_token}!f"
smoke_organization_password_file="$work_dir/organization-owner.password"
smoke_foreign_organization_password_file="$work_dir/organization-foreign.password"
smoke_organization_token_file="$work_dir/organization-owner.registration-token"
smoke_foreign_organization_token_file="$work_dir/organization-foreign.registration-token"
printf '%s' "$smoke_organization_password" > "$smoke_organization_password_file"
printf '%s' "$smoke_foreign_organization_password" > "$smoke_foreign_organization_password_file"
unset smoke_organization_password smoke_foreign_organization_password
smoke_issue_phone_registration_token "$smoke_organization_phone" "$smoke_organization_token_file"
smoke_issue_phone_registration_token "$smoke_foreign_organization_phone" "$smoke_foreign_organization_token_file"
organization_expected_grades='["一年级","二年级","三年级","四年级","五年级","六年级","初一","初二","初三","高一","高二","高三","职高一年级","职高二年级","职高三年级"]'
organization_credential_file="$work_dir/organization-credential.pdf"
printf '%s' '%PDF-1.7
1 0 obj
<<>>
endobj
%%EOF
' > "$organization_credential_file"

smoke_organization_cleanup_pending=1
assert_status "organization-owner-register" 201 \
  -F "name=组织冒烟负责人" \
  -F "phone=$smoke_organization_phone" \
  -F "password=<$smoke_organization_password_file" \
  -F "phoneVerificationToken=<$smoke_organization_token_file" \
  -F "organizationName=$smoke_organization_name" \
  -F "creditCode=$smoke_organization_credit_code" \
  -F 'documentType=business_license' \
  -F "credential=@$organization_credential_file;type=application/pdf" \
  "$base_url/api/auth/register/organization"
assert_json_response "organization-owner-register"
smoke_organization_user_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.user&&data.user.id)process.stdout.write(encodeURIComponent(data.user.id));});')"
registered_organization_phone="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.user&&data.user.phone)process.stdout.write(data.user.phone);});')"
smoke_organization_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.organization&&data.organization.id)process.stdout.write(encodeURIComponent(data.organization.id));});')"
registered_organization_name="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.organization&&data.organization.name)process.stdout.write(data.organization.name);});')"
if test -z "$smoke_organization_user_id" || test -z "$smoke_organization_id" || test "$registered_organization_phone" != "$smoke_organization_phone" || test "$registered_organization_name" != "$smoke_organization_name"; then
  echo "Organization smoke registration did not return the exact owner and organization fixture" >&2
  exit 1
fi
smoke_organization_cookie_jar="$work_dir/organization-owner.cookies"
{ printf '{"phone":"%s","password":"' "$smoke_organization_phone"; cat "$smoke_organization_password_file"; printf '"}'; } | \
assert_status "organization-owner-login" 200 \
  -c "$smoke_organization_cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/auth/login"
assert_status "organization-pending-workspace" 403 \
  -b "$smoke_organization_cookie_jar" \
  "$base_url/api/organization/events/$smoke_event_id/workspace"
assert_json_error_code "organization-pending-workspace" "ORGANIZATION_REVIEW_PENDING"
printf '%s' '{"status":"approved","reason":""}' | \
assert_status "organization-owner-review" 200 \
  -b "$cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  -X PATCH "$base_url/api/admin/organizations/$smoke_organization_id/review"
assert_status "organization-leader-create" 201 \
  -b "$smoke_organization_cookie_jar" \
  -F 'name=Smoke Leader' \
  -F "phone=$smoke_organization_phone" \
  -F 'email=smoke-leader@example.com' \
  -F 'notes=release smoke leader' \
  -F "authorization=@$organization_credential_file;type=application/pdf" \
  "$base_url/api/organization/leaders"
assert_json_response "organization-leader-create"
smoke_organization_leader_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.row&&data.row.id)process.stdout.write(encodeURIComponent(data.row.id));});')"
if test -z "$smoke_organization_leader_id"; then
  echo "Organization leader smoke creation returned no leader id" >&2
  exit 1
fi
printf '%s' '{"decision":"approved"}' | \
assert_status "organization-leader-approve" 200 \
  -b "$cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  -X PATCH "$base_url/api/admin/organization-leaders/$smoke_organization_leader_id/review"
assert_status "organization-event-join" 201 \
  -b "$smoke_organization_cookie_jar" -X POST \
  "$base_url/api/organization/events/$smoke_event_id/join"
assert_status "organization-workspace" 200 \
  -b "$smoke_organization_cookie_jar" \
  "$base_url/api/organization/events/$smoke_event_id/workspace"
assert_json_response "organization-workspace"
if ! EXPECTED_ORGANIZATION_ID="$smoke_organization_id" EXPECTED_ORGANIZATION_NAME="$smoke_organization_name" EXPECTED_GRADES="$organization_expected_grades" docker compose exec -T -e EXPECTED_ORGANIZATION_ID -e EXPECTED_ORGANIZATION_NAME -e EXPECTED_GRADES api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);const grades=(data.grades||[]).flatMap(group=>group.grades||[]);const expected=JSON.parse(process.env.EXPECTED_GRADES);if(!data.organization||data.organization.id!==process.env.EXPECTED_ORGANIZATION_ID||data.organization.name!==process.env.EXPECTED_ORGANIZATION_NAME||JSON.stringify(grades)!==JSON.stringify(expected))process.exit(2);});' < "$response_file" >/dev/null; then
  echo "organization-workspace did not return the exact organization identity and grades" >&2
  exit 1
fi
printf '{"registrationSource":"organization_proxy","projectId":"%s","athlete":{"name":"组织冒烟选手","school":"%s","grade":"三年级","phone":"%s"}}' \
  "$smoke_project_id" "$smoke_organization_name" "$smoke_organization_phone" | add_student_id "11010519491231002X" | \
assert_status "organization-registration-create" 201 \
  -b "$smoke_organization_cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/organization/events/$smoke_event_id/registrations"
assert_json_response "organization-registration-create"
organization_registration_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.row&&data.row.id)process.stdout.write(encodeURIComponent(data.row.id));});')"
if test -z "$organization_registration_id"; then
  echo "Organization smoke registration returned no registration id" >&2
  exit 1
fi

smoke_foreign_organization_cleanup_pending=1
assert_status "organization-foreign-register" 201 \
  -F "name=外部组织负责人" \
  -F "phone=$smoke_foreign_organization_phone" \
  -F "password=<$smoke_foreign_organization_password_file" \
  -F "phoneVerificationToken=<$smoke_foreign_organization_token_file" \
  -F "organizationName=$smoke_foreign_organization_name" \
  -F "creditCode=$smoke_foreign_organization_credit_code" \
  -F 'documentType=business_license' \
  -F "credential=@$organization_credential_file;type=application/pdf" \
  "$base_url/api/auth/register/organization"
assert_json_response "organization-foreign-register"
smoke_foreign_organization_user_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.user&&data.user.id)process.stdout.write(encodeURIComponent(data.user.id));});')"
registered_foreign_organization_phone="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.user&&data.user.phone)process.stdout.write(data.user.phone);});')"
smoke_foreign_organization_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.organization&&data.organization.id)process.stdout.write(encodeURIComponent(data.organization.id));});')"
registered_foreign_organization_name="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.organization&&data.organization.name)process.stdout.write(data.organization.name);});')"
if test -z "$smoke_foreign_organization_user_id" || test -z "$smoke_foreign_organization_id" || test "$registered_foreign_organization_phone" != "$smoke_foreign_organization_phone" || test "$registered_foreign_organization_name" != "$smoke_foreign_organization_name"; then
  echo "Foreign organization smoke registration did not return the exact owner and organization fixture" >&2
  exit 1
fi
printf '%s' '{"status":"approved","reason":""}' | \
assert_status "organization-foreign-review" 200 \
  -b "$cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  -X PATCH "$base_url/api/admin/organizations/$smoke_foreign_organization_id/review"
smoke_foreign_organization_cookie_jar="$work_dir/organization-foreign.cookies"
{ printf '{"phone":"%s","password":"' "$smoke_foreign_organization_phone"; cat "$smoke_foreign_organization_password_file"; printf '"}'; } | \
assert_status "organization-foreign-login" 200 \
  -c "$smoke_foreign_organization_cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/auth/login"
assert_status "organization-foreign-leader-create" 201 \
  -b "$smoke_foreign_organization_cookie_jar" \
  -F 'name=Foreign Smoke Leader' \
  -F "phone=$smoke_foreign_organization_phone" \
  -F 'email=foreign-smoke-leader@example.com' \
  -F 'notes=foreign release smoke leader' \
  -F "authorization=@$organization_credential_file;type=application/pdf" \
  "$base_url/api/organization/leaders"
assert_json_response "organization-foreign-leader-create"
smoke_foreign_organization_leader_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.row&&data.row.id)process.stdout.write(encodeURIComponent(data.row.id));});')"
if test -z "$smoke_foreign_organization_leader_id"; then
  echo "Foreign organization leader smoke creation returned no leader id" >&2
  exit 1
fi
printf '%s' '{"decision":"approved"}' | \
assert_status "organization-foreign-leader-approve" 200 \
  -b "$cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  -X PATCH "$base_url/api/admin/organization-leaders/$smoke_foreign_organization_leader_id/review"
assert_status "organization-foreign-event-join" 201 \
  -b "$smoke_foreign_organization_cookie_jar" -X POST \
  "$base_url/api/organization/events/$smoke_event_id/join"
printf '{"registrationSource":"organization_proxy","projectId":"%s","athlete":{"name":"外部组织选手","school":"%s","grade":"三年级","phone":"%s"}}' \
  "$smoke_project_id" "$smoke_foreign_organization_name" "$smoke_foreign_organization_phone" | add_student_id "110105194912310038" | \
assert_status "organization-foreign-registration-create" 201 \
  -b "$smoke_foreign_organization_cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/organization/events/$smoke_event_id/registrations"
assert_json_response "organization-foreign-registration-create"
foreign_registration_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.row&&data.row.id)process.stdout.write(encodeURIComponent(data.row.id));});')"
if test -z "$foreign_registration_id"; then
  echo "Foreign organization smoke registration returned no registration id" >&2
  exit 1
fi
assert_status "organization-records" 200 \
  -b "$smoke_organization_cookie_jar" \
  "$base_url/api/organization/registrations"
assert_json_response "organization-records"
if ! EXPECTED_ID="$organization_registration_id" docker compose exec -T -e EXPECTED_ID api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const rows=JSON.parse(input).rows||[];if(!rows.some(row=>row.id===process.env.EXPECTED_ID))process.exit(2);});' < "$response_file" >/dev/null; then
  echo "organization-records did not include the owner fixture" >&2
  exit 1
fi
assert_status "organization-records-foreign-isolated" 200 \
  -b "$smoke_organization_cookie_jar" \
  "$base_url/api/organization/registrations"
if ! EXPECTED_ID="$foreign_registration_id" docker compose exec -T -e EXPECTED_ID api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const rows=JSON.parse(input).rows||[];if(rows.some(row=>row.id===process.env.EXPECTED_ID))process.exit(2);});' < "$response_file" >/dev/null; then
  echo "organization-records exposed the foreign fixture" >&2
  exit 1
fi

printf '%s' '{"submissionMode":"image_video"}' | \
assert_status "submission-project-mode" 200 \
  -b "$cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  -X PATCH "$base_url/api/admin/projects/$smoke_project_id"

smoke_user_phone="1$(printf '%s' "user-$submission_token" | cksum | awk '{printf "%010d", $1}')"
smoke_phone="$smoke_user_phone"
smoke_user_name="上传冒烟用户-$submission_token"
smoke_user_password_file="$work_dir/submission-user-password"
printf 'Smoke-%s!a' "$submission_token" > "$smoke_user_password_file"
chmod 600 "$smoke_user_password_file"
smoke_user_cleanup_pending=1
SMOKE_USER_NAME="$smoke_user_name" SMOKE_PHONE="$smoke_user_phone" docker compose exec -T -e SMOKE_USER_NAME -e SMOKE_PHONE api node -e 'process.stdout.write(JSON.stringify({name:process.env.SMOKE_USER_NAME,phone:process.env.SMOKE_PHONE,type:"ordinary"}));' | \
assert_status "submission-user-create" 201 \
  -b "$cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/admin/users"
assert_json_response "submission-user-create"
smoke_user_temporary_password_file="$work_dir/submission-user-temporary-password"
if ! smoke_extract_temporary_password "$response_file" "$smoke_user_temporary_password_file"; then
  echo "Submission smoke user creation did not return valid generated credentials" >&2
  exit 1
fi
smoke_user_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.row&&data.row.id)process.stdout.write(encodeURIComponent(data.row.id));});')"
if ! recover_submission_smoke_user_id || test "$smoke_user_cleanup_pending" -ne 1; then
  echo "Submission smoke user did not match the exact temporary identity" >&2
  exit 1
fi
smoke_cookie_jar="$work_dir/submission-user.cookies"
SMOKE_PHONE="$smoke_user_phone" docker compose exec -T -e SMOKE_PHONE api node -e 'let password="";process.stdin.on("data",chunk=>password+=chunk).on("end",()=>process.stdout.write(JSON.stringify({phone:process.env.SMOKE_PHONE,password})));' < "$smoke_user_temporary_password_file" | \
assert_status "submission-user-login" 200 \
  -c "$smoke_cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/auth/login"
assert_json_response "submission-user-login"
if ! json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(!data.user||data.user.mustChangePassword!==true)process.exit(2);});' >/dev/null; then
  echo "Submission smoke user login did not require a credential change" >&2
  exit 1
fi
{ cat "$smoke_user_temporary_password_file"; printf '\n'; cat "$smoke_user_password_file"; } | \
docker compose exec -T api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const separator=input.indexOf("\n");if(separator<1)process.exit(2);process.stdout.write(JSON.stringify({currentPassword:input.slice(0,separator),newPassword:input.slice(separator+1)}));});' | \
assert_status "submission-user-force-password-change" 200 \
  -b "$smoke_cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/auth/change-password"
assert_json_response "submission-user-force-password-change"

printf '{"projectId":"%s","athlete":{"name":"未入组织冒烟选手","school":"未入组织冒烟学校","grade":"五年级","phone":"%s"}}' \
  "$smoke_project_id" "$smoke_user_phone" | add_student_id "110105201401011231" | \
assert_status "submission-registration-unaffiliated" 403 \
  -b "$smoke_cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/me/events/$smoke_event_id/registrations"
assert_json_error_code "submission-registration-unaffiliated" "ACTIVE_ORGANIZATION_REQUIRED"

printf '{"phone":"%s"}' "$smoke_user_phone" | \
assert_status "submission-user-invitation" 201 \
  -b "$smoke_organization_cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/organization/invitations"
assert_json_response "submission-user-invitation"
submission_membership_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const row=JSON.parse(input).row;if(row&&row.id)process.stdout.write(encodeURIComponent(row.id));});')"
if test -z "$submission_membership_id"; then
  echo "Submission smoke invitation returned no membership id" >&2
  exit 1
fi
printf '%s' '{"action":"accept"}' | \
assert_status "submission-user-invitation-accept" 200 \
  -b "$smoke_cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  -X PATCH "$base_url/api/me/organization-relations/$submission_membership_id"

png_file="$work_dir/submission-work.png"
video_file="$work_dir/submission-work.mp4"
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR42mNgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==' | base64 -d > "$png_file"
docker compose exec -T api ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=16x16:r=1 \
  -t 1 -c:v libx264 -movflags frag_keyframe+empty_moov -f mp4 pipe:1 > "$video_file"
test -s "$png_file" && test -s "$video_file"

assert_status "submission-session-create" 201 \
  -b "$smoke_cookie_jar" -X POST \
  "$base_url/api/me/events/$smoke_event_id/projects/$smoke_project_id/upload-sessions"
assert_json_response "submission-session-create"
submission_session_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.row&&data.row.id)process.stdout.write(encodeURIComponent(data.row.id));});')"
if test -z "$submission_session_id"; then
  echo "Submission smoke session creation returned no session" >&2
  exit 1
fi
assert_status "submission-image-upload" 201 \
  -b "$smoke_cookie_jar" -X PUT -F "file=@$png_file;type=image/png" \
  "$base_url/api/upload-sessions/$submission_session_id/artwork-image"
assert_json_response "submission-image-upload"
json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const row=JSON.parse(input).row||{};if(Object.hasOwn(row,"filePath")||Object.hasOwn(row,"storedName"))process.exit(2);});' >/dev/null
assert_status "submission-video-upload" 201 \
  -b "$smoke_cookie_jar" -X PUT -F "file=@$video_file;type=video/mp4" \
  "$base_url/api/upload-sessions/$submission_session_id/creation-video"
assert_json_response "submission-video-upload"

printf '{"projectId":"%s","athlete":{"name":"上传冒烟选手","school":"上传冒烟学校","grade":"五年级","phone":"%s"},"uploadSessionId":"%s"}' \
  "$smoke_project_id" "$smoke_phone" "$submission_session_id" | add_student_id "110105201401011231" | \
assert_status "submission-registration-bind" 201 \
  -b "$smoke_cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/me/events/$smoke_event_id/registrations"
assert_json_response "submission-registration-bind"
submission_registration_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.row&&data.row.id)process.stdout.write(encodeURIComponent(data.row.id));});')"
if test -z "$submission_registration_id"; then
  echo "Submission smoke registration binding returned no registration" >&2
  exit 1
fi
assert_status "submission-account-registration-history" 200 \
  -b "$smoke_cookie_jar" "$base_url/api/me/registrations"
assert_json_response "submission-account-registration-history"
json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const rows=JSON.parse(input).rows||[];if(!rows.some(row=>row.id&&row.eventId))process.exit(2);});' >/dev/null
assert_status "submission-account-certificate-history" 200 \
  -b "$smoke_cookie_jar" "$base_url/api/me/certificates"
assert_json_response "submission-account-certificate-history"
assert_status "submission-admin-summary" 200 \
  -b "$cookie_jar" "$base_url/api/admin/events/$smoke_event_id/registrations"
assert_json_response "submission-admin-summary"
json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const row=(JSON.parse(input).rows||[]).find(item=>item.submission&&item.submission.complete);if(!row)process.exit(2);});' >/dev/null
assert_status "submission-private-unauthorized" 401 \
  "$base_url/api/me/events/$smoke_event_id/registrations/$submission_registration_id/assets/artwork_image"

assert_status "submission-user-password-reset" 200 \
  -b "$cookie_jar" -H 'Content-Type: application/json' --data-binary '{}' \
  -X POST "$base_url/api/admin/users/$smoke_user_id/reset-password"
assert_json_response "submission-user-password-reset"
if ! json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(!data.user||data.user.mustChangePassword !== true||typeof data.temporaryPassword!=="string"||!data.temporaryPassword)process.exit(2);process.stdout.write(data.temporaryPassword);});' > "$work_dir/reset-temporary-password"; then
  echo "Submission smoke reset did not enforce the required account state" >&2
  exit 1
fi
smoke_reset_password_file="$work_dir/reset-temporary-password"
assert_status "submission-user-password-repeat-view" 200 \
  -b "$cookie_jar" \
  "$base_url/api/admin/users/$smoke_user_id/temporary-password"
assert_json_response "submission-user-password-repeat-view"
smoke_repeat_password_file="$work_dir/repeated-temporary-password"
json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const value=JSON.parse(input).temporaryPassword;if(typeof value!=="string"||!value)process.exit(2);process.stdout.write(value);});' > "$smoke_repeat_password_file"
if ! cmp "$smoke_reset_password_file" "$smoke_repeat_password_file" >/dev/null; then
  echo "Repeated credential view did not return the current value" >&2
  exit 1
fi

cleanup_submission_smoke
