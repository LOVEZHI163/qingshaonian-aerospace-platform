import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");

function runConfigVerification() {
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

test("deployment configuration verifier accepts the checked-in optional SMS settings", async () => {
  const result = await runConfigVerification();

  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Deployment configuration checks passed\./);
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

test("remote smoke keeps disabled SMS endpoints closed without sending messages", async () => {
  const smoke = await fs.readFile(path.join(root, "deploy/remote-smoke-test.sh"), "utf8");

  assert.match(smoke, /assert_status "public-features" 200/);
  assert.match(smoke, /assert_status "sms-login-disabled" 503/);
  assert.match(smoke, /assert_status "sms-reset-disabled" 503/);
  assert.match(smoke, /assert_status "email-reset-request" 200/);
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
