#!/bin/sh
set -eu

deploy_dir="${1:-/opt/aerogp}"

install -d -m 700 "$deploy_dir" "$deploy_dir/backups"
umask 077

if [ ! -s "$deploy_dir/.env" ]; then
  database_password="$(openssl rand -hex 32)"
  session_secret="$(openssl rand -hex 32)"
  printf 'POSTGRES_DB=aerogp\nPOSTGRES_USER=aerogp\nPOSTGRES_PASSWORD=%s\nSESSION_SECRET=%s\n' \
    "$database_password" "$session_secret" > "$deploy_dir/.env"
  unset database_password session_secret
elif ! grep -Eq '^SESSION_SECRET=.+$' "$deploy_dir/.env"; then
  session_secret="$(openssl rand -hex 32)"
  if grep -q '^SESSION_SECRET=' "$deploy_dir/.env"; then
    sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$session_secret/" "$deploy_dir/.env"
  else
    printf 'SESSION_SECRET=%s\n' "$session_secret" >> "$deploy_dir/.env"
  fi
  unset session_secret
fi

chmod 600 "$deploy_dir/.env"
echo "Database and session secrets are ready in $deploy_dir/.env"
