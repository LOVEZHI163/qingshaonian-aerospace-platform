import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { verifyPassword } from "../src/auth/passwords.js";
import { withTestServer } from "../test-support/server.js";
import { withSession } from "./helpers/api-client.js";

const passwordResetModule = await import("../src/auth/password-reset.js").catch(() => ({}));
const smsModule = await import("../src/auth/sms.js").catch(() => ({}));
const smsChallengesModule = await import("../src/auth/sms-challenges.js").catch(() => ({}));

async function withServer(fn) {
  await withTestServer(fn, { prefix: "aerogp-password-reset-" });
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

    const bypass = await fetch(`${baseUrl}/api/admin/users/U1001`, withSession(adminCookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "Bypass123" })
    }));
    assert.equal(bypass.status, 422);

    const legacyReset = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "陈宇航家长", phone: "13800000001", password: "Changed123" })
    });
    assert.equal(legacyReset.status, 404);
  });
});

test("administrator reset generates a repeat-viewable temporary password that is cleared after change", async () => {
  await withServer(async ({ baseUrl, dbPath }) => {
    const ordinaryCookie = await login(baseUrl, "13800000001", "123456");
    const adminCookie = await login(baseUrl, "13900000000", "admin123");
    const url = `${baseUrl}/api/admin/users/U1001/reset-password`;
    const body = JSON.stringify({ password: "CallerMustNotChoose9" });

    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Cookie: ordinaryCookie }, body })).status, 403);

    const reset = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body
    });
    assert.equal(reset.status, 200);
    const resetBody = await reset.json();
    assert.match(resetBody.temporaryPassword, /[A-Za-z]/);
    assert.notEqual(resetBody.temporaryPassword, "CallerMustNotChoose9");
    assert.equal(resetBody.user.mustChangePassword, true);
    assert.equal("password" in resetBody.user, false);
    assert.equal("temporaryPasswordCiphertext" in resetBody.user, false);

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const user = persisted.users.find((item) => item.id === "U1001");
    assert.match(user.password, /^\$2/);
    assert.equal(user.sessionVersion, 1);
    assert.equal(user.mustChangePassword, true);
    assert.ok(user.temporaryPasswordCiphertext);
    assert.notEqual(user.temporaryPasswordCiphertext, resetBody.temporaryPassword);
    assert.doesNotMatch(JSON.stringify(persisted.auditLogs), new RegExp(resetBody.temporaryPassword));
    assert.doesNotMatch(JSON.stringify(persisted.auditLogs), /temporaryPasswordCiphertext|\$2[aby]\$/);

    assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: ordinaryCookie } })).status, 401);
    const oldLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800000001", password: "123456" })
    });
    assert.equal(oldLogin.status, 401);

    const nextCookie = await login(baseUrl, "13800000001", resetBody.temporaryPassword);
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: nextCookie } });
    assert.equal((await me.json()).user.mustChangePassword, true);

    const repeated = await fetch(`${baseUrl}/api/admin/users/U1001/temporary-password`, { headers: { Cookie: adminCookie } });
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), { temporaryPassword: resetBody.temporaryPassword });

    const changed = await fetch(`${baseUrl}/api/auth/change-password`, withSession(nextCookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: resetBody.temporaryPassword, newPassword: "NextPass2" })
    }));
    assert.equal(changed.status, 200);
    const cleared = await fetch(`${baseUrl}/api/admin/users/U1001/temporary-password`, { headers: { Cookie: adminCookie } });
    assert.equal(cleared.status, 404);
    const afterChange = JSON.parse(await fs.readFile(dbPath, "utf8")).users.find((item) => item.id === "U1001");
    assert.equal(afterChange.temporaryPasswordCiphertext, null);
    assert.equal(afterChange.temporaryPasswordIv, null);
    assert.equal(afterChange.temporaryPasswordTag, null);
    assert.equal(afterChange.temporaryPasswordCreatedAt, null);
  });
});

test("temporary password endpoints fail closed when the encryption key is unavailable", async () => {
  for (const key of ["", "not-valid-base64", Buffer.alloc(16).toString("base64")]) {
    await withTestServer(async ({ baseUrl }) => {
      const adminCookie = await login(baseUrl, "13900000000", "admin123");
      const reset = await fetch(`${baseUrl}/api/admin/users/U1001/reset-password`, withSession(adminCookie, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      }));
      assert.equal(reset.status, 503);
      assert.equal((await reset.json()).code, "TEMP_PASSWORD_KEY_UNAVAILABLE");

      const read = await fetch(`${baseUrl}/api/admin/users/U1001/temporary-password`, withSession(adminCookie));
      assert.equal(read.status, 503);
      assert.equal((await read.json()).code, "TEMP_PASSWORD_KEY_UNAVAILABLE");
    }, { prefix: "aerogp-password-key-unavailable-", env: { TEMP_PASSWORD_ENCRYPTION_KEY: key } });
  }
});

function serviceHarness({ sendCode, logger, database } = {}) {
  let currentTime = Date.parse("2026-07-17T00:00:00.000Z");
  let db = structuredClone(database || {
    users: [{
      id: "U1", name: "短信用户", phone: "13800000001", password: "OldPass1", type: "ordinary",
      status: "active", sessionVersion: 3, mustChangePassword: true,
      temporaryPasswordCiphertext: "sealed", temporaryPasswordIv: "iv", temporaryPasswordTag: "tag",
      temporaryPasswordCreatedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z"
    }]
  });
  const sent = [];
  const challengeStore = new Map();
  let challengePreparations = 0;
  const rateBuckets = new Map();
  const authState = {
    async consumeRateLimits(rules, now) {
      let allowed = true;
      const prepared = rules.map((rule) => {
        const events = (rateBuckets.get(rule.key) || []).filter((time) => time > now - rule.windowMs);
        if (events.length >= rule.limit || (rule.cooldownMs && events.at(-1) > now - rule.cooldownMs)) allowed = false;
        return { rule, events };
      });
      for (const { rule, events } of prepared) {
        if (allowed) events.push(now);
        rateBuckets.set(rule.key, events);
      }
      return allowed;
    },
    async saveChallenge(challenge, { enabled = true, expectedDigest } = {}) {
      challengePreparations += 1;
      const key = `${challenge.purpose}:${challenge.phone}`;
      if (expectedDigest && challengeStore.get(key)?.digest !== expectedDigest) return false;
      if (enabled) challengeStore.set(key, structuredClone(challenge));
      else challengeStore.delete(key);
      return true;
    },
    async deleteChallenge({ purpose, phone, digest }) {
      const key = `${purpose}:${phone}`;
      if (!digest || challengeStore.get(key)?.digest === digest) challengeStore.delete(key);
    },
    async consumeChallenge({ purpose, phone, digest, now, maxAttempts }) {
      const key = `${purpose}:${phone}`;
      const challenge = challengeStore.get(key);
      if (!challenge || challenge.expiresAt <= now) {
        challengeStore.delete(key);
        return false;
      }
      if (challenge.digest !== digest) {
        challenge.attempts += 1;
        if (challenge.attempts >= maxAttempts) challengeStore.delete(key);
        return false;
      }
      challengeStore.delete(key);
      return true;
    }
  };
  const smsProvider = { sendCode: sendCode || (async (payload) => { sent.push(payload); }) };
  smsProvider.enabled = (purpose) => purpose === "sms-password-reset";
  const challengeService = smsChallengesModule.createSmsChallengeService({
    purpose: smsChallengesModule.SMS_PURPOSES.passwordReset,
    secret: "s".repeat(32),
    readDb: async () => structuredClone(db),
    smsProvider,
    authState,
    resolveEligibleTarget: (database, phone) => database.users.find((user) => user.phone === phone && user.status === "active"),
    clock: () => currentTime,
    generateCode: () => "123456",
    logger: logger || { warn() {}, error() {} }
  });
  const service = passwordResetModule.createSmsPasswordResetService?.({
    challengeService,
    readDb: async () => structuredClone(db),
    writeDb: async (next) => { db = structuredClone(next); },
    clearTemporaryPassword: (user) => {
      user.temporaryPasswordCiphertext = null;
      user.temporaryPasswordIv = null;
      user.temporaryPasswordTag = null;
      user.temporaryPasswordCreatedAt = null;
    }
  });
  return {
    service, sent, challengeStore,
    db: () => db,
    challengePreparations: () => challengePreparations,
    advance: (milliseconds) => { currentTime += milliseconds; }
  };
}

test("SMS reset request is uniform and stores only a code digest", async () => {
  assert.equal(typeof passwordResetModule.createSmsPasswordResetService, "function");
  const harness = serviceHarness();
  const known = await harness.service.request({ phone: "13800000001", ip: "127.0.0.1" });
  harness.advance(61_000);
  const unknown = await harness.service.request({ phone: "13800000002", ip: "127.0.0.1" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(known, unknown);
  assert.equal(harness.challengePreparations(), 3);
  assert.deepEqual(harness.sent, [{ purpose: "sms-password-reset", phone: "13800000001", code: "123456" }]);
  const stored = harness.challengeStore.get("sms-password-reset:13800000001");
  assert.equal(stored.digest.length, 64);
  assert.equal(JSON.stringify(stored).includes("123456"), false);
  assert.equal(stored.expiresAt - Date.parse("2026-07-17T00:00:00.000Z"), 5 * 60 * 1000);
});

test("SMS provider failures keep the request response uniform and store no challenge", async () => {
  assert.equal(typeof passwordResetModule.createSmsPasswordResetService, "function");
  const harness = serviceHarness({ sendCode: async () => { throw new Error("SMS unavailable"); } });
  const response = await harness.service.request({ phone: "13800000001", ip: "127.0.0.1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(response, { ok: true, message: "如果该手机号已注册，验证码将发送到该号码" });
  assert.equal(harness.challengeStore.has("sms-password-reset:13800000001"), false);
});

test("SMS dispatch failures remain handled even when the logger throws", async () => {
  const unhandled = [];
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const harness = serviceHarness({
      sendCode: async () => { throw new Error("SMS unavailable"); },
      logger: { warn() { throw new Error("logger unavailable"); }, error() { throw new Error("logger unavailable"); } }
    });
    await harness.service.request({ phone: "13800000001", ip: "127.0.0.1" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.challengeStore.has("sms-password-reset:13800000001"), false);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("SMS reset response does not synchronously wait for the provider", async () => {
  let dispatched = false;
  const harness = serviceHarness({ sendCode: () => {
    dispatched = true;
    return new Promise(() => {});
  } });
  const response = await Promise.race([
    harness.service.request({ phone: "13800000001", ip: "127.0.0.1" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("request waited for SMS")), 100))
  ]);
  assert.equal(dispatched, false);
  assert.equal(response.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatched, true);
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
  await new Promise((resolve) => setImmediate(resolve));
  const result = await harness.service.confirm({ phone: "13800000001", code: "123456", password: "NextPass2" });

  assert.deepEqual(result, { ok: true });
  assert.equal(await verifyPassword("NextPass2", harness.db().users[0].password), true);
  assert.equal(harness.db().users[0].sessionVersion, 4);
  assert.equal(harness.db().users[0].mustChangePassword, false);
  assert.equal(harness.db().users[0].temporaryPasswordCiphertext, null);
  assert.equal(harness.db().users[0].temporaryPasswordIv, null);
  assert.equal(harness.db().users[0].temporaryPasswordTag, null);
  assert.equal(harness.db().users[0].temporaryPasswordCreatedAt, null);
  assert.equal(harness.challengeStore.has("sms-password-reset:13800000001"), false);
});

test("active ordinary, organization, and administrator accounts retain SMS reset and session invalidation semantics", async () => {
  const database = {
    users: [
      { id: "U1", phone: "13800000001", type: "ordinary", status: "active", password: "OldPass1", sessionVersion: 1, mustChangePassword: true, temporaryPasswordCiphertext: "sealed", temporaryPasswordIv: "iv", temporaryPasswordTag: "tag", temporaryPasswordCreatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "U2", phone: "13800000002", type: "admin", status: "active", password: "OldPass1", sessionVersion: 4, mustChangePassword: true, temporaryPasswordCiphertext: "sealed", temporaryPasswordIv: "iv", temporaryPasswordTag: "tag", temporaryPasswordCreatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "U3", phone: "13800000003", type: "organization", status: "active", password: "OldPass1", sessionVersion: 2, mustChangePassword: true, temporaryPasswordCiphertext: "sealed", temporaryPasswordIv: "iv", temporaryPasswordTag: "tag", temporaryPasswordCreatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "U4", phone: "13800000004", type: "organization", status: "active", password: "OldPass1", sessionVersion: 3, mustChangePassword: true, temporaryPasswordCiphertext: "sealed", temporaryPasswordIv: "iv", temporaryPasswordTag: "tag", temporaryPasswordCreatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "U5", phone: "13800000005", type: "organization", status: "active", password: "OldPass1", sessionVersion: 5, mustChangePassword: true, temporaryPasswordCiphertext: "sealed", temporaryPasswordIv: "iv", temporaryPasswordTag: "tag", temporaryPasswordCreatedAt: "2026-01-01T00:00:00.000Z" }
    ],
    organizations: [
      { id: "O3", ownerUserId: "U3", reviewStatus: "approved", status: "active" },
      { id: "O4", ownerUserId: "U4", reviewStatus: "pending", status: "active" },
      { id: "O5", ownerUserId: "U5", reviewStatus: "rejected", status: "active" }
    ]
  };
  const initialVersions = new Map(database.users.map((user) => [user.phone, user.sessionVersion]));
  const harness = serviceHarness({ database });

  for (const phone of initialVersions.keys()) {
    await harness.service.request({ phone, ip: "127.0.0.1" });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.service.confirm({ phone, code: "123456", password: "NextPass2" });
    const user = harness.db().users.find((row) => row.phone === phone);
    assert.equal(user.sessionVersion, initialVersions.get(phone) + 1, phone);
    assert.equal(user.mustChangePassword, false, phone);
    assert.equal(user.temporaryPasswordCiphertext, null, phone);
    assert.equal(user.temporaryPasswordIv, null, phone);
    assert.equal(user.temporaryPasswordTag, null, phone);
    assert.equal(user.temporaryPasswordCreatedAt, null, phone);
    assert.equal(await verifyPassword("NextPass2", user.password), true, phone);
  }
});

test("SMS reset expires after five minutes and allows at most five checks", async () => {
  assert.equal(typeof passwordResetModule.createSmsPasswordResetService, "function");
  const expired = serviceHarness();
  await expired.service.request({ phone: "13800000001", ip: "127.0.0.1" });
  await new Promise((resolve) => setImmediate(resolve));
  expired.advance(5 * 60 * 1000);
  await assert.rejects(expired.service.confirm({ phone: "13800000001", code: "123456", password: "NextPass2" }), (error) => error.statusCode === 422);

  const attempts = serviceHarness();
  await attempts.service.request({ phone: "13800000001", ip: "127.0.0.1" });
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(attempts.service.confirm({ phone: "13800000001", code: "000000", password: "NextPass2" }), (error) => error.statusCode === 422);
  }
  assert.equal(attempts.challengeStore.has("sms-password-reset:13800000001"), false);
});

test("Aliyun SMS provider is disabled without config and maps code to the official request", async () => {
  assert.equal(typeof smsModule.createAliyunSmsProvider, "function");
  assert.equal(smsModule.createAliyunSmsProvider({}).enabled("sms-password-reset"), false);

  const requests = [];
  const client = { sendSms: async (request) => { requests.push(request); return { body: { code: "OK" } }; } };
  const provider = smsModule.createAliyunSmsProvider({
    ALIBABA_CLOUD_ACCESS_KEY_ID: "id",
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret",
    ALIYUN_SMS_SIGN_NAME: "航空赛事",
    ALIYUN_SMS_RESET_TEMPLATE_CODE: "SMS_123"
  }, { client });
  await provider.sendCode({ purpose: "sms-password-reset", phone: "13800000001", code: "123456" });

  assert.equal(requests[0].phoneNumbers, "13800000001");
  assert.equal(requests[0].signName, "航空赛事");
  assert.equal(requests[0].templateCode, "SMS_123");
  assert.deepEqual(JSON.parse(requests[0].templateParam), { code: "123456" });
  assert.equal(provider.endpoint, "dysmsapi.aliyuncs.com");

  const rejected = smsModule.createAliyunSmsProvider({
    ALIBABA_CLOUD_ACCESS_KEY_ID: "id",
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret",
    ALIYUN_SMS_SIGN_NAME: "test",
    ALIYUN_SMS_RESET_TEMPLATE_CODE: "SMS_123"
  }, { client: { sendSms: async () => ({ body: {} }) } });
  await assert.rejects(rejected.sendCode({ purpose: "sms-password-reset", phone: "13800000001", code: "123456" }), /delivery failed/);
});

test("public features reports SMS reset disabled when Aliyun is not configured", async () => {
  await withServer(async ({ baseUrl }) => {
    const features = await fetch(`${baseUrl}/api/public/features`);
    assert.equal(features.status, 200);
    assert.deepEqual(await features.json(), {
      smsRegistrationEnabled: false,
      smsLoginEnabled: false,
      smsPasswordResetEnabled: false,
      emailPasswordResetEnabled: false,
      captcha: {
        enabled: false,
        region: "cn",
        prefix: "",
        scenes: { smsRegistration: "", smsLogin: "", smsPasswordReset: "", emailPasswordReset: "" }
      }
    });

    const request = await fetch(`${baseUrl}/api/auth/password-reset/sms/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800000001" })
    });
    assert.equal(request.status, 503);
  });
});
