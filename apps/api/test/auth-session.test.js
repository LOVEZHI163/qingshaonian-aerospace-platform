import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function withServer(fn) {
  await withTestServer(fn, { prefix: "aerogp-auth-" });
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
    const setCookie = login.headers.get("set-cookie") || "";
    const cookie = setCookie.split(";")[0];
    assert.match(cookie, /^aerogp\.sid=/);
    assert.match(setCookie, /; HttpOnly(?:;|$)/);
    assert.match(setCookie, /; SameSite=Lax(?:;|$)/);
    const expires = /; Expires=([^;]+)/.exec(setCookie)?.[1];
    assert.ok(expires, "session cookie must expose its eight-hour max age");
    assert.ok(Math.abs(new Date(expires).getTime() - Date.now() - 8 * 60 * 60 * 1000) < 60_000);

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

test("registration and admin creation persist hashes", async () => {
  await withServer(async ({ baseUrl, dbPath, phoneVerificationToken }) => {
    const register = await fetch(`${baseUrl}/api/auth/register/ordinary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "新用户", phone: "13700000001", password: "Secret123",
        phoneVerificationToken: phoneVerificationToken("13700000001")
      })
    });
    assert.equal(register.status, 201);
    assert.equal("password" in (await register.json()).user, false);

    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const create = await fetch(`${baseUrl}/api/admin/users`, withSession(admin.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "后台用户", phone: "13700000002", password: "Secret345" })
    }));
    assert.equal(create.status, 201);
    const created = await create.json();
    assert.equal("password" in created.row, false);

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    for (const phone of ["13700000001", "13700000002"]) {
      const password = persisted.users.find((user) => user.phone === phone).password;
      assert.match(password, /^\$2/);
      assert.equal(["Secret123", "Secret234", "Secret345"].includes(password), false);
    }

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13700000001", password: "Secret123" })
    });
    assert.equal(login.status, 200);

  });
});

test("public ordinary registration never honors requested elevated or unknown account types", async () => {
  await withServer(async ({ baseUrl, phoneVerificationToken }) => {
    for (const type of ["admin", "unknown"]) {
      const phone = type === "admin" ? "13700000003" : "13700000004";
      const response = await fetch(`${baseUrl}/api/auth/register/ordinary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "越权用户", phone, password: "Strong123", type,
          phoneVerificationToken: phoneVerificationToken(phone)
        })
      });
      assert.equal(response.status, 201);
      assert.equal((await response.json()).user.type, "ordinary");
    }
  });
});

test("login regenerates the session identifier", async () => {
  await withServer(async ({ baseUrl, phoneVerificationToken }) => {
    const register = await fetch(`${baseUrl}/api/auth/register/ordinary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "切换用户", phone: "13700000005", password: "Secret678",
        phoneVerificationToken: phoneVerificationToken("13700000005")
      })
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
      body: JSON.stringify({ phone: "13700000005", password: "Secret678" })
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
    assert.match(logout.headers.get("set-cookie") || "", /^aerogp\.sid=;/);

    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(me.status, 401);
  });
});

test("logout is idempotent without an existing session", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test("proxy HTTPS marks the session cookie Secure while HTTP does not", async () => {
  await withServer(async ({ baseUrl }) => {
    const secureLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ phone: "13900000000", password: "admin123" })
    });
    assert.match(secureLogin.headers.get("set-cookie") || "", /; Secure(?:;|$)/);

    const plainLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800000001", password: "123456" })
    });
    assert.doesNotMatch(plainLogin.headers.get("set-cookie") || "", /; Secure(?:;|$)/);
  });
});

test("login failures are limited by phone and IP", async () => {
  await withServer(async ({ baseUrl }) => {
    for (let index = 0; index < 5; index += 1) {
      const failure = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "13900000000", password: "wrong" })
      });
      assert.equal(failure.status, 401);
    }
    const limited = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900000000", password: "admin123" })
    });
    assert.equal(limited.status, 429);
  });

  await withServer(async ({ baseUrl }) => {
    for (let index = 0; index < 20; index += 1) {
      const failure = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: `137${String(index).padStart(8, "0")}`, password: "wrong" })
      });
      assert.equal(failure.status, 401);
    }
    const limited = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800000001", password: "123456" })
    });
    assert.equal(limited.status, 429);
  });
});
