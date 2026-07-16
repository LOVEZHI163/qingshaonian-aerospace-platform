#!/bin/sh
set -eu

deploy_dir="${1:-/opt/aerogp}"

install -d -m 700 "$deploy_dir" "$deploy_dir/backups"
umask 077

if [ ! -s "$deploy_dir/.env" ]; then
  database_password="$(openssl rand -hex 32)"
  printf 'POSTGRES_DB=aerogp\nPOSTGRES_USER=aerogp\nPOSTGRES_PASSWORD=%s\n' \
    "$database_password" > "$deploy_dir/.env"
  unset database_password
fi

chmod 600 "$deploy_dir/.env"
echo "Database secret is ready in $deploy_dir/.env"
