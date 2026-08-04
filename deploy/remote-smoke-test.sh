#!/bin/sh
set -eu

base_url="${BASE_URL:-http://127.0.0.1}"
admin_phone="${ADMIN_TEST_PHONE:-13900000000}"
umask 077
work_dir=

cleanup() {
  if command -v cleanup_submission_smoke >/dev/null 2>&1; then
    cleanup_submission_smoke || true
  fi
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
smoke_event_id=
smoke_event_name=
smoke_source_event_id=
original_current_event_id=
smoke_user_id=

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
smoke_source_event_id="$event_id"
original_current_event_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);const event=(data.rows||[]).find(item=>item.status === "published" && item.isCurrent && !item.archivedAt);if(event&&event.id)process.stdout.write(encodeURIComponent(event.id));});')"

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

cleanup_submission_smoke() {
  test -n "$smoke_event_id" || return 0
  cleanup_failed=0
  if test -n "$original_current_event_id"; then
    curl -sS -f -o /dev/null -b "$cookie_jar" -X POST \
      "$base_url/api/admin/events/$original_current_event_id/current" || cleanup_failed=1
  fi
  curl -sS -f -o /dev/null -b "$cookie_jar" -X POST \
    "$base_url/api/admin/events/$smoke_event_id/archive" || cleanup_failed=1
  cleanup_payload="{\"confirmName\":\"$smoke_event_name\"}"
  printf '%s' "$cleanup_payload" | curl -sS -f -o /dev/null -b "$cookie_jar" \
    -H 'Content-Type: application/json' --data-binary @- \
    -X DELETE "$base_url/api/admin/events/$smoke_event_id" || cleanup_failed=1
  if test -n "$smoke_user_id"; then
    curl -sS -f -o /dev/null -b "$cookie_jar" -X DELETE \
      "$base_url/api/admin/users/$smoke_user_id" || cleanup_failed=1
  fi
  if test "$cleanup_failed" -ne 0; then
    echo "submission-smoke-cleanup=failed" >&2
    return 1
  fi
  smoke_event_id=
  smoke_user_id=
  echo "submission-smoke-cleanup=ok"
}

submission_token="$(date +%s)-$$"
smoke_event_name="上传冒烟-$submission_token"
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
assert_status "submission-event-current" 200 -b "$cookie_jar" -X POST \
  "$base_url/api/admin/events/$smoke_event_id/current"
printf '%s' '{"registrationMode":"force_open"}' | \
assert_status "submission-event-registration-open" 200 \
  -b "$cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  -X PATCH "$base_url/api/admin/events/$smoke_event_id"
printf '%s' '{"submissionMode":"image_video"}' | \
assert_status "submission-project-mode" 200 \
  -b "$cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  -X PATCH "$base_url/api/admin/projects/$smoke_project_id"

smoke_phone="1$(date +%s)"
smoke_password="Smoke-${submission_token}!a"
printf '{"name":"上传冒烟用户","phone":"%s","password":"%s","type":"ordinary"}' "$smoke_phone" "$smoke_password" | \
assert_status "submission-user-create" 201 \
  -b "$cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/admin/users"
assert_json_response "submission-user-create"
smoke_user_id="$(json_path 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(data.row&&data.row.id)process.stdout.write(encodeURIComponent(data.row.id));});')"
smoke_cookie_jar="$work_dir/submission-user.cookies"
printf '{"phone":"%s","password":"%s"}' "$smoke_phone" "$smoke_password" | \
assert_status "submission-user-login" 200 \
  -c "$smoke_cookie_jar" -H 'Content-Type: application/json' --data-binary @- \
  "$base_url/api/auth/login"
unset smoke_password

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
  "$smoke_project_id" "$smoke_phone" "$submission_session_id" | \
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

cleanup_submission_smoke
