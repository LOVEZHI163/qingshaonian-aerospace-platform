import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");

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
