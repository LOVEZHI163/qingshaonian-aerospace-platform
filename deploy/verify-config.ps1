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
$restore = Read-RequiredFile "deploy/restore-postgres.sh"
$bootstrapSecrets = Read-RequiredFile "deploy/bootstrap-secrets.sh"
$remoteSmoke = Read-RequiredFile "deploy/remote-smoke-test.sh"
$envExample = Read-RequiredFile ".env.example"

Require-Match $apiDockerfile '(?m)^USER\s+node\s*$' "API image must run as the node user"
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
Require-Match $dockerIgnore '(?m)^\.env\*?\s*$' ".dockerignore must exclude environment secrets"
Require-Match $dockerIgnore '(?m)^\*\*/uploads\s*$' ".dockerignore must exclude uploads"

foreach ($content in @($apiDockerfile, $webDockerfile)) {
  if ($content -match '(?im)^COPY\s+.*\.env') { $failures.Add("Dockerfiles must not copy .env files") }
}

Require-Match $compose '(?ms)^\s*ports:\s*\r?\n\s*-\s*"80:80"' "Only the web service may publish port 80"
if ($compose -match '(?m)["''](?:4300|5432):') { $failures.Add("API and PostgreSQL ports must not be published") }
Require-Match $compose 'postgres_data:/var/lib/postgresql/data' "PostgreSQL data must use a named volume"
Require-Match $compose 'uploads_data:/data/uploads' "Uploads must use a named volume"
Require-Match $compose '\./backups:/backups' "Backups must persist on the host"
Require-NoMatch $compose '\.htpasswd' "Compose must not mount a Basic Auth password file"
Require-Match $compose '\$\{POSTGRES_PASSWORD:\?[^}]+\}' "Database password must be required from the environment"

if ([regex]::Matches($compose, 'restart:\s+unless-stopped').Count -lt 4) { $failures.Add("All four services need restart protection") }
if ([regex]::Matches($compose, 'healthcheck:').Count -lt 4) { $failures.Add("All four services need health checks") }
if ([regex]::Matches($compose, 'max-size:\s*"10m"').Count -lt 4) { $failures.Add("All four services need log size rotation") }
if ([regex]::Matches($compose, 'max-file:\s*"3"').Count -lt 4) { $failures.Add("All four services need retained log limits") }

Require-Match $backup 'pg_dump' "Backup script must run pg_dump"
Require-Match $backup '-mtime\s+\+7' "Backup script must remove dumps older than seven days"
Require-Match $backup 'mv\s+(?:--\s+)?"?\$temp' "Backup script must atomically rename a completed dump"
Require-Match $restore 'CONFIRM_RESTORE' "Restore must require explicit confirmation"
Require-Match $bootstrapSecrets 'chmod\s+600\s+"\$deploy_dir/\.env"' "Database environment file must remain root-only"
Require-NoMatch $bootstrapSecrets 'htpasswd|aerogp-test-credentials|BASIC_AUTH_USER' "Secret bootstrap must only manage database credentials"
Require-NoMatch $remoteSmoke 'CREDENTIALS_FILE|(?m)^\s*auth=|\s-u\s' "Remote smoke tests must use unauthenticated HTTP requests"
Require-Match $envExample '(?m)^POSTGRES_PASSWORD=' ".env.example must document POSTGRES_PASSWORD"
Require-NoMatch $envExample '(?m)^BASIC_AUTH_' ".env.example must not document removed Basic Auth variables"
if ([regex]::Matches($compose, 'image:\s+m\.daocloud\.io/docker\.io/library/postgres:16-alpine').Count -lt 2) {
  $failures.Add("PostgreSQL services must use the project-scoped mainland mirror")
}

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Output "Deployment configuration checks passed."
