import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "../../..");
const serverPath = path.resolve(import.meta.dirname, "../src/server.js");

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (child.exitCode !== null) throw new Error("API server exited before becoming ready");
    try {
      const response = await fetch(`${baseUrl}/api/public/event`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("API server did not start in time");
}

async function withServer(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-auth-"));
  const dbPath = path.join(tempDir, "db.json");
  const port = 6600 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DB_PATH: dbPath,
      UPLOAD_ROOT: path.join(tempDir, "uploads")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForServer(baseUrl, child);
    await fn({ baseUrl, dbPath });
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("login upgrades a legacy password and restores the user from a session", async () => {
  await withServer(async ({ baseUrl, dbPath }) => {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900000000", password: "admin123" })
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.equal("password" in loginBody.user, false);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.match(cookie, /^aerogp\.sid=/);

    const denied = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(allowed.status, 200);
    const allowedBody = await allowed.json();
    assert.equal(allowedBody.user.id, "U9001");
    assert.equal("password" in allowedBody.user, false);

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.match(persisted.users.find((user) => user.id === "U9001").password, /^\$2/);
  });
});

test("registration, password reset, and admin creation persist hashes", async () => {
  await withServer(async ({ baseUrl, dbPath }) => {
    const register = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "新用户", phone: "13700000001", password: "secret1" })
    });
    assert.equal(register.status, 201);
    assert.equal("password" in (await register.json()).user, false);

    const reset = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "新用户", phone: "13700000001", password: "secret2" })
    });
    assert.equal(reset.status, 200);
    assert.equal("password" in (await reset.json()).user, false);

    const create = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorUserId: "U9001", name: "后台用户", phone: "13700000002", password: "secret3" })
    });
    assert.equal(create.status, 201);
    const created = await create.json();
    assert.equal("password" in created.row, false);

    const adminReset = await fetch(`${baseUrl}/api/admin/users/${created.row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorUserId: "U9001", password: "secret4" })
    });
    assert.equal(adminReset.status, 200);
    assert.equal("password" in (await adminReset.json()).row, false);

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    for (const phone of ["13700000001", "13700000002"]) {
      const password = persisted.users.find((user) => user.phone === phone).password;
      assert.match(password, /^\$2/);
      assert.equal(["secret1", "secret2", "secret3"].includes(password), false);
    }

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13700000001", password: "secret2" })
    });
    assert.equal(login.status, 200);

    const adminCreatedLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13700000002", password: "secret4" })
    });
    assert.equal(adminCreatedLogin.status, 200);
  });
});

test("public registration rejects administrator and unknown account types", async () => {
  await withServer(async ({ baseUrl }) => {
    for (const type of ["admin", "unknown"]) {
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "越权用户", phone: type === "admin" ? "13700000003" : "13700000004", password: "secret5", type })
      });
      assert.equal(response.status, 422);
    }
  });
});

test("login regenerates the session identifier", async () => {
  await withServer(async ({ baseUrl }) => {
    const register = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "切换用户", phone: "13700000005", password: "secret6" })
    });
    assert.equal(register.status, 201);

    const firstLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900000000", password: "admin123" })
    });
    const firstCookie = firstLogin.headers.get("set-cookie")?.split(";")[0];
    assert.match(firstCookie, /^aerogp\.sid=/);

    const secondLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: firstCookie },
      body: JSON.stringify({ phone: "13700000005", password: "secret6" })
    });
    const secondCookie = secondLogin.headers.get("set-cookie")?.split(";")[0];
    assert.match(secondCookie, /^aerogp\.sid=/);
    assert.notEqual(secondCookie, firstCookie);

    const retired = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: firstCookie } });
    assert.equal(retired.status, 401);
  });
});

test("logout destroys the current session", async () => {
  await withServer(async ({ baseUrl }) => {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900000000", password: "admin123" })
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie }
    });
    assert.equal(logout.status, 200);

    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(me.status, 401);
  });
});
