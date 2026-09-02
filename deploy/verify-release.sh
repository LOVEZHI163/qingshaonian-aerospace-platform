#!/bin/sh
set -eu

base_url="${BASE_URL:-http://127.0.0.1}"
expected_release="${EXPECTED_RELEASE:?EXPECTED_RELEASE is required}"
expected_sms_registration_enabled="${EXPECTED_SMS_REGISTRATION_ENABLED:?EXPECTED_SMS_REGISTRATION_ENABLED is required}"
expected_sms_login_enabled="${EXPECTED_SMS_LOGIN_ENABLED:?EXPECTED_SMS_LOGIN_ENABLED is required}"
expected_sms_password_reset_enabled="${EXPECTED_SMS_PASSWORD_RESET_ENABLED:?EXPECTED_SMS_PASSWORD_RESET_ENABLED is required}"

validate_boolean_expectation() {
  expectation_name="$1"
  expectation_value="$2"
  case "$expectation_value" in
    true|false) ;;
    *)
      echo "$expectation_name must be true or false" >&2
      exit 1
      ;;
  esac
}

validate_boolean_expectation EXPECTED_SMS_REGISTRATION_ENABLED "$expected_sms_registration_enabled"
validate_boolean_expectation EXPECTED_SMS_LOGIN_ENABLED "$expected_sms_login_enabled"
validate_boolean_expectation EXPECTED_SMS_PASSWORD_RESET_ENABLED "$expected_sms_password_reset_enabled"
if ! command -v node >/dev/null 2>&1; then
  echo "node is required to verify public feature JSON" >&2
  exit 1
fi
case "$expected_release" in
  (*[!0-9a-fA-F]*|'')
    echo "EXPECTED_RELEASE must be exactly 40 hexadecimal characters" >&2
    exit 1
    ;;
esac
if [ "${#expected_release}" -ne 40 ]; then
  echo "EXPECTED_RELEASE must be exactly 40 hexadecimal characters" >&2
  exit 1
fi
curl_connect_timeout=5
curl_max_time=15
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

fetch() {
  label="$1"
  output="$2"
  shift 2
  if http_status="$(curl -sS \
    --connect-timeout "$curl_connect_timeout" \
    --max-time "$curl_max_time" \
    -o "$output" -w '%{http_code}' "$@")"; then
    :
  else
    curl_exit=$?
    echo "$label request failed (curl exit $curl_exit)" >&2
    exit 1
  fi
  if [ "$http_status" != 200 ]; then
    echo "$label expected 200 but received $http_status" >&2
    exit 1
  fi
}

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/aerogp-release.XXXXXX")"
version_json="$work_dir/version.json"
features_json="$work_dir/features.json"
admin_html="$work_dir/admin.html"
admin_asset="$work_dir/admin.js"

fetch "system-version" "$version_json" \
  -H 'Cache-Control: no-cache' \
  "$base_url/api/system/version"

actual_release="$(LC_ALL=C sed -n \
  's/^[[:space:]]*{"releaseSha":"\([0-9A-Fa-f]*\)","apiVersion":1}[[:space:]]*$/\1/p' \
  "$version_json")"
case "$actual_release" in
  (*[!0-9a-fA-F]*|'')
    echo "system-version response was not the expected JSON" >&2
    exit 1
    ;;
esac
if [ "${#actual_release}" -ne 40 ]; then
  echo "system-version response was not the expected JSON" >&2
  exit 1
fi
if [ "$actual_release" != "$expected_release" ]; then
  echo "API release does not match EXPECTED_RELEASE" >&2
  exit 1
fi

fetch "public features" "$features_json" "$base_url/api/public/features"
if actual_sms_features="$(node - "$features_json" <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2], "utf8");
let data;
try {
  data = JSON.parse(source);
} catch {
  process.exit(2);
}
if (data === null || typeof data !== "object" || Array.isArray(data)) process.exit(2);

const topLevelKeys = [];
let depth = 0;
let expectingKey = false;
for (let index = 0; index < source.length; index += 1) {
  const character = source[index];
  if (character === '"') {
    let end = index + 1;
    let escaped = false;
    for (; end < source.length; end += 1) {
      const stringCharacter = source[end];
      if (escaped) {
        escaped = false;
      } else if (stringCharacter === "\\") {
        escaped = true;
      } else if (stringCharacter === '"') {
        break;
      }
    }
    if (depth === 1 && expectingKey) {
      topLevelKeys.push(JSON.parse(source.slice(index, end + 1)));
      expectingKey = false;
    }
    index = end;
  } else if (character === "{" || character === "[") {
    depth += 1;
    if (depth === 1) expectingKey = character === "{";
  } else if (character === "}" || character === "]") {
    depth -= 1;
  } else if (character === "," && depth === 1) {
    expectingKey = true;
  }
}

const seenKeys = new Set();
for (const key of topLevelKeys) {
  if (seenKeys.has(key)) process.exit(2);
  seenKeys.add(key);
}

const names = [
  "smsRegistrationEnabled",
  "smsLoginEnabled",
  "smsPasswordResetEnabled"
];
for (const name of names) {
  if (!Object.prototype.hasOwnProperty.call(data, name) || typeof data[name] !== "boolean") {
    process.exit(2);
  }
}
process.stdout.write(names.map((name) => String(data[name])).join("\n"));
NODE
)"; then
  :
else
  echo "public features did not contain unique top-level boolean SMS flags" >&2
  exit 1
fi

actual_sms_registration_enabled="$(printf '%s\n' "$actual_sms_features" | sed -n '1p')"
actual_sms_login_enabled="$(printf '%s\n' "$actual_sms_features" | sed -n '2p')"
actual_sms_password_reset_enabled="$(printf '%s\n' "$actual_sms_features" | sed -n '3p')"
if [ "$actual_sms_registration_enabled" != "$expected_sms_registration_enabled" ] ||
  [ "$actual_sms_login_enabled" != "$expected_sms_login_enabled" ] ||
  [ "$actual_sms_password_reset_enabled" != "$expected_sms_password_reset_enabled" ]; then
  echo "public SMS features do not match their expected values" >&2
  exit 1
fi

fetch "admin HTML" "$admin_html" \
  "$base_url/admin/index.html?release-check=$expected_release"

if asset_path="$(LC_ALL=C awk '
{
  line = $0
  while (match(line, /src="\/admin\/assets\/index-[A-Za-z0-9_-]+\.js"/)) {
    count += 1
    path = substr(line, RSTART + 5, RLENGTH - 6)
    line = substr(line, RSTART + RLENGTH)
  }
}
END {
  if (count != 1) exit 2
  printf "%s", path
}
' "$admin_html")"; then
  :
else
  echo "admin HTML must contain exactly one hashed Admin asset" >&2
  exit 1
fi

fetch "admin asset" "$admin_asset" "$base_url$asset_path"
if ! grep -F -- "$expected_release" "$admin_asset" >/dev/null; then
  echo "admin asset does not contain EXPECTED_RELEASE" >&2
  exit 1
fi
if grep -F -- '/api/admin/registrations?pageSize=100' "$admin_asset" >/dev/null; then
  echo "admin asset contains the legacy registrations endpoint" >&2
  exit 1
fi
for required_contract in ORGANIZATION_REVIEW_PENDING ACTIVE_ORGANIZATION_REQUIRED temporary-password; do
  if ! grep -F -- "$required_contract" "$admin_asset" >/dev/null; then
    echo "admin asset is missing organization account lifecycle contract" >&2
    exit 1
  fi
done

echo "release-consistency=$expected_release"
