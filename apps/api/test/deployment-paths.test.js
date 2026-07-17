import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");

test("deployment paths use same-origin API and the /admin/ base", async () => {
  const [web, admin, adminVite] = await Promise.all([
    fs.readFile(path.join(root, "apps/web/src/main.jsx"), "utf8"),
    fs.readFile(path.join(root, "apps/admin/src/App.vue"), "utf8"),
    fs.readFile(path.join(root, "apps/admin/vite.config.js"), "utf8")
  ]);

  assert.equal(web.includes("localhost:4300"), false);
  assert.equal(web.includes("localhost:5174"), false);
  assert.match(web, /VITE_API_URL\s*\|\|\s*["']{2}/);
  assert.match(web, /href=["']\/admin\/["']/);

  assert.equal(admin.includes("localhost:4300"), false);
  assert.match(admin, /VITE_API_URL\s*\|\|\s*["']{2}/);
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
