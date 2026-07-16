# AeroGP Public Test Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the HTTP Basic Auth gate so the test homepage opens directly while preserving application login, role checks, PostgreSQL data, and private container ports.

**Architecture:** Nginx remains the only public service on port 80, but no longer evaluates `.htpasswd`. Compose, image startup, secret bootstrap, smoke tests, and the runbook are simplified to remove the unused outer-auth dependency. API authorization and PostgreSQL networking remain unchanged.

**Tech Stack:** Nginx 1.27 Alpine, Docker Compose, PowerShell configuration tests, shell smoke tests, Node.js/Vite, PostgreSQL 16.

## Global Constraints

- Do not rebuild, remove, or replace the `aerogp_postgres_data` or `aerogp_uploads_data` volumes.
- Do not publish API port `4300` or PostgreSQL port `5432`.
- Keep application registration, login, roles, and admin authorization unchanged.
- Keep `/healthz`, `/`, `/admin/`, and `/api/` routing unchanged except for removing Basic Auth.
- Remove `/root/aerogp-test-credentials.txt` only after unauthenticated public verification passes.
- Use only fictitious test data until domain filing, HTTPS, and a production security review are complete.

---

### Task 1: Make deployment verification require direct public access

**Files:**
- Modify: `deploy/verify-config.ps1`
- Test: `deploy/verify-config.ps1`

**Interfaces:**
- Consumes: deployment file contents loaded by `Read-RequiredFile`.
- Produces: a failing exit code when Basic Auth configuration or credentials remain; a zero exit code after Task 2 removes them.

- [ ] **Step 1: Write the failing configuration assertions**

Add this helper after `Require-Match`:

```powershell
function Require-NoMatch([string]$content, [string]$pattern, [string]$message) {
  if ($content -match $pattern) { $failures.Add($message) }
}
```

Load the smoke-test script:

```powershell
$remoteSmoke = Read-RequiredFile "deploy/remote-smoke-test.sh"
```

Replace the positive Basic Auth assertions with:

```powershell
Require-NoMatch $nginx '(?m)^\s*auth_basic(?:_user_file)?\b' "Nginx must not require Basic Auth"
Require-NoMatch $compose '\.htpasswd' "Compose must not mount a Basic Auth password file"
Require-NoMatch $webDockerfile 'entrypoint-web\.sh|check-aerogp-auth' "Web image must not require the Basic Auth entrypoint"
Require-NoMatch $bootstrapSecrets 'htpasswd|aerogp-test-credentials|BASIC_AUTH_USER' "Secret bootstrap must only manage database credentials"
Require-NoMatch $remoteSmoke 'CREDENTIALS_FILE|PASSWORD|\s-u\s' "Remote smoke tests must use unauthenticated HTTP requests"
Require-NoMatch $envExample '(?m)^BASIC_AUTH_' ".env.example must not document removed Basic Auth variables"
```

Delete the old assertions that require `.htpasswd` and its permissions.

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1
```

Expected: exit `1` with failures stating that Nginx, Compose, the Web image, bootstrap script, smoke test, and `.env.example` still contain Basic Auth configuration.

---

### Task 2: Remove the outer-auth dependency

**Files:**
- Modify: `deploy/nginx.conf`
- Modify: `compose.yaml`
- Modify: `Dockerfile.web`
- Delete: `deploy/entrypoint-web.sh`
- Modify: `deploy/bootstrap-secrets.sh`
- Modify: `deploy/remote-smoke-test.sh`
- Modify: `.env.example`
- Test: `deploy/verify-config.ps1`

**Interfaces:**
- Consumes: Docker Compose environment containing only PostgreSQL variables.
- Produces: an Nginx container that serves public routes directly and a smoke test that requires no credentials file.

- [ ] **Step 1: Remove Nginx Basic Auth**

In `deploy/nginx.conf`, make the top of the server block exactly:

```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  client_max_body_size 30m;

  location = /healthz {
    access_log off;
    default_type text/plain;
    return 200 "ok\n";
  }
```

Keep the existing `/api/`, `/admin/`, `/`, asset, and HTML locations unchanged.

- [ ] **Step 2: Remove the password-file mount and startup check**

Make the `web` service in `compose.yaml` start as:

```yaml
  web:
    build:
      context: .
      dockerfile: Dockerfile.web
    ports:
      - "80:80"
    depends_on:
      api:
        condition: service_healthy
```

Keep its health check, restart policy, and logging configuration unchanged.

Make the runtime stage of `Dockerfile.web` exactly:

```dockerfile
FROM m.daocloud.io/docker.io/library/nginx:1.27-alpine AS runtime

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html/admin

EXPOSE 80
```

Delete `deploy/entrypoint-web.sh`.

- [ ] **Step 3: Simplify secret bootstrap**

Replace `deploy/bootstrap-secrets.sh` with:

```sh
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
```

Replace `.env.example` with:

```dotenv
# Copy to .env and replace the password with a long random value before starting.
POSTGRES_DB=aerogp
POSTGRES_USER=aerogp
POSTGRES_PASSWORD=
```

- [ ] **Step 4: Remove credentials from the smoke test**

In `deploy/remote-smoke-test.sh`, delete the credentials-file loading, the `auth` variable, and every `-u "$auth"` argument. The first three requests must be:

```sh
assert_status "home" 200 "$base_url/"
assert_status "admin" 200 "$base_url/admin/"
assert_status "event-api" 200 "$base_url/api/public/event"
```

The registration and login requests keep their existing JSON bodies but contain no `-u` argument.

- [ ] **Step 5: Run the configuration checks and verify GREEN**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1
$env:POSTGRES_PASSWORD='verification-only'
docker compose config --quiet
```

Expected: `Deployment configuration checks passed.` and Compose exits `0` without an auth-volume requirement.

---

### Task 3: Update operator documentation and run full local verification

**Files:**
- Modify: `docs/deployment/aliyun-test.md`
- Test: `apps/api/test/*.test.js`

**Interfaces:**
- Consumes: the public-access behavior from Task 2.
- Produces: a runbook whose commands and expected status codes match the deployed system.

- [ ] **Step 1: Update the runbook**

Apply these exact behavior changes to `docs/deployment/aliyun-test.md`:

```markdown
本环境仅供开发者与业主验收，访问 IP 会直接显示主页。只允许使用虚构测试数据，不上传真实身份证件、手机号或正式证书。
```

The initial secret setup must create only `.env`:

```bash
install -d -m 700 /opt/aerogp /opt/aerogp/backups
cd /opt/aerogp
umask 077
DB_PASSWORD="$(openssl rand -hex 32)"
printf 'POSTGRES_DB=aerogp\nPOSTGRES_USER=aerogp\nPOSTGRES_PASSWORD=%s\n' "$DB_PASSWORD" > .env
unset DB_PASSWORD
chmod 600 .env
```

The health-check commands must require no credentials:

```bash
curl -i http://127.0.0.1/healthz
curl -I http://127.0.0.1/
curl http://127.0.0.1/api/public/event
```

Document that all three return `200`, and remove the instruction to remove Basic Auth before domain launch.

- [ ] **Step 2: Run full local verification**

Run:

```powershell
npm.cmd test -w apps/api
npm.cmd run build
powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1
$env:POSTGRES_PASSWORD='verification-only'
docker compose config --quiet
git diff --check
```

Expected: 10 API tests pass, both Vite applications build, configuration checks pass, Compose exits `0`, and `git diff --check` exits `0`.

---

### Task 4: Deploy the public Web entry and verify from the internet

**Files:**
- Deploy to: `/opt/aerogp/Dockerfile.web`
- Deploy to: `/opt/aerogp/compose.yaml`
- Deploy to: `/opt/aerogp/.env.example`
- Deploy to: `/opt/aerogp/deploy/`
- Deploy to: `/opt/aerogp/docs/deployment/aliyun-test.md`

**Interfaces:**
- Consumes: the existing SSH alias `aerogp` and the existing `/opt/aerogp/.env` PostgreSQL secret.
- Produces: public HTTP `200` responses without an Authorization header; no change to PostgreSQL volumes.

- [ ] **Step 1: Upload only the changed deployment files**

Create a temporary archive that preserves directories, copy it to the server, and extract it over `/opt/aerogp`. Do not include `.env`, `backups`, `auth`, `node_modules`, or Git metadata.

- [ ] **Step 2: Validate and rebuild only Web**

Run on the server:

```bash
cd /opt/aerogp
docker compose config --quiet
docker compose build web
docker compose up -d --no-deps web
docker compose ps
```

Expected: `web` becomes healthy; `api`, `postgres`, and `backup` remain running and are not recreated.

- [ ] **Step 3: Verify unauthenticated behavior before deleting credentials**

Run from the local machine:

```powershell
curl.exe -sS -o NUL -w "%{http_code}" http://47.99.181.222/healthz
curl.exe -sS -o NUL -w "%{http_code}" http://47.99.181.222/
curl.exe -sS -o NUL -w "%{http_code}" http://47.99.181.222/admin/
curl.exe -sS -o NUL -w "%{http_code}" http://47.99.181.222/api/public/event
```

Expected: every request returns `200` without credentials.

- [ ] **Step 4: Verify application login and data persistence**

Run the updated remote smoke test:

```bash
cd /opt/aerogp
/bin/sh deploy/remote-smoke-test.sh
```

Expected: homepage, admin, event API, registration (`201` or `409`), and application login (`200`) all pass.

- [ ] **Step 5: Remove stopped outer-auth secrets and complete checks**

After Step 3 and Step 4 pass, remove only:

```bash
rm -f /root/aerogp-test-credentials.txt /opt/aerogp/auth/.htpasswd
rmdir /opt/aerogp/auth 2>/dev/null || true
```

Then run:

```bash
cd /opt/aerogp
docker compose ps
ss -lntp
docker compose run --rm backup /bin/sh /scripts/verify-backup.sh
```

Expected: all four services are healthy, the host listens publicly only on `22` and `80`, and the latest database backup is readable.
