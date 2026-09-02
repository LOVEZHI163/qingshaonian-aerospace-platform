#!/bin/sh

smoke_extract_temporary_password() {
  smoke_response_file="$1"
  smoke_secret_file="$2"
  smoke_secret_tmp="${smoke_secret_file}.tmp.$$"
  rm -f -- "$smoke_secret_tmp" "$smoke_secret_file"
  if ! docker compose exec -T api node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>{const data=JSON.parse(input);if(!data.row||data.row.mustChangePassword!==true||typeof data.temporaryPassword!=="string"||!data.temporaryPassword)process.exit(2);process.stdout.write(data.temporaryPassword);});' < "$smoke_response_file" > "$smoke_secret_tmp"; then
    rm -f -- "$smoke_secret_tmp" "$smoke_secret_file"
    return 1
  fi
  chmod 600 "$smoke_secret_tmp"
  mv -f -- "$smoke_secret_tmp" "$smoke_secret_file"
}

smoke_remove_container_registration_token() {
  smoke_registration_container_file="$1"
  case "$smoke_registration_container_file" in
    /tmp/aerogp-registration-token-*) ;;
    *) return 1 ;;
  esac
  SMOKE_REGISTRATION_TOKEN_PATH="$smoke_registration_container_file" \
    docker compose exec -T -e SMOKE_REGISTRATION_TOKEN_PATH api \
      node --input-type=module -e '
        import { rmSync } from "node:fs";
        const tokenPath = process.env.SMOKE_REGISTRATION_TOKEN_PATH;
        if (!tokenPath) process.exit(2);
        try {
          rmSync(tokenPath, { force: true });
        } catch {
          process.exit(2);
        }
      ' >/dev/null 2>&1
}

smoke_cleanup_phone_registration_token() {
  smoke_registration_cleanup_container_file="$1"
  smoke_registration_cleanup_tmp="$2"
  smoke_registration_cleanup_file="$3"
  smoke_registration_cleanup_status=0
  smoke_remove_container_registration_token "$smoke_registration_cleanup_container_file" || \
    smoke_registration_cleanup_status=1
  rm -f -- "$smoke_registration_cleanup_tmp" "$smoke_registration_cleanup_file" || \
    smoke_registration_cleanup_status=1
  return "$smoke_registration_cleanup_status"
}

smoke_issue_phone_registration_token() {
  smoke_registration_phone="$1"
  smoke_registration_token_file="$2"
  smoke_registration_token_tmp="${smoke_registration_token_file}.tmp.$$"
  smoke_registration_token_sequence="${smoke_registration_token_sequence:-0}"
  smoke_registration_token_sequence=$((smoke_registration_token_sequence + 1))
  smoke_registration_container_file="/tmp/aerogp-registration-token-$$-$smoke_registration_token_sequence"
  rm -f -- "$smoke_registration_token_tmp" "$smoke_registration_token_file"
  if ! SMOKE_REGISTRATION_PHONE="$smoke_registration_phone" \
    SMOKE_REGISTRATION_TOKEN_PATH="$smoke_registration_container_file" \
    docker compose exec -T \
      -e SMOKE_REGISTRATION_PHONE \
      -e SMOKE_REGISTRATION_TOKEN_PATH \
      api \
      node --input-type=module -e '
        import { writeFileSync } from "node:fs";
        import { randomBytes } from "node:crypto";
        import { createPhoneRegistrationToken } from "./apps/api/src/auth/sms-registration.js";
        const secret = process.env.SESSION_SECRET;
        const phone = process.env.SMOKE_REGISTRATION_PHONE;
        const tokenPath = process.env.SMOKE_REGISTRATION_TOKEN_PATH;
        if (!secret || !phone || !tokenPath) {
          process.exit(2);
        }
        const issued = createPhoneRegistrationToken({
          phone,
          secret,
          now: Date.now(),
          nonce: randomBytes(16).toString("base64url")
        });
        try {
          writeFileSync(tokenPath, issued.phoneVerificationToken, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600
          });
        } catch {
          process.exit(2);
        }
      ' >/dev/null 2>&1; then
    if smoke_cleanup_phone_registration_token \
      "$smoke_registration_container_file" \
      "$smoke_registration_token_tmp" \
      "$smoke_registration_token_file"; then
      smoke_registration_container_file=
    fi
    return 1
  fi

  if ! docker compose cp \
    "api:$smoke_registration_container_file" \
    "$smoke_registration_token_tmp" >/dev/null 2>&1; then
    if smoke_cleanup_phone_registration_token \
      "$smoke_registration_container_file" \
      "$smoke_registration_token_tmp" \
      "$smoke_registration_token_file"; then
      smoke_registration_container_file=
    fi
    return 1
  fi

  if ! smoke_remove_container_registration_token "$smoke_registration_container_file"; then
    rm -f -- "$smoke_registration_token_tmp" "$smoke_registration_token_file"
    return 1
  fi
  smoke_registration_container_file=
  if ! test -s "$smoke_registration_token_tmp" || \
    ! chmod 600 "$smoke_registration_token_tmp" || \
    ! mv -f -- "$smoke_registration_token_tmp" "$smoke_registration_token_file"; then
    rm -f -- "$smoke_registration_token_tmp" "$smoke_registration_token_file"
    return 1
  fi
}
