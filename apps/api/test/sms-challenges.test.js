import assert from "node:assert/strict";
import test from "node:test";

import { createAliyunSmsProvider } from "../src/auth/sms.js";
import * as smsChallengesModule from "../src/auth/sms-challenges.js";

const PURPOSES = {
  login: "sms-login",
  passwordReset: "sms-password-reset"
};

test("Aliyun SMS selects an independent template for each authentication purpose", async () => {
  const requests = [];
  const client = {
    async sendSms(request) {
      requests.push(request);
      return { body: { code: "OK" } };
    }
  };
  const provider = createAliyunSmsProvider({
    ALIBABA_CLOUD_ACCESS_KEY_ID: "id",
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret",
    ALIYUN_SMS_SIGN_NAME: "航空赛事",
    ALIYUN_SMS_LOGIN_TEMPLATE_CODE: "SMS_LOGIN",
    ALIYUN_SMS_RESET_TEMPLATE_CODE: "SMS_RESET"
  }, { client });

  await provider.sendCode({ purpose: PURPOSES.login, phone: "13800000001", code: "123456" });
  await provider.sendCode({ purpose: PURPOSES.passwordReset, phone: "13800000001", code: "654321" });

  assert.equal(requests[0].templateCode, "SMS_LOGIN");
  assert.equal(requests[1].templateCode, "SMS_RESET");
});

test("Aliyun SMS exposes purpose feature gates and fails closed on partial base configuration", () => {
  const disabled = createAliyunSmsProvider({});
  assert.equal(disabled.enabled(PURPOSES.login), false);
  assert.equal(disabled.enabled(PURPOSES.passwordReset), false);

  const loginOnly = createAliyunSmsProvider({
    ALIBABA_CLOUD_ACCESS_KEY_ID: "id",
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret",
    ALIYUN_SMS_SIGN_NAME: "航空赛事",
    ALIYUN_SMS_LOGIN_TEMPLATE_CODE: "SMS_LOGIN"
  }, { client: { sendSms: async () => ({ body: { code: "OK" } }) } });
  assert.equal(loginOnly.enabled(PURPOSES.login), true);
  assert.equal(loginOnly.enabled(PURPOSES.passwordReset), false);

  const resetOnly = createAliyunSmsProvider({
    ALIBABA_CLOUD_ACCESS_KEY_ID: "id",
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret",
    ALIYUN_SMS_SIGN_NAME: "航空赛事",
    ALIYUN_SMS_RESET_TEMPLATE_CODE: "SMS_RESET"
  }, { client: { sendSms: async () => ({ body: { code: "OK" } }) } });
  assert.equal(resetOnly.enabled(PURPOSES.login), false);
  assert.equal(resetOnly.enabled(PURPOSES.passwordReset), true);

  assert.throws(() => createAliyunSmsProvider({
    ALIYUN_SMS_LOGIN_TEMPLATE_CODE: "SMS_LOGIN"
  }), /configuration is incomplete/);
});

test("Aliyun credentials used by other products do not implicitly enable SMS", () => {
  const provider = createAliyunSmsProvider({
    ALIBABA_CLOUD_ACCESS_KEY_ID: "shared-mail-id",
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: "shared-mail-secret"
  });

  assert.equal(provider.enabled(PURPOSES.login), false);
  assert.equal(provider.enabled(PURPOSES.passwordReset), false);
});

function challengeHarness({ purpose = PURPOSES.login, readDb, sendCode, generateCode } = {}) {
  let now = Date.parse("2026-08-18T00:00:00.000Z");
  const scheduled = [];
  const stored = new Map();
  const sent = [];
  const rates = new Map();
  const keyFor = (phone) => `${purpose}:${phone}`;
  const authState = {
    async consumeRateLimits(rules, currentTime) {
      let allowed = true;
      const prepared = rules.map((rule) => {
        const events = (rates.get(rule.key) || []).filter((time) => time > currentTime - rule.windowMs);
        if (events.length >= rule.limit || (rule.cooldownMs && events.at(-1) > currentTime - rule.cooldownMs)) allowed = false;
        return { rule, events };
      });
      for (const { rule, events } of prepared) {
        if (allowed) events.push(currentTime);
        rates.set(rule.key, events);
      }
      return allowed;
    },
    async saveChallenge(challenge, { enabled = true, expectedDigest } = {}) {
      const key = keyFor(challenge.phone);
      if (expectedDigest && stored.get(key)?.digest !== expectedDigest) return false;
      if (enabled) stored.set(key, structuredClone(challenge));
      else stored.delete(key);
      return true;
    },
    async deleteChallenge({ phone, digest }) {
      const key = keyFor(phone);
      if (stored.get(key)?.digest === digest) stored.delete(key);
    },
    async consumeChallenge({ phone, digest, now: currentTime, maxAttempts }) {
      const key = keyFor(phone);
      const challenge = stored.get(key);
      if (!challenge || challenge.expiresAt <= currentTime) {
        stored.delete(key);
        return false;
      }
      if (challenge.digest !== digest) {
        challenge.attempts += 1;
        if (challenge.attempts >= maxAttempts) stored.delete(key);
        return false;
      }
      stored.delete(key);
      return true;
    }
  };
  const smsProvider = {
    enabled: (requestedPurpose) => requestedPurpose === purpose,
    sendCode: sendCode || (async (payload) => { sent.push(payload); })
  };
  const service = smsChallengesModule.createSmsChallengeService?.({
    purpose,
    secret: "s".repeat(32),
    readDb: readDb || (async () => ({ users: [{ id: "U1", phone: "13800000001", status: "active" }] })),
    smsProvider,
    authState,
    resolveEligibleUser: (db, phone) => db.users.find((user) => user.phone === phone && user.status === "active"),
    verifyHuman: async () => true,
    clock: () => now,
    generateCode: generateCode || (() => "123456"),
    logger: { warn() {}, error() {} },
    schedule: (task) => { scheduled.push(task); }
  });
  return {
    service,
    stored,
    sent,
    scheduled,
    advance(milliseconds) { now += milliseconds; },
    async runNext() { await scheduled.shift()?.(); }
  };
}

test("shared SMS challenge returns before account lookup and keeps unknown responses uniform", async () => {
  let resolveRead;
  const blockedRead = new Promise((resolve) => { resolveRead = resolve; });
  const known = challengeHarness({ readDb: () => blockedRead });
  const response = await known.service.request({ phone: "13800000001", ip: "127.0.0.1" });
  assert.deepEqual(response, { ok: true, message: "如果该手机号已注册，验证码将发送到该号码" });
  assert.equal(known.scheduled.length, 1);

  const background = known.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(known.sent.length, 0);
  resolveRead({ users: [] });
  await background;

  const unknown = challengeHarness({ readDb: async () => ({ users: [] }) });
  assert.deepEqual(await unknown.service.request({ phone: "13800000002", ip: "127.0.0.1" }), response);
  await unknown.runNext();
  assert.equal(unknown.sent.length, 0);
});

test("shared SMS challenge enforces rate limits, expiry, attempts, and one-time consumption", async () => {
  const harness = challengeHarness();
  await harness.service.request({ phone: "13800000001", ip: "10.0.0.1" });
  await harness.runNext();
  await assert.rejects(
    harness.service.request({ phone: "13800000001", ip: "10.0.0.1" }),
    (error) => error.statusCode === 429
  );
  assert.equal(await harness.service.consume({ phone: "13800000001", code: "000000" }), false);
  assert.equal(await harness.service.consume({ phone: "13800000001", code: "123456" }), true);
  assert.equal(await harness.service.consume({ phone: "13800000001", code: "123456" }), false);

  harness.advance(61_000);
  await harness.service.request({ phone: "13800000001", ip: "10.0.0.1" });
  await harness.runNext();
  harness.advance(5 * 60 * 1000);
  assert.equal(await harness.service.consume({ phone: "13800000001", code: "123456" }), false);
});

test("a failed older SMS delivery cannot delete a newer challenge", async () => {
  let rejectOld;
  let dispatchCount = 0;
  const codes = ["123456", "654321"];
  const harness = challengeHarness({
    generateCode: () => codes.shift(),
    sendCode: async () => {
      dispatchCount += 1;
      if (dispatchCount === 1) await new Promise((_, reject) => { rejectOld = reject; });
    }
  });

  await harness.service.request({ phone: "13800000001", ip: "10.0.0.1" });
  const oldDispatch = harness.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  harness.advance(61_000);
  await harness.service.request({ phone: "13800000001", ip: "10.0.0.1" });
  assert.equal(await harness.service.consume({ phone: "13800000001", code: "123456" }), false);
  await harness.runNext();
  rejectOld(new Error("old delivery failed"));
  await oldDispatch;

  assert.equal(await harness.service.consume({ phone: "13800000001", code: "654321" }), true);
});

test("an older delayed SMS task cannot overwrite or send after a newer request", async () => {
  let releaseOldRead;
  let readCount = 0;
  const oldRead = new Promise((resolve) => { releaseOldRead = resolve; });
  const harness = challengeHarness({
    readDb: async () => {
      readCount += 1;
      if (readCount === 1) return oldRead;
      return { users: [{ id: "U1", phone: "13800000001", status: "active" }] };
    },
    generateCode: () => "654321"
  });

  await harness.service.request({ phone: "13800000001", ip: "10.0.0.1" });
  const oldTask = harness.runNext();
  await new Promise((resolve) => setImmediate(resolve));

  harness.advance(61_000);
  await harness.service.request({ phone: "13800000001", ip: "10.0.0.1" });
  await harness.runNext();
  releaseOldRead({ users: [{ id: "U1", phone: "13800000001", status: "active" }] });
  await oldTask;

  assert.equal(harness.sent.length, 1);
  assert.equal(await harness.service.consume({ phone: "13800000001", code: "654321" }), true);
});
