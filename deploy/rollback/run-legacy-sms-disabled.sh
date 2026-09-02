#!/bin/sh
set -eu

# sms-rollback-v1: start an archived pre-018 release with every SMS input disabled.
# This wrapper deliberately does not print its environment or invoke `docker compose config`.

if [ "$#" -lt 1 ]; then
  echo "usage: $0 ARCHIVED_RELEASE_DIR [docker-compose-up options]" >&2
  exit 64
fi

release_dir=$(CDPATH= cd -- "$1" && pwd -P)
shift
compose_file="$release_dir/compose.yaml"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
override_file="$script_dir/legacy-sms-disabled.compose.yaml"
docker_bin=${DOCKER_BIN:-docker}

if [ ! -f "$compose_file" ]; then
  echo "archived release is missing compose.yaml" >&2
  exit 66
fi
if [ ! -r "$override_file" ]; then
  echo "SMS rollback override is unavailable" >&2
  exit 66
fi

# Empty process values take precedence over values loaded from the archived .env.
# The compose override independently supplies the same literals as a second boundary.
exec env \
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
    -f "$override_file" \
    up "$@"
