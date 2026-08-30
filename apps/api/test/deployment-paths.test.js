import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");

function runConfigVerification({ platform = process.platform } = {}) {
  if (platform !== "win32") return Promise.resolve({ skipped: true });
  return new Promise((resolve, reject) => {
    const child = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-File", "deploy/verify-config.ps1"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

const shell = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "/bin/sh";

function shellPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  if (process.platform !== "win32") return normalized;
  return normalized.replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`);
}

function shellSearchPath(extraPath) {
  const current = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map(shellPath)
    .join(":");
  return `${shellPath(extraPath)}:${current}`;
}

function runShell(scriptPath, { args = [], env = {}, prependPath = "" } = {}) {
  return new Promise((resolve, reject) => {
    const command = prependPath
      ? 'PATH="$1:$PATH"; export PATH; shift; exec "$@"'
      : 'exec "$@"';
    const shellArgs = ["-c", command, "deployment-test"];
    if (prependPath) shellArgs.push(shellPath(prependPath));
    shellArgs.push(shellPath(scriptPath), ...args);
    const child = spawn(shell, shellArgs, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function createDeploymentScriptHarness(features) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-deploy-test-"));
  const binDirectory = path.join(directory, "bin");
  const featureFile = path.join(directory, "features.json");
  const curlLog = path.join(directory, "curl.log");
  await fs.mkdir(binDirectory);
  await fs.writeFile(featureFile, `${JSON.stringify({ ...features, captcha: { enabled: false } })}\n`);
  await fs.writeFile(curlLog, "");
  await fs.writeFile(path.join(binDirectory, "curl"), `#!/bin/sh
set -eu
output=/dev/null
format=
url=
authenticated=0
while test "$#" -gt 0; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -w) format="$2"; shift 2 ;;
    -b) authenticated=1; shift 2 ;;
    --connect-timeout|--max-time|-H|-c|-F|-X|--data-binary) shift 2 ;;
    -s|-S|-sS|-f|-fsS) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$FAKE_CURL_LOG"
status=200
content_type=application/json
case "$url" in
  */api/system/version)
    printf '%s' '{"releaseSha":"0000000000000000000000000000000000000000","apiVersion":1}' > "$output" ;;
  */api/public/features)
    cat "$FAKE_FEATURES_FILE" > "$output" ;;
  */admin/index.html*)
    content_type=text/html
    printf '%s' '<script type="module" src="/admin/assets/index-test.js"></script>' > "$output" ;;
  */admin/assets/index-test.js)
    content_type=application/javascript
    printf '%s' '0000000000000000000000000000000000000000 ORGANIZATION_REVIEW_PENDING ACTIVE_ORGANIZATION_REQUIRED temporary-password' > "$output" ;;
  */api/public/home)
    printf '%s' '{"featuredEvent":{"slug":"smoke-event"}}' > "$output" ;;
  */api/public/content*)
    printf '%s' '{"rows":[]}' > "$output" ;;
  */api/admin/events)
    printf '%s' '{"rows":[{"id":"event-1","status":"published","archivedAt":null}]}' > "$output" ;;
  */api/admin/organizations|*/api/users)
    printf '%s' '{"rows":[]}' > "$output" ;;
  */api/auth/register/sms/request|*/api/auth/sms-login/request|*/api/auth/password-reset/sms/request)
    status=503
    printf '%s' '{"error":"disabled"}' > "$output" ;;
  */api/me/organization-relations)
    status=401
    printf '%s' '{"error":"unauthorized"}' > "$output" ;;
  */api/organization/memberships)
    status=403
    printf '%s' '{"error":"forbidden"}' > "$output" ;;
  */api/admin/registrations|*__smoke_missing_*)
    status=404
    printf '%s' '{"error":"not found"}' > "$output" ;;
  */api/admin/site-settings)
    if test "$authenticated" -eq 0; then status=401; fi
    printf '%s' '{"error":"unauthorized"}' > "$output" ;;
  *)
    printf '%s' '{}' > "$output" ;;
esac
case "$format" in
  *content_type*) printf '%s\\n%s' "$status" "$content_type" ;;
  *) printf '%s' "$status" ;;
esac
case "$status" in
  4??|5??) exit 22 ;;
esac
`, "utf8");
  await fs.writeFile(path.join(binDirectory, "docker"), `#!/bin/sh
set -eu
case " $* " in
  *" exec -T postgres "*)
    printf '%s\\n' 1
    exit 0
    ;;
esac
while test "$#" -gt 0 && test "$1" != node; do shift; done
test "$#" -gt 0
exec "$@"
`, "utf8");
  await Promise.all([
    fs.chmod(path.join(binDirectory, "curl"), 0o755),
    fs.chmod(path.join(binDirectory, "docker"), 0o755)
  ]);
  return {
    directory,
    binDirectory,
    curlLog,
    environment: {
      PATH: shellSearchPath(binDirectory),
      FAKE_FEATURES_FILE: shellPath(featureFile),
      FAKE_CURL_LOG: shellPath(curlLog)
    },
    cleanup: () => fs.rm(directory, { recursive: true, force: true })
  };
}

test("deployment configuration verifier has an explicit non-Windows skip policy", async () => {
  const result = await runConfigVerification({ platform: "linux" });

  assert.deepEqual(result, { skipped: true });
});

function shellBlockAfter(document, marker) {
  const markerIndex = document.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing document marker: ${marker}`);
  const fenceIndex = document.indexOf("```bash", markerIndex);
  assert.notEqual(fenceIndex, -1, `missing shell block after: ${marker}`);
  const bodyIndex = document.indexOf("\n", fenceIndex) + 1;
  const endIndex = document.indexOf("```", bodyIndex);
  assert.notEqual(endIndex, -1, `unterminated shell block after: ${marker}`);
  return document.slice(bodyIndex, endIndex);
}

function assertAtomicMarkerGate(shellBlock, releaseVariable) {
  const release = `\\$${releaseVariable}`;
  assert.match(
    shellBlock,
    new RegExp(
      `^if EXPECTED_RELEASE="${release}"[^\\r\\n]*verify-release\\.sh &&\\r?\\n` +
      `\\s+[^\\r\\n]*remote-smoke-test\\.sh; then$`,
      "m"
    )
  );
  assert.match(
    shellBlock,
    new RegExp(
      `^  printf '%s\\\\n' "${release}" > \\.release\\.next\\r?\\n` +
      `  mv \\.release\\.next \\.release$`,
      "m"
    )
  );
  assert.match(
    shellBlock,
    /^else\r?\n  rm -f \.release\.next\r?\n  echo '[^'\r\n]*existing \.release was preserved\.' >&2\r?\n  exit 1\r?\nfi$/m
  );
  assert.doesNotMatch(shellBlock, /> \.release\s*$/m);
}

function assertExplicitReleaseInput(shellBlock, releaseVariable) {
  assert.match(shellBlock, new RegExp(`^: "\\$\\{${releaseVariable}:\\?[^}]+\\}"$`, "m"));
  assert.match(
    shellBlock,
    new RegExp(`^case "\\$${releaseVariable}" in\\r?\\n\\s+\\(\\*\\[\\!0-9a-fA-F\\]\\*\\|.{0,20}\\)`, "m")
  );
  assert.match(shellBlock, new RegExp(`^if \\[ "\\$\\{#${releaseVariable}\\}" -ne 40 \\]; then$`, "m"));
  assert.doesNotMatch(shellBlock, /git rev-parse|git describe|git log/);
}

test("deployment paths use same-origin API and the /admin/ base", async () => {
  const [webApi, webFooter, admin, adminApi, adminVite] = await Promise.all([
    fs.readFile(path.join(root, "apps/web/src/api/client.js"), "utf8"),
    fs.readFile(path.join(root, "apps/web/src/components/SiteFooter.jsx"), "utf8"),
    fs.readFile(path.join(root, "apps/admin/src/App.vue"), "utf8"),
    fs.readFile(path.join(root, "apps/admin/src/lib/api.js"), "utf8"),
    fs.readFile(path.join(root, "apps/admin/vite.config.js"), "utf8")
  ]);

  assert.equal(webApi.includes("localhost:4300"), false);
  assert.equal(webFooter.includes("localhost:5174"), false);
  assert.match(webApi, /VITE_API_URL\s*\|\|\s*["']{2}/);
  assert.match(webFooter, /href=["']\/admin\/["']/);

  assert.equal(admin.includes("localhost:4300"), false);
  assert.equal(adminApi.includes("localhost:4300"), false);
  assert.match(adminApi, /VITE_API_URL\s*\|\|\s*["']{2}/);
  assert.match(adminVite, /base:\s*["']\/admin\/["']/);
});

test("deployment configuration requires and bootstraps a session secret", async () => {
  const [example, compose, bootstrap] = await Promise.all([
    fs.readFile(path.join(root, ".env.example"), "utf8"),
    fs.readFile(path.join(root, "compose.yaml"), "utf8"),
    fs.readFile(path.join(root, "deploy/bootstrap-secrets.sh"), "utf8")
  ]);

  assert.match(example, /^SESSION_SECRET=$/m);
  assert.match(compose, /SESSION_SECRET:\s*\$\{SESSION_SECRET:\?SESSION_SECRET is required\}/);
  assert.match(bootstrap, /session_secret="\$\(openssl rand -hex 32\)"/);
  assert.match(bootstrap, /SESSION_SECRET=%s/);
  assert.match(bootstrap, /elif ! grep -Eq '\^SESSION_SECRET=\.\+\$'/);
  assert.match(bootstrap, /sed -i "s\/\^SESSION_SECRET=\.\*\/SESSION_SECRET=\$session_secret\/"/);
  assert.match(bootstrap, /chmod 600 "\$deploy_dir\/\.env"/);
});

test("deployment requires a generated 32-byte registration identity encryption key", async () => {
  const [example, compose, bootstrap, preflight, lockedSensitiveRead] = await Promise.all([
    fs.readFile(path.join(root, ".env.example"), "utf8"),
    fs.readFile(path.join(root, "compose.yaml"), "utf8"),
    fs.readFile(path.join(root, "deploy/bootstrap-secrets.sh"), "utf8"),
    fs.readFile(path.join(root, "deploy/preflight-admin-upgrade.sh"), "utf8"),
    fs.readFile(path.join(root, "apps/api/test/locked-sensitive-read.test.js"), "utf8")
  ]);

  assert.match(example, /^REGISTRATION_ID_ENCRYPTION_KEY=$/m);
  assert.doesNotMatch(example, /^REGISTRATION_ID_ENCRYPTION_KEY=.+$/m);
  assert.match(
    compose,
    /REGISTRATION_ID_ENCRYPTION_KEY:\s*\$\{REGISTRATION_ID_ENCRYPTION_KEY:\?REGISTRATION_ID_ENCRYPTION_KEY is required\}/
  );
  assert.doesNotMatch(compose, /REGISTRATION_ID_ENCRYPTION_KEY:\s*\$\{REGISTRATION_ID_ENCRYPTION_KEY:-/);
  assert.match(bootstrap, /registration_id_encryption_key="\$\(openssl rand -base64 32\)"/);
  assert.match(bootstrap, /\^REGISTRATION_ID_ENCRYPTION_KEY=\.\+\$/);
  assert.match(
    bootstrap,
    /sed -i "s\|\^REGISTRATION_ID_ENCRYPTION_KEY=\.\*\|REGISTRATION_ID_ENCRYPTION_KEY=\$registration_id_encryption_key\|"/
  );
  assert.match(preflight, /REGISTRATION_ID_ENCRYPTION_KEY must be valid base64 encoding exactly 32 bytes/);
  assert.match(lockedSensitiveRead, /SENSITIVE_ENVIRONMENT_ALLOWLIST[\s\S]*"REGISTRATION_ID_ENCRYPTION_KEY"/);
});

test("upgrade preflight runs the candidate migration twice against a disposable PostgreSQL database", async () => {
  const [preflight, guide] = await Promise.all([
    fs.readFile(path.join(root, "deploy/preflight-admin-upgrade.sh"), "utf8"),
    fs.readFile(path.join(root, "docs/deployment/aliyun-test.md"), "utf8")
  ]);

  assert.match(preflight, /openssl rand -hex 16/);
  assert.match(preflight, /SELECT datname FROM pg_database/);
  assert.match(preflight, /createdb/);
  assert.match(preflight, /postgres-migration-restart-smoke\.js/);
  assert.match(preflight, /dropdb[^\r\n]*--force/);
  assert.match(preflight, /trap[^\r\n]*cleanup_smoke_database[^\r\n]*EXIT/);
  assert.ok(
    preflight.indexOf("smoke_database_created=1") < preflight.indexOf("'createdb"),
    "cleanup must be armed before attempting to create the disposable database"
  );
  assert.match(guide, /docker compose build api/);
  assert.match(guide, /临时数据库/);
  assert.match(guide, /015-registration-identities-and-organization-leaders\.sql/);
});

test("upgrade preflight validates host backups when the candidate lives outside the deploy directory", async () => {
  const preflight = await fs.readFile(
    path.join(root, "deploy/preflight-admin-upgrade.sh"),
    "utf8"
  );

  assert.match(preflight, /backup_run\(\) \{/);
  assert.match(
    preflight,
    /docker compose run --rm --no-deps -T -v "\$backups_dir:\/backups:ro" backup/
  );
  assert.match(preflight, /backup_run pg_restore --list/);
  assert.match(preflight, /backup_run \/bin\/sh \/scripts\/verify-uploads-backup\.sh/);
});

test("documented upgrade bootstraps missing secrets before every Compose operation", async () => {
  const guide = await fs.readFile(path.join(root, "docs/deployment/aliyun-test.md"), "utf8");
  const upgradeBlock = shellBlockAfter(guide, "更新应用前必须先补齐缺失密钥");
  const bootstrapIndex = upgradeBlock.indexOf("/bin/sh deploy/bootstrap-secrets.sh /opt/aerogp");
  const composeIndex = upgradeBlock.indexOf("docker compose");

  assert.notEqual(bootstrapIndex, -1);
  assert.ok(bootstrapIndex < composeIndex, "secret bootstrap must precede the first Compose command");
  assert.match(guide, /bootstrap-secrets\.sh[^。\r\n]*不会覆盖现有非空值/);
});

test("deployment passes optional Aliyun SMS configuration without generating credentials", async () => {
  const [example, compose, bootstrap, smsSource] = await Promise.all([
    fs.readFile(path.join(root, ".env.example"), "utf8"),
    fs.readFile(path.join(root, "compose.yaml"), "utf8"),
    fs.readFile(path.join(root, "deploy/bootstrap-secrets.sh"), "utf8"),
    fs.readFile(path.join(root, "apps/api/src/auth/sms.js"), "utf8")
  ]);
  const names = [
    "ALIBABA_CLOUD_ACCESS_KEY_ID",
    "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
    "ALIYUN_SMS_SIGN_NAME",
    "ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE",
    "ALIYUN_SMS_LOGIN_TEMPLATE_CODE",
    "ALIYUN_SMS_RESET_TEMPLATE_CODE",
    "ALIYUN_CAPTCHA_ENABLED",
    "ALIYUN_CAPTCHA_REGION",
    "ALIYUN_CAPTCHA_PREFIX",
    "ALIYUN_CAPTCHA_SMS_REGISTRATION_SCENE_ID",
    "ALIYUN_CAPTCHA_LOGIN_SCENE_ID",
    "ALIYUN_CAPTCHA_SMS_RESET_SCENE_ID",
    "ALIYUN_CAPTCHA_EMAIL_RESET_SCENE_ID"
  ];
  for (const name of names) {
    assert.match(example, new RegExp(`^${name}=`, "m"));
    assert.match(compose, new RegExp(`${name}:\\s*\\$\\{${name}:-`));
    assert.equal(bootstrap.includes(name), false);
  }
  assert.doesNotMatch(example, /^ALIYUN_SMS_TEMPLATE_CODE=/m);
  assert.doesNotMatch(compose, /ALIYUN_SMS_TEMPLATE_CODE:/);
  assert.match(example, /^ALIYUN_CAPTCHA_ENABLED=false$/m);
  assert.match(smsSource, /dysmsapi\.aliyuncs\.com/);
});

test("deployment configuration verifier accepts the checked-in optional SMS settings", {
  skip: process.platform !== "win32"
}, async () => {
  const result = await runConfigVerification();

  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Deployment configuration checks passed\./);
});

test("deployment configuration verifier covers the three-purpose release and smoke contract", async () => {
  const verifier = await fs.readFile(path.join(root, "deploy/verify-config.ps1"), "utf8");

  assert.match(verifier, /deploy\/verify-release\.sh/);
  assert.match(verifier, /deploy\/smoke-credentials\.sh/);
  for (const name of [
    "EXPECTED_SMS_REGISTRATION_ENABLED",
    "EXPECTED_SMS_LOGIN_ENABLED",
    "EXPECTED_SMS_PASSWORD_RESET_ENABLED"
  ]) assert.match(verifier, new RegExp(name));
  for (const endpoint of [
    "/api/auth/register/sms/request",
    "/api/auth/sms-login/request",
    "/api/auth/password-reset/sms/request"
  ]) assert.match(verifier, new RegExp(endpoint.replaceAll("/", "\\/")));
});

test("current deployment scripts reject retired targets and destructive or secret-bearing SMS patterns", async () => {
  const deployDirectory = path.join(root, "deploy");
  const scriptNames = (await fs.readdir(deployDirectory))
    .filter((name) => name.endsWith(".sh") || name.endsWith(".ps1"));
  const scripts = (await Promise.all(scriptNames.map(async (name) => ({
    name,
    source: await fs.readFile(path.join(deployDirectory, name), "utf8")
  }))));

  for (const { name, source } of scripts) {
    assert.doesNotMatch(source, /47\.99\.181\.222/, `${name} must not target the retired server IP`);
    assert.doesNotMatch(source, /\b(?:ssh|scp)\s+aerogp(?:\s|:)/, `${name} must not use the retired SSH alias`);
    assert.doesNotMatch(source, /docker\s+compose\s+down\s+-v\b/, `${name} must not delete named volumes`);
    assert.doesNotMatch(source, /LTAI[A-Za-z0-9]+|ALIBABA_CLOUD_ACCESS_KEY_(?:ID|SECRET)=[^\s"']+/,
      `${name} must not contain Alibaba Cloud credentials`);
    assert.doesNotMatch(source, /\$\{ALIYUN_SMS_TEMPLATE_CODE/,
      `${name} must not fall back to the retired shared SMS template`);
  }
});

test("deployment passes optional Aliyun DirectMail SMTP configuration", async () => {
  const [example, compose, bootstrap] = await Promise.all([
    fs.readFile(path.join(root, ".env.example"), "utf8"),
    fs.readFile(path.join(root, "compose.yaml"), "utf8"),
    fs.readFile(path.join(root, "deploy/bootstrap-secrets.sh"), "utf8")
  ]);
  const optionalNames = ["DIRECTMAIL_SMTP_USER", "DIRECTMAIL_SMTP_PASSWORD", "DIRECTMAIL_FROM"];
  for (const name of optionalNames) {
    assert.match(example, new RegExp(`^${name}=`, "m"));
    assert.match(compose, new RegExp(`${name}:\\s*\\$\\{${name}:-`));
    assert.equal(bootstrap.includes(name), false);
  }
  assert.match(compose, /PUBLIC_APP_URL:\s*https:\/\/aerogp\.cn/);
  assert.match(compose, /DIRECTMAIL_SMTP_HOST:\s*\$\{DIRECTMAIL_SMTP_HOST:-smtpdm\.aliyun\.com\}/);
  assert.match(compose, /DIRECTMAIL_SMTP_PORT:\s*\$\{DIRECTMAIL_SMTP_PORT:-465\}/);
});

test("deployment publishes the canonical public origin without treating it as a secret", async () => {
  const [compose, webDockerfile] = await Promise.all([
    fs.readFile(path.join(root, "compose.yaml"), "utf8"),
    fs.readFile(path.join(root, "Dockerfile.web"), "utf8")
  ]);

  assert.match(compose, /VITE_PUBLIC_SITE_URL:\s*https:\/\/aerogp\.cn/);
  assert.match(webDockerfile, /^ARG VITE_PUBLIC_SITE_URL$/m);
  assert.match(webDockerfile, /^ENV VITE_PUBLIC_SITE_URL=\$VITE_PUBLIC_SITE_URL$/m);
});

test("API image build receives the required release identity", async () => {
  const [apiDockerfile, compose] = await Promise.all([
    fs.readFile(path.join(root, "Dockerfile.api"), "utf8"),
    fs.readFile(path.join(root, "compose.yaml"), "utf8")
  ]);
  const requiredRelease = "${RELEASE_SHA:?RELEASE_SHA is required}";
  const apiService = compose.split("\n  api:")[1].split("\n  web:")[0];
  const apiBuild = apiService.split("\n    environment:")[0];

  assert.match(apiDockerfile, /^ARG RELEASE_SHA$/m);
  assert.match(apiDockerfile, /^ENV RELEASE_SHA=\$RELEASE_SHA$/m);
  assert.equal(apiBuild.includes(`RELEASE_SHA: ${requiredRelease}`), true);
});

test("API runtime receives the required release identity", async () => {
  const compose = await fs.readFile(path.join(root, "compose.yaml"), "utf8");
  const apiService = compose.split("\n  api:")[1].split("\n  web:")[0];
  const apiEnvironment = apiService.split("\n    environment:")[1].split("\n    volumes:")[0];

  assert.equal(apiEnvironment.includes(`RELEASE_SHA: ${"${RELEASE_SHA:?RELEASE_SHA is required}"}`), true);
});

test("API image installs production dependencies through the mainland registry", async () => {
  const apiDockerfile = await fs.readFile(path.join(root, "Dockerfile.api"), "utf8");

  assert.match(apiDockerfile, /^RUN npm ci \\\r?$/m);
  assert.match(apiDockerfile, /^  --omit=dev \\\r?$/m);
  assert.match(apiDockerfile, /^  --workspace apps\/api \\\r?$/m);
  assert.match(apiDockerfile, /^  --registry=https:\/\/registry\.npmmirror\.com \\\r?$/m);
  assert.match(apiDockerfile, /^  --replace-registry-host=always \\\r?$/m);
  assert.match(apiDockerfile, /^  --no-audit$/m);
});

test("Web image build receives the required release identity", async () => {
  const [webDockerfile, compose] = await Promise.all([
    fs.readFile(path.join(root, "Dockerfile.web"), "utf8"),
    fs.readFile(path.join(root, "compose.yaml"), "utf8")
  ]);
  const webService = compose.split("\n  web:")[1].split("\n  backup:")[0];
  const webBuild = webService.split("\n    ports:")[0];

  assert.match(webDockerfile, /^ARG RELEASE_SHA$/m);
  assert.match(webDockerfile, /^ENV VITE_RELEASE_SHA=\$RELEASE_SHA$/m);
  assert.equal(webBuild.includes(`RELEASE_SHA: ${"${RELEASE_SHA:?RELEASE_SHA is required}"}`), true);
});

test("Web image installs only frontend workspace dependencies", async () => {
  const webDockerfile = await fs.readFile(path.join(root, "Dockerfile.web"), "utf8");

  assert.match(webDockerfile, /^RUN npm ci \\\r?$/m);
  assert.match(webDockerfile, /^  --workspace apps\/web \\\r?$/m);
  assert.match(webDockerfile, /^  --workspace apps\/admin \\\r?$/m);
  assert.match(webDockerfile, /^  --include-workspace-root \\\r?$/m);
  assert.match(webDockerfile, /^  --registry=https:\/\/registry\.npmmirror\.com \\\r?$/m);
  assert.match(webDockerfile, /^  --replace-registry-host=always \\\r?$/m);
  assert.match(webDockerfile, /^  --no-audit$/m);
  assert.doesNotMatch(webDockerfile, /^RUN npm ci$/m);
});

test("deployment preflight requires cleanup and one-time administrator bootstrap tooling", async () => {
  const [preflight, guide] = await Promise.all([
    fs.readFile(path.join(root, "deploy/preflight-admin-upgrade.sh"), "utf8"),
    fs.readFile(path.join(root, "docs/deployment/aliyun-test.md"), "utf8")
  ]);

  assert.match(preflight, /test -f apps\/api\/src\/cli\/cleanup-test-business-data\.js/);
  assert.match(preflight, /test -f apps\/api\/src\/cli\/bootstrap-admin\.js/);
  assert.match(preflight, /test -f apps\/api\/src\/data\/migrations\/007-multi-event-accounts\.sql/);
  assert.equal(preflight.includes("< <("), false);
  assert.match(guide, /cleanup-test-business-data\.js\s*\n/);
  assert.match(guide, /--confirm=DELETE-TEST-BUSINESS-DATA/);
  assert.match(guide, /bootstrap-admin\.js/);
});

test("deployment verifier is host-runnable and bounds every HTTP request", async () => {
  const verifyRelease = await fs.readFile(path.join(root, "deploy/verify-release.sh"), "utf8");
  const executable = verifyRelease
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  assert.match(executable, /api\/system\/version/);
  assert.match(executable, /api\/public\/features/);
  assert.match(executable, /smsLoginEnabled/);
  assert.match(executable, /smsPasswordResetEnabled/);
  assert.match(executable, /EXPECTED_RELEASE/);
  assert.match(executable, /admin\/index\.html/);
  assert.doesNotMatch(executable, /\bnode\b/);
  assert.match(executable, /--connect-timeout\s+["']?\$?curl_connect_timeout/);
  assert.match(executable, /--max-time\s+["']?\$?curl_max_time/);
  assert.match(executable, /api\/admin\/registrations\?pageSize=100/);
  assert.match(executable, /cleanup\(\) \{[\s\S]*rm -rf "\$work_dir"/);
  for (const [signal, handler, status] of [
    ["HUP", "handle_hup", 129],
    ["INT", "handle_int", 130],
    ["TERM", "handle_term", 143]
  ]) {
    assert.match(executable, new RegExp(`trap '${handler}' ${signal}`));
    assert.match(executable, new RegExp(`${handler}\\(\\) \\{[\\s\\S]*?cleanup[\\s\\S]*?exit ${status}\\r?\\n\\}`));
  }
  assert.doesNotMatch(executable, /set -[^\r\n]*x/);
});

test("release verifier requires strict SMS expectations and compares all three feature flags", async () => {
  const harness = await createDeploymentScriptHarness({
    smsRegistrationEnabled: true,
    smsLoginEnabled: true,
    smsPasswordResetEnabled: true
  });
  const script = path.join(root, "deploy/verify-release.sh");
  const required = {
    ...harness.environment,
    BASE_URL: "http://release.test",
    EXPECTED_RELEASE: "0".repeat(40),
    EXPECTED_SMS_REGISTRATION_ENABLED: "true",
    EXPECTED_SMS_LOGIN_ENABLED: "true",
    EXPECTED_SMS_PASSWORD_RESET_ENABLED: "true"
  };
  try {
    const matching = await runShell(script, { env: required, prependPath: harness.binDirectory });
    assert.equal(matching.code, 0, matching.stderr);

    const mismatched = await runShell(script, {
      prependPath: harness.binDirectory,
      env: {
        ...required,
        EXPECTED_SMS_REGISTRATION_ENABLED: "false",
        EXPECTED_SMS_LOGIN_ENABLED: "false",
        EXPECTED_SMS_PASSWORD_RESET_ENABLED: "false"
      }
    });
    assert.notEqual(mismatched.code, 0);

    const invalid = await runShell(script, {
      prependPath: harness.binDirectory,
      env: { ...required, EXPECTED_SMS_LOGIN_ENABLED: "1" }
    });
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /EXPECTED_SMS_LOGIN_ENABLED.*true.*false/i);

    const missingEnvironment = { ...required };
    delete missingEnvironment.EXPECTED_SMS_PASSWORD_RESET_ENABLED;
    const missing = await runShell(script, { env: missingEnvironment, prependPath: harness.binDirectory });
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /EXPECTED_SMS_PASSWORD_RESET_ENABLED.*required/i);
  } finally {
    await harness.cleanup();
  }
});

test("remote authentication smoke never requests enabled SMS purposes and checks each disabled purpose", async () => {
  const cases = [
    {
      features: {
        smsRegistrationEnabled: true,
        smsLoginEnabled: true,
        smsPasswordResetEnabled: true
      },
      requested: []
    },
    {
      features: {
        smsRegistrationEnabled: false,
        smsLoginEnabled: true,
        smsPasswordResetEnabled: false
      },
      requested: [
        "/api/auth/register/sms/request",
        "/api/auth/password-reset/sms/request"
      ]
    },
    {
      features: {
        smsRegistrationEnabled: false,
        smsLoginEnabled: false,
        smsPasswordResetEnabled: false
      },
      requested: [
        "/api/auth/register/sms/request",
        "/api/auth/sms-login/request",
        "/api/auth/password-reset/sms/request"
      ]
    }
  ];
  for (const scenario of cases) {
    const harness = await createDeploymentScriptHarness(scenario.features);
    try {
      const result = await runShell(path.join(root, "deploy/remote-smoke-test.sh"), {
        prependPath: harness.binDirectory,
        env: {
          ...harness.environment,
          BASE_URL: "http://smoke.test",
          ADMIN_TEST_PASSWORD: "local-smoke-password",
          REMOTE_SMOKE_AUTH_ONLY: "true"
        }
      });
      assert.equal(result.code, 0, result.stderr);
      const requests = (await fs.readFile(harness.curlLog, "utf8"))
        .trim()
        .split(/\r?\n/)
        .filter((url) => url.includes("/sms/request") || url.includes("/sms-login/request"));
      assert.deepEqual(
        requests.map((url) => new URL(url).pathname),
        scenario.requested
      );
    } finally {
      await harness.cleanup();
    }
  }
});

test("organization smoke token helper writes a private production-format token without printing it", async () => {
  const harness = await createDeploymentScriptHarness({});
  const runner = path.join(harness.directory, "issue-token.sh");
  const tokenFile = path.join(harness.directory, "registration.token");
  const secret = "local-registration-secret-32-characters";
  await fs.writeFile(runner, `#!/bin/sh
set -eu
. "$PROJECT_ROOT/deploy/smoke-credentials.sh"
smoke_issue_phone_registration_token "$SMOKE_PHONE" "$TOKEN_FILE"
`, "utf8");
  await fs.chmod(runner, 0o755);
  try {
    const result = await runShell(runner, {
      prependPath: harness.binDirectory,
      env: {
        ...harness.environment,
        PROJECT_ROOT: shellPath(root),
        SESSION_SECRET: secret,
        SMOKE_PHONE: "13800000001",
        TOKEN_FILE: shellPath(tokenFile)
      }
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    const stat = await fs.stat(tokenFile);
    if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
    const helperSource = await fs.readFile(path.join(root, "deploy/smoke-credentials.sh"), "utf8");
    assert.match(helperSource, /chmod 600 "\$smoke_registration_token_tmp"/);
    const token = await fs.readFile(tokenFile, "utf8");
    const { verifyPhoneRegistrationToken } = await import("../src/auth/sms-registration.js");
    assert.equal(verifyPhoneRegistrationToken({
      phone: "13800000001",
      phoneVerificationToken: token,
      secret,
      now: Date.now()
    }), true);
  } finally {
    await harness.cleanup();
  }
});

test("remote organization registration submits private token files from the container helper", async () => {
  const [smoke, helper] = await Promise.all([
    fs.readFile(path.join(root, "deploy/remote-smoke-test.sh"), "utf8"),
    fs.readFile(path.join(root, "deploy/smoke-credentials.sh"), "utf8")
  ]);

  assert.equal((smoke.match(/smoke_issue_phone_registration_token/g) || []).length, 2);
  assert.equal((smoke.match(/-F "phoneVerificationToken=<\$smoke_[^"]+_token_file"/g) || []).length, 2);
  assert.match(helper, /createPhoneRegistrationToken/);
  assert.match(helper, /process\.env\.SESSION_SECRET/);
  assert.match(helper, /docker compose exec -T -e SMOKE_REGISTRATION_PHONE api/);
  assert.doesNotMatch(helper, /console\.log|SESSION_SECRET="\$/);
});

test("remote organization registration fixtures always use distinct valid mainland phones", async () => {
  const smoke = await fs.readFile(path.join(root, "deploy/remote-smoke-test.sh"), "utf8");

  assert.match(smoke, /smoke_organization_phone="138\$\([^\r\n]*%08d/);
  assert.match(smoke, /smoke_foreign_organization_phone="139\$\([^\r\n]*%08d/);
});

test("remote smoke keeps disabled SMS endpoints closed without sending messages", async () => {
  const smoke = await fs.readFile(path.join(root, "deploy/remote-smoke-test.sh"), "utf8");

  assert.match(smoke, /assert_status "public-features" 200/);
  assert.match(smoke, /check_sms_request_when_disabled/);
  assert.match(smoke, /\/api\/auth\/register\/sms\/request/);
  assert.match(smoke, /\/api\/auth\/sms-login\/request/);
  assert.match(smoke, /\/api\/auth\/password-reset\/sms\/request/);
  assert.match(smoke, /assert_status "email-reset-request" 200/);
  assert.match(smoke, /smsRegistrationEnabled/);
  assert.match(smoke, /smsLoginEnabled/);
  assert.match(smoke, /smsPasswordResetEnabled/);
});

test("recommended deployment atomically advances the marker only after both verifiers pass", async () => {
  const guide = await fs.readFile(path.join(root, "docs/deployment/aliyun-test.md"), "utf8");
  const releaseBlock = shellBlockAfter(guide, "推荐发布命令");

  assertExplicitReleaseInput(releaseBlock, "RELEASE_SHA");
  assert.match(releaseBlock, /^: "\$\{ADMIN_TEST_PASSWORD:\?[^}]+\}"$/m);
  assert.doesNotMatch(releaseBlock, /ADMIN_TEST_PASSWORD=['"]/);
  assertAtomicMarkerGate(releaseBlock, "RELEASE_SHA");
});

test("rollback atomically advances the marker only after both previous-release verifiers pass", async () => {
  const guide = await fs.readFile(path.join(root, "docs/deployment/aliyun-test.md"), "utf8");
  const rollbackBlock = shellBlockAfter(guide, "应用回滚只切换到已经验证过的 Git commit");

  assertAtomicMarkerGate(rollbackBlock, "PREVIOUS_RELEASE");
});

test("rollback validates and maps the previous release into Compose before rebuilding", async () => {
  const guide = await fs.readFile(path.join(root, "docs/deployment/aliyun-test.md"), "utf8");
  const rollbackBlock = shellBlockAfter(guide, "应用回滚只切换到已经验证过的 Git commit");

  assertExplicitReleaseInput(rollbackBlock, "PREVIOUS_RELEASE");
  assert.match(rollbackBlock, /^export RELEASE_SHA="\$PREVIOUS_RELEASE"$/m);
  assert.ok(
    rollbackBlock.indexOf('export RELEASE_SHA="$PREVIOUS_RELEASE"')
      < rollbackBlock.indexOf("docker compose"),
    "rollback must map RELEASE_SHA before invoking Compose"
  );
  assert.match(rollbackBlock, /EXPECTED_RELEASE="\$PREVIOUS_RELEASE"/);
});

test("authenticated smoke covers organization management and rejects raw HTML management errors", async () => {
  const smoke = await fs.readFile(path.join(root, "deploy/remote-smoke-test.sh"), "utf8");

  assert.match(smoke, /"\$base_url\/api\/admin\/organizations"/);
  assert.match(smoke, /"\$base_url\/api\/admin\/organizations\/__smoke_missing_organization__"/);
  assert.match(smoke, /"\$base_url\/api\/admin\/events\/__smoke_missing_event__\/registrations"/);
  assert.match(smoke, /assert_json_response "admin-organizations"/);
  assert.match(smoke, /assert_json_error "admin-event-error"/);
  assert.match(smoke, /assert_json_error "admin-organization-error"/);
  assert.match(smoke, /application\/json/);
});

test("authenticated smoke establishes approved organization leaders and supplies student identities", async () => {
  const smoke = await fs.readFile(path.join(root, "deploy/remote-smoke-test.sh"), "utf8");

  for (const label of ["organization-leader", "organization-foreign-leader"]) {
    const createIndex = smoke.indexOf(`assert_status "${label}-create" 201`);
    const approveIndex = smoke.indexOf(`assert_status "${label}-approve" 200`);
    assert.notEqual(createIndex, -1, `${label} must be created`);
    assert.ok(approveIndex > createIndex, `${label} must be approved after creation`);
  }
  assert.ok(
    smoke.indexOf('assert_status "organization-leader-approve" 200')
      < smoke.indexOf('assert_status "organization-registration-create" 201'),
    "the organization leader must be approved before organization registration"
  );
  assert.match(smoke, /add_student_id "11010519491231002X"/);
  assert.match(smoke, /add_student_id "110105194912310038"/);
  assert.match(smoke, /add_student_id "110105201401011231"/);
});
