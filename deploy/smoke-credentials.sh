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

smoke_issue_phone_registration_token() {
  smoke_registration_phone="$1"
  smoke_registration_token_file="$2"
  smoke_registration_token_tmp="${smoke_registration_token_file}.tmp.$$"
  rm -f -- "$smoke_registration_token_tmp" "$smoke_registration_token_file"
  if ! SMOKE_REGISTRATION_PHONE="$smoke_registration_phone" \
    docker compose exec -T -e SMOKE_REGISTRATION_PHONE api \
      node --input-type=module -e '
        import { randomBytes } from "node:crypto";
        import { createPhoneRegistrationToken } from "./apps/api/src/auth/sms-registration.js";
        const secret = process.env.SESSION_SECRET;
        const phone = process.env.SMOKE_REGISTRATION_PHONE;
        if (!secret || !phone) process.exit(2);
        const issued = createPhoneRegistrationToken({
          phone,
          secret,
          now: Date.now(),
          nonce: randomBytes(16).toString("base64url")
        });
        process.stdout.write(issued.phoneVerificationToken);
      ' > "$smoke_registration_token_tmp"; then
    rm -f -- "$smoke_registration_token_tmp" "$smoke_registration_token_file"
    return 1
  fi
  test -s "$smoke_registration_token_tmp" || {
    rm -f -- "$smoke_registration_token_tmp" "$smoke_registration_token_file"
    return 1
  }
  chmod 600 "$smoke_registration_token_tmp"
  mv -f -- "$smoke_registration_token_tmp" "$smoke_registration_token_file"
}
