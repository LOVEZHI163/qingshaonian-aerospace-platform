import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");

test("deployment paths use same-origin API and the /admin/ base", async () => {
  const [web, admin, adminApi, adminVite] = await Promise.all([
    fs.readFile(path.join(root, "apps/web/src/main.jsx"), "utf8"),
    fs.readFile(path.join(root, "apps/admin/src/App.vue"), "utf8"),
    fs.readFile(path.join(root, "apps/admin/src/lib/api.js"), "utf8"),
    fs.readFile(path.join(root, "apps/admin/vite.config.js"), "utf8")
  ]);

  assert.equal(web.includes("localhost:4300"), false);
  assert.equal(web.includes("localhost:5174"), false);
  assert.match(web, /VITE_API_URL\s*\|\|\s*["']{2}/);
  assert.match(web, /href=["']\/admin\/["']/);

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
