#!/bin/sh
# Run only in an isolated container with empty /backups and /uploads tmpfs mounts.
set -eu
umask 077
mode="${1:-success}"
mkdir -p /tmp/test-bin /uploads/site-media /uploads/certificates
printf 'test-site-media\n' > /uploads/site-media/probe.txt
printf 'test-certificate\n' > /uploads/certificates/probe.txt
cat > /tmp/test-bin/pg_dump <<'SH'
#!/bin/sh
for arg in "$@"; do
  case "$arg" in --file=*) printf 'synthetic-database-dump\n' > "${arg#--file=}" ;; esac
done
SH
cat > /tmp/test-bin/pg_restore <<'SH'
#!/bin/sh
exit 0
SH
chmod +x /tmp/test-bin/pg_dump /tmp/test-bin/pg_restore
export PATH="/tmp/test-bin:$PATH"
case "$mode" in
  success)
    /bin/sh /scripts/backup-postgres.sh once
    test -f /tmp/aerogp-backup-alive
    set -- /backups/aerogp-*.dump
    test -s "$1"
    set -- /backups/uploads/aerogp-uploads-*.tar.gz
    test -s "$1"
    test "$(tar -xOzf "$1" ./site-media/probe.txt)" = test-site-media
    test "$(tar -xOzf "$1" ./certificates/probe.txt)" = test-certificate
    ;;
  unsafe-attachment)
    ln -s /etc/passwd /uploads/certificates/unsafe-link
    touch /tmp/aerogp-backup-alive
    if /bin/sh /scripts/backup-postgres.sh once; then echo 'FAIL: unsafe attachment backup reported success'; exit 1; fi
    test ! -e /tmp/aerogp-backup-alive
    test -z "$(find /backups/uploads -name 'aerogp-uploads-*.tar.gz' -type f)"
    ;;
  *) exit 2 ;;
esac
printf 'PASS backup-cycle %s\n' "$mode"
