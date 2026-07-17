import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyPassword } from "../src/auth/passwords.js";

const passwordResetModule = await import("../src/auth/password-reset.js").catch(() => ({}));
const smsModule = await import("../src/auth/sms.js").catch(() => ({}));

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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-password-reset-"));
  const dbPath = path.join(tempDir, "db.json");
  const port = 7600 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], {
    cwd: rootDir,
    env: { ...process.env, NODE_ENV: "test", PORT: String(port), DB_PATH: dbPath },
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

async function login(baseUrl, phone, password, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ phone, password })
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie")?.split(";")[0];
}

test("users list requires an administrator session and legacy public reset is removed", async () => {
  await withServer(async ({ baseUrl }) => {
    const ordinaryCookie = await login(baseUrl, "13800000001", "123456");
    const adminCookie = await login(baseUrl, "13900000000", "admin123");

    assert.equal((await fetch(`${baseUrl}/api/users`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/users`, { headers: { Cookie: ordinaryCookie } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/users`, { headers: { Cookie: adminCookie } })).status, 200);

    const bypass = await fetch(`${baseUrl}/api/admin/users/U1001`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorUserId: "U9001", password: "Bypass123" })
    });
    assert.equal(bypass.status, 422);

    const legacyReset = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "陈宇航家长", phone: "13800000001", password: "Changed123" })
    });
    assert.equal(legacyReset.status, 404);
  });
});

test("administrator reset sets a temporary password and invalidates existing sessions", async () => {
  await withServer(async ({ baseUrl, dbPath }) => {
    const ordinaryCookie = await login(baseUrl, "13800000001", "123456");
    const adminCookie = await login(baseUrl, "13900000000", "admin123");
    const url = `${baseUrl}/api/admin/users/U1001/reset-password`;
    const body = JSON.stringify({ password: "TempPass9" });

    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Cookie: ordinaryCookie }, body })).status, 403);

    const reset = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body
    });
    assert.equal(reset.status, 200);
    const resetBody = await reset.json();
    assert.equal(resetBody.user.mustChangePassword, true);
    assert.equal("password" in resetBody.user, false);

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const user = persisted.users.find((item) => item.id === "U1001");
    assert.match(user.password, /^\$2/);
    assert.equal(user.sessionVersion, 1);
    assert.equal(user.mustChangePassword, true);

    assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: ordinaryCookie } })).status, 401);
    const nextCookie = await login(baseUrl, "13800000001", "TempPass9");
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: nextCookie } });
    assert.equal((await me.json()).user.mustChangePassword, true);
  });
});

function serviceHarness({ sendCode } = {}) {
  let currentTime = Date.parse("2026-07-17T00:00:00.000Z");
  let db = {
    users: [{
      id: "U1", name: "短信用户", phone: "13800000001", password: "OldPass1", type: "ordinary",
      status: "active", sessionVersion: 3, mustChangePassword: true, createdAt: "2026-01-01T00:00:00.000Z"
    }]
  };
  const sent = [];
  const challengeStore = new Map();
  const smsProvider = { sendCode: sendCode || (async (payload) => { sent.push(payload); }) };
  const service = passwordResetModule.createSmsPasswordResetService?.({
    secret: "s".repeat(32),
    readDb: async () => structuredClone(db),
    writeDb: async (next) => { db = structuredClone(next); },
    smsProvider,
    challengeStore,
    clock: () => currentTime,
    generateCode: () => "123456"
  });
  return {
    service, sent, challengeStore,
    db: () => db,
    advance: (milliseconds) => { currentTime += milliseconds; }
  };
}

test("SMS reset request is uniform and stores only a code digest", async () => {
  assert.equal(typeof passwordResetModule.createSmsPasswordResetService, "function");
  const harness = serviceHarness();
  const known = await harness.service.request({ phone: "13800000001", ip: "127.0.0.1" });
  harness.advance(61_000);
  const unknown = await harness.service.request({ phone: "13800000002", ip: "127.0.0.1" });

  assert.deepEqual(known, unknown);
  assert.deepEqual(harness.sent, [{ phone: "13800000001", code: "123456" }]);
  const stored = harness.challengeStore.get("13800000001");
  assert.equal(stored.digest.length, 64);
  assert.equal(JSON.stringify(stored).includes("123456"), false);
  assert.equal(stored.expiresAt - Date.parse("2026-07-17T00:00:00.000Z"), 5 * 60 * 1000);
});

test("SMS provider failures keep the request response uniform and store no challenge", async () => {
  assert.equal(typeof passwordResetModule.createSmsPasswordResetService, "function");
  const harness = serviceHarness({ sendCode: async () => { throw new Error("SMS unavailable"); } });
  const response = await harness.service.request({ phone: "13800000001", ip: "127.0.0.1" });
  assert.deepEqual(response, { ok: true, message: "如果该手机号已注册，验证码将发送到该号码" });
  assert.equal(harness.challengeStore.has("13800000001"), false);
});

test("SMS reset enforces cooldown, hourly phone and IP limits", async () => {
  assert.equal(typeof passwordResetModule.createSmsPasswordResetService, "function");
  const phoneHarness = serviceHarness();
  await phoneHarness.service.request({ phone: "13800000001", ip: "10.0.0.1" });
  await assert.rejects(
    phoneHarness.service.request({ phone: "13800000001", ip: "10.0.0.1" }),
    (error) => error.statusCode === 429
  );
  for (let index = 1; index < 5; index += 1) {
    phoneHarness.advance(61_000);
    await phoneHarness.service.request({ phone: "13800000001", ip: "10.0.0.1" });
  }
  phoneHarness.advance(61_000);
  await assert.rejects(
    phoneHarness.service.request({ phone: "13800000001", ip: "10.0.0.1" }),
    (error) => error.statusCode === 429
  );

  const ipHarness = serviceHarness();
  for (let index = 0; index < 20; index += 1) {
    await ipHarness.service.request({ phone: `1390000${String(index).padStart(4, "0")}`, ip: "10.0.0.2" });
  }
  await assert.rejects(
    ipHarness.service.request({ phone: "13999999999", ip: "10.0.0.2" }),
    (error) => error.statusCode === 429
  );
});

test("SMS reset confirms once, changes the password, and increments session version", async () => {
  assert.equal(typeof passwordResetModule.createSmsPasswordResetService, "function");
  const harness = serviceHarness();
  await harness.service.request({ phone: "13800000001", ip: "127.0.0.1" });
  const result = await harness.service.confirm({ phone: "13800000001", code: "123456", password: "NextPass2" });

  assert.deepEqual(result, { ok: true });
  assert.equal(await verifyPassword("NextPass2", harness.db().users[0].password), true);
  assert.equal(harness.db().users[0].sessionVersion, 4);
  assert.equal(harness.db().users[0].mustChangePassword, false);
  assert.equal(harness.challengeStore.has("13800000001"), false);
});

test("SMS reset expires after five minutes and allows at most five checks", async () => {
  assert.equal(typeof passwordResetModule.createSmsPasswordResetService, "function");
  const expired = serviceHarness();
  await expired.service.request({ phone: "13800000001", ip: "127.0.0.1" });
  expired.advance(5 * 60 * 1000 + 1);
  await assert.rejects(expired.service.confirm({ phone: "13800000001", code: "123456", password: "NextPass2" }), (error) => error.statusCode === 422);

  const attempts = serviceHarness();
  await attempts.service.request({ phone: "13800000001", ip: "127.0.0.1" });
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(attempts.service.confirm({ phone: "13800000001", code: "000000", password: "NextPass2" }), (error) => error.statusCode === 422);
  }
  assert.equal(attempts.challengeStore.has("13800000001"), false);
});

test("Aliyun SMS provider is disabled without config and maps code to the official request", async () => {
  assert.equal(typeof smsModule.createAliyunSmsProvider, "function");
  assert.equal(smsModule.createAliyunSmsProvider({}), null);

  const requests = [];
  const client = { sendSms: async (request) => { requests.push(request); } };
  const provider = smsModule.createAliyunSmsProvider({
    ALIBABA_CLOUD_ACCESS_KEY_ID: "id",
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret",
    ALIYUN_SMS_SIGN_NAME: "航空赛事",
    ALIYUN_SMS_TEMPLATE_CODE: "SMS_123"
  }, { client });
  await provider.sendCode({ phone: "13800000001", code: "123456" });

  assert.equal(requests[0].phoneNumbers, "13800000001");
  assert.equal(requests[0].signName, "航空赛事");
  assert.equal(requests[0].templateCode, "SMS_123");
  assert.deepEqual(JSON.parse(requests[0].templateParam), { code: "123456" });
  assert.equal(provider.endpoint, "dysmsapi.aliyuncs.com");
});

test("public features reports SMS reset disabled when Aliyun is not configured", async () => {
  await withServer(async ({ baseUrl }) => {
    const features = await fetch(`${baseUrl}/api/public/features`);
    assert.equal(features.status, 200);
    assert.deepEqual(await features.json(), { smsPasswordResetEnabled: false });

    const request = await fetch(`${baseUrl}/api/auth/password-reset/sms/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800000001" })
    });
    assert.equal(request.status, 503);
  });
});
