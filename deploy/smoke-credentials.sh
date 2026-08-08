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
