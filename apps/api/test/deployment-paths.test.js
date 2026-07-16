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
