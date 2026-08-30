$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$failures = [System.Collections.Generic.List[string]]::new()

function Read-RequiredFile([string]$relativePath) {
  $path = Join-Path $root $relativePath
  if (-not (Test-Path -LiteralPath $path)) {
    $failures.Add("Missing $relativePath")
    return ""
  }
  return Get-Content -Raw -Encoding utf8 -LiteralPath $path
}

function Require-Match([string]$content, [string]$pattern, [string]$message) {
  if ($content -notmatch $pattern) { $failures.Add($message) }
}

function Require-NoMatch([string]$content, [string]$pattern, [string]$message) {
  if ($content -match $pattern) { $failures.Add($message) }
}

$apiDockerfile = Read-RequiredFile "Dockerfile.api"
$webDockerfile = Read-RequiredFile "Dockerfile.web"
$nginx = Read-RequiredFile "deploy/nginx.conf"
$dockerIgnore = Read-RequiredFile ".dockerignore"
$compose = Read-RequiredFile "compose.yaml"
$backup = Read-RequiredFile "deploy/backup-postgres.sh"
$backupUploads = Read-RequiredFile "deploy/backup-uploads.sh"
$verifyUploadsBackup = Read-RequiredFile "deploy/verify-uploads-backup.sh"
$preflightUpgrade = Read-RequiredFile "deploy/preflight-admin-upgrade.sh"
$restore = Read-RequiredFile "deploy/restore-postgres.sh"
$bootstrapSecrets = Read-RequiredFile "deploy/bootstrap-secrets.sh"
$remoteSmoke = Read-RequiredFile "deploy/remote-smoke-test.sh"
$envExample = Read-RequiredFile ".env.example"

Require-Match $apiDockerfile '(?m)^USER\s+node\s*$' "API image must run as the node user"
Require-Match $apiDockerfile 'apk add --no-cache[^\r\n]*libc6-compat' "API runtime must install the sharp Alpine compatibility dependency"
Require-Match $apiDockerfile 'FROM\s+m\.daocloud\.io/docker\.io/library/node:22-alpine' "API build must use the project-scoped mainland Node mirror"
Require-Match $webDockerfile 'FROM\s+m\.daocloud\.io/docker\.io/library/node:22-alpine' "Web build must use the project-scoped mainland Node mirror"
Require-Match $webDockerfile 'FROM\s+m\.daocloud\.io/docker\.io/library/nginx:1\.27-alpine' "Web runtime must use the project-scoped mainland Nginx mirror"
Require-Match $nginx 'location\s+/\s*\{' "Nginx must serve the public SPA at /"
Require-Match $nginx 'location\s+/admin/\s*\{' "Nginx must serve the admin SPA at /admin/"
Require-Match $nginx 'location\s+/api/\s*\{' "Nginx must proxy /api/"
Require-Match $nginx 'resolver\s+127\.0\.0\.11\s+valid=10s\s+ipv6=off\s*;' "Nginx must use Docker DNS for dynamic API discovery"
Require-Match $nginx 'server\s+api:4300\s+resolve\s*;' "Nginx upstream must re-resolve the API container"
Require-Match $nginx 'proxy_pass\s+http://api_backend\s*;' "Nginx must preserve the /api/ prefix when proxying"
Require-NoMatch $nginx '(?m)^\s*auth_basic(?:_user_file)?\b' "Nginx must not require Basic Auth"
Require-NoMatch $webDockerfile 'entrypoint-web\.sh|check-aerogp-auth' "Web image must not require the Basic Auth entrypoint"
Require-Match $webDockerfile '(?m)^ARG VITE_PUBLIC_SITE_URL\s*$' "Web image must accept the canonical public origin"
Require-Match $webDockerfile '(?m)^ENV VITE_PUBLIC_SITE_URL=\$VITE_PUBLIC_SITE_URL\s*$' "Vite build must receive the canonical public origin"
Require-Match $dockerIgnore '(?m)^\.env\*?\s*$' ".dockerignore must exclude environment secrets"
Require-Match $dockerIgnore '(?m)^\*\*/uploads\s*$' ".dockerignore must exclude uploads"

foreach ($content in @($apiDockerfile, $webDockerfile)) {
  if ($content -match '(?im)^COPY\s+.*\.env') { $failures.Add("Dockerfiles must not copy .env files") }
}

Require-Match $compose '(?ms)^\s*caddy:\s*.*?^\s*ports:\s*\r?\n\s*-\s*"80:80"\s*\r?\n\s*-\s*"443:443"' "Caddy must publish HTTPS ports 80 and 443"
Require-NoMatch $compose '(?ms)^\s{2}web:\s*$(?:(?!^\s{2}\S).)*^\s{4}ports:' "Web must remain internal behind Caddy"
if ($compose -match '(?m)["''](?:4300|5432):') { $failures.Add("API and PostgreSQL ports must not be published") }
Require-Match $compose 'postgres_data:/var/lib/postgresql/data' "PostgreSQL data must use a named volume"
Require-Match $compose 'uploads_data:/data/uploads' "Uploads must use a named volume"
Require-Match $compose '\./backups:/backups' "Backups must persist on the host"
Require-NoMatch $compose '\.htpasswd' "Compose must not mount a Basic Auth password file"
Require-Match $compose '\$\{POSTGRES_PASSWORD:\?[^}]+\}' "Database password must be required from the environment"
Require-Match $compose 'SESSION_SECRET:\s*\$\{SESSION_SECRET:\?[^}]+\}' "API session secret must be required from the environment"
Require-Match $compose 'uploads_data:/uploads:ro' "Backup service must mount uploads read-only"
Require-Match $compose '\./backups:/backups(?::rw)?(?:\s|$)' "Backup service must mount the host backup directory writable"
Require-Match $compose 'VITE_PUBLIC_SITE_URL:\s*https://aerogp\.cn' "Compose must build the public site for aerogp.cn"
Require-Match $compose 'PUBLIC_SITE_URL:\s*https://aerogp\.cn' "API sitemap must use the public origin"

if ([regex]::Matches($compose, 'restart:\s+unless-stopped').Count -lt 4) { $failures.Add("All four services need restart protection") }
if ([regex]::Matches($compose, 'healthcheck:').Count -lt 4) { $failures.Add("All four services need health checks") }
if ([regex]::Matches($compose, 'max-size:\s*"10m"').Count -lt 4) { $failures.Add("All four services need log size rotation") }
if ([regex]::Matches($compose, 'max-file:\s*"3"').Count -lt 4) { $failures.Add("All four services need retained log limits") }

Require-Match $backup 'pg_dump' "Backup script must run pg_dump"
Require-Match $backup '-mtime\s+\+7' "Backup script must remove dumps older than seven days"
Require-Match $backup 'mv\s+(?:--\s+)?"?\$temp' "Backup script must atomically rename a completed dump"
Require-Match $backup 'pg_restore\s+--list' "Backup script must verify each completed dump"
Require-Match $backupUploads 'tar\s+-C\s+"\$uploads_dir"\s+-czf' "Uploads backup script must archive the uploads directory"
Require-Match $backupUploads 'mktemp' "Uploads backup script must use invocation-unique temporary files"
Require-Match $backupUploads 'ln\s+"\$temp"\s+"\$output"' "Uploads backup script must publish completed archives without overwriting"
Require-Match $backupUploads 'site-media' "Uploads backup must verify that website media is included"
Require-Match $verifyUploadsBackup 'tar\s+-tzf' "Uploads backup verifier must list the archive"
Require-Match $verifyUploadsBackup 'parts\[part_index\]\s*==\s*"\.\."' "Uploads backup verifier must reject parent traversal paths"
Require-Match $verifyUploadsBackup 'symbolic or hard link' "Uploads backup verifier must reject links"
Require-Match $preflightUpgrade 'pg_restore\s+--list' "Upgrade preflight must verify the latest database dump"
Require-Match $preflightUpgrade 'verify-uploads-backup\.sh' "Upgrade preflight must verify the latest uploads archive"
Require-Match $preflightUpgrade 'docker compose run --rm --no-deps -T -v "\$backups_dir:/backups:ro" backup' "Upgrade preflight must inspect the selected host backup directory with the pending Compose image"
Require-NoMatch $preflightUpgrade 'docker compose exec -T backup' "Upgrade preflight must not depend on the old running backup container mounts"
Require-Match $preflightUpgrade 'site-media' "Upgrade preflight must verify website media backup coverage"
Require-Match $preflightUpgrade 'SESSION_SECRET' "Upgrade preflight must validate SESSION_SECRET"
Require-Match $preflightUpgrade 'docker compose ps' "Upgrade preflight must validate container health"
Require-NoMatch $preflightUpgrade 'docker compose up' "Upgrade preflight must not start or replace containers"
Require-Match $restore 'CONFIRM_RESTORE' "Restore must require explicit confirmation"
Require-Match $bootstrapSecrets 'chmod\s+600\s+"\$deploy_dir/\.env"' "Database environment file must remain root-only"
Require-NoMatch $bootstrapSecrets 'htpasswd|aerogp-test-credentials|BASIC_AUTH_USER' "Secret bootstrap must only manage database credentials"
Require-NoMatch $remoteSmoke 'CREDENTIALS_FILE|(?m)^\s*auth=|(?-i:\s-u\s)' "Remote smoke tests must use unauthenticated HTTP requests"
Require-Match $remoteSmoke 'ADMIN_TEST_PASSWORD' "Remote smoke tests must receive the administrator password from the environment"
Require-Match $remoteSmoke 'cookie' "Remote smoke tests must preserve the authenticated session with a cookie jar"
Require-Match $remoteSmoke '--data-binary\s+@-' "Remote smoke tests must send login credentials through curl stdin"
Require-NoMatch $remoteSmoke '(?m)^\s*-d\s+"\$login_payload"' "Remote smoke tests must not put login credentials in curl argv"
foreach ($path in @('/healthz', '/api/public/home', '/api/public/content', '/api/public/sitemap.xml', '/brand/mark.svg', '/brand/wordmark.svg', '/api/admin/site-settings')) {
  if (-not $remoteSmoke.Contains($path)) { $failures.Add("Remote smoke tests must check $path") }
}
Require-Match $remoteSmoke 'encodeURIComponent' "Remote smoke tests must safely discover public detail URLs"
Require-Match $nginx 'location\s+\^~\s+/api/public/media/' "Nginx must give public media an explicit proxy policy"
Require-Match $nginx 'Content-Security-Policy' "Public media responses must receive a restrictive CSP"
Require-Match $nginx 'X-Content-Type-Options\s+"nosniff"' "Public media responses must disable MIME sniffing"
Require-Match $nginx 'max-age=31536000, immutable' "Hashed assets must be cached immutably"
Require-Match $nginx 'Cache-Control\s+"no-store"' "HTML must not be cached"
Require-Match $envExample '(?m)^POSTGRES_PASSWORD=' ".env.example must document POSTGRES_PASSWORD"
Require-NoMatch $envExample '(?m)^BASIC_AUTH_' ".env.example must not document removed Basic Auth variables"
foreach ($name in @(
  'ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE',
  'ALIYUN_SMS_LOGIN_TEMPLATE_CODE',
  'ALIYUN_SMS_RESET_TEMPLATE_CODE',
  'ALIYUN_CAPTCHA_ENABLED',
  'ALIYUN_CAPTCHA_REGION',
  'ALIYUN_CAPTCHA_PREFIX',
  'ALIYUN_CAPTCHA_SMS_REGISTRATION_SCENE_ID',
  'ALIYUN_CAPTCHA_LOGIN_SCENE_ID',
  'ALIYUN_CAPTCHA_SMS_RESET_SCENE_ID',
  'ALIYUN_CAPTCHA_EMAIL_RESET_SCENE_ID'
)) {
  Require-Match $envExample "(?m)^$name=" ".env.example must document $name"
  Require-Match $compose "$name`:\s*\`$\{$name`:-" "Compose must pass $name to the API"
}
Require-Match $envExample '(?m)^ALIYUN_CAPTCHA_ENABLED=false\r?$' "Aliyun captcha must default to disabled"
Require-NoMatch $envExample '(?m)^ALIYUN_SMS_TEMPLATE_CODE=' "The legacy shared SMS template must not be documented"
Require-NoMatch $compose 'ALIYUN_SMS_TEMPLATE_CODE:' "Compose must not pass the legacy shared SMS template"
Require-Match $compose 'ALIBABA_CLOUD_ACCESS_KEY_ID:\s*\$\{ALIBABA_CLOUD_ACCESS_KEY_ID:-\}' "Compose must inject the Alibaba Cloud access key id from the environment"
Require-Match $compose 'ALIBABA_CLOUD_ACCESS_KEY_SECRET:\s*\$\{ALIBABA_CLOUD_ACCESS_KEY_SECRET:-\}' "Compose must inject the Alibaba Cloud access key secret from the environment"
if ([regex]::Matches($compose, 'image:\s+m\.daocloud\.io/docker\.io/library/postgres:16-alpine').Count -lt 2) {
  $failures.Add("PostgreSQL services must use the project-scoped mainland mirror")
}

foreach ($entry in @(
  @{ Name = "database backup"; Content = $backup },
  @{ Name = "uploads backup"; Content = $backupUploads },
  @{ Name = "uploads backup verifier"; Content = $verifyUploadsBackup },
  @{ Name = "upgrade preflight"; Content = $preflightUpgrade },
  @{ Name = "remote smoke test"; Content = $remoteSmoke }
)) {
  Require-Match $entry.Content '(?m)^set -eu\s*$' "$($entry.Name) script must fail fast"
  Require-NoMatch $entry.Content '(?m)^\s*set\s+-[^\r\n]*x' "$($entry.Name) script must not enable shell tracing"
  Require-NoMatch $entry.Content '(?i)(?:cat|sed|awk|grep|head|tail|less|more)\s+[^\r\n]*\.env' "$($entry.Name) script must not print the environment file"
  Require-NoMatch $entry.Content '(?im)^(?![^\r\n]*(?:\||>))[^\r\n]*(?:echo|printf)\s+[^\r\n]*(?:PASSWORD|PGPASSWORD|SESSION_SECRET)' "$($entry.Name) script must not print passwords or session secrets"
}

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Output "Deployment configuration checks passed."
