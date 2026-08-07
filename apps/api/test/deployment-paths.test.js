import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");

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

  assert.match(preflight, /aerogp_migration_smoke_/);
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
    "ALIYUN_SMS_TEMPLATE_CODE"
  ];
  for (const name of names) {
    assert.match(example, new RegExp(`^${name}=$`, "m"));
    assert.equal(compose.includes(`${name}: ` + "${" + `${name}:-}`), true);
    assert.equal(bootstrap.includes(name), false);
  }
  assert.match(smsSource, /dysmsapi\.aliyuncs\.com/);
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
