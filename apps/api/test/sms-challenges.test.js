import assert from "node:assert/strict";
import test from "node:test";

import { createAliyunSmsProvider } from "../src/auth/sms.js";
import * as smsChallengesModule from "../src/auth/sms-challenges.js";

const PURPOSES = {
  registration: "sms-registration",
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
    ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE: "SMS_REGISTER",
    ALIYUN_SMS_LOGIN_TEMPLATE_CODE: "SMS_LOGIN",
    ALIYUN_SMS_RESET_TEMPLATE_CODE: "SMS_RESET"
  }, { client });

  await provider.sendCode({ purpose: PURPOSES.registration, phone: "13800000001", code: "000001" });
  await provider.sendCode({ purpose: PURPOSES.login, phone: "13800000001", code: "123456" });
  await provider.sendCode({ purpose: PURPOSES.passwordReset, phone: "13800000001", code: "654321" });

  assert.deepEqual(requests.map((row) => row.templateCode), [
    "SMS_REGISTER", "SMS_LOGIN", "SMS_RESET"
  ]);
});

test("Aliyun SMS exposes purpose feature gates and fails closed on partial base configuration", () => {
  const disabled = createAliyunSmsProvider({});
  assert.equal(disabled.enabled(PURPOSES.registration), false);
  assert.equal(disabled.enabled(PURPOSES.login), false);
  assert.equal(disabled.enabled(PURPOSES.passwordReset), false);

  const registrationOnly = createAliyunSmsProvider({
    ALIBABA_CLOUD_ACCESS_KEY_ID: "id",
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret",
    ALIYUN_SMS_SIGN_NAME: "航空赛事",
    ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE: "SMS_REGISTER"
  }, { client: { sendSms: async () => ({ body: { code: "OK" } }) } });
  assert.equal(registrationOnly.enabled(PURPOSES.registration), true);
  assert.equal(registrationOnly.enabled(PURPOSES.login), false);
  assert.equal(registrationOnly.enabled(PURPOSES.passwordReset), false);

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

  const missingCredentials = createAliyunSmsProvider({
    ALIYUN_SMS_LOGIN_TEMPLATE_CODE: "SMS_LOGIN"
  });
  assert.equal(missingCredentials.enabled(PURPOSES.login), false);

  const missingSecret = createAliyunSmsProvider({
    ALIBABA_CLOUD_ACCESS_KEY_ID: "id",
    ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE: "SMS_REGISTER"
  });
  assert.equal(missingSecret.enabled(PURPOSES.registration), false);

  const missingSign = createAliyunSmsProvider({
    ALIBABA_CLOUD_ACCESS_KEY_ID: "id",
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret",
    ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE: "SMS_REGISTER"
  });
  assert.equal(missingSign.enabled(PURPOSES.registration), false);
});

test("Aliyun credentials used by other products do not implicitly enable SMS", () => {
  const provider = createAliyunSmsProvider({
    ALIBABA_CLOUD_ACCESS_KEY_ID: "shared-mail-id",
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: "shared-mail-secret"
  });

  assert.equal(provider.enabled(PURPOSES.login), false);
  assert.equal(provider.enabled(PURPOSES.passwordReset), false);
});

function challengeHarness({ purpose = PURPOSES.login, readDb, sendCode, generateCode, verifyHuman = async () => true, shared = {} } = {}) {
  const time = shared.time ||= { now: Date.parse("2026-08-18T00:00:00.000Z") };
  const scheduled = [];
  const stored = shared.stored ||= new Map();
  const sent = [];
  const rates = shared.rates ||= new Map();
  const rateRequests = [];
  const keyFor = (phone) => `${purpose}:${phone}`;
  const authState = {
    async consumeRateLimits(rules, currentTime) {
      rateRequests.push(rules);
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
    resolveEligibleTarget: (db, phone) => db.users.find((user) => user.phone === phone && user.status === "active"),
    verifyHuman,
    clock: () => time.now,
    generateCode: generateCode || (() => "123456"),
    logger: { warn() {}, error() {} },
    schedule: (task) => { scheduled.push(task); }
  });
  return {
    service,
    stored,
    sent,
    scheduled,
    rateRequests,
    advance(milliseconds) { time.now += milliseconds; },
    async runNext() { await scheduled.shift()?.(); }
  };
}

test("SMS challenge returns before eligibility lookup and keeps unknown responses uniform", async () => {
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

test("registration challenge uses its own uniform response and cannot be consumed by login or reset", async () => {
  const registration = challengeHarness({ purpose: PURPOSES.registration });
  const login = challengeHarness({ purpose: PURPOSES.login, shared: { stored: registration.stored } });
  const passwordReset = challengeHarness({ purpose: PURPOSES.passwordReset, shared: { stored: registration.stored } });

  const response = await registration.service.request({ phone: "13800000001", ip: "127.0.0.1" });
  assert.deepEqual(response, { ok: true, message: "如果该手机号可用于注册，验证码将发送到该号码" });
  await registration.runNext();
  assert.equal(await login.service.consume({ phone: "13800000001", code: "123456" }), false);
  assert.equal(await passwordReset.service.consume({ phone: "13800000001", code: "123456" }), false);
  assert.equal(await registration.service.consume({ phone: "13800000001", code: "123456" }), true);
});

test("ineligible targets receive their purpose-specific uniform response without SMS dispatch", async () => {
  const messageByPurpose = {
    "sms-registration": "如果该手机号可用于注册，验证码将发送到该号码",
    "sms-login": "如果该手机号已注册，验证码将发送到该号码",
    "sms-password-reset": "如果该手机号已注册，验证码将发送到该号码"
  };
  for (const [purpose, message] of Object.entries(messageByPurpose)) {
    const challenge = challengeHarness({
      purpose,
      readDb: async () => ({ users: [{ id: "U1", phone: "13800000001", status: "disabled" }] })
    });
    assert.deepEqual(
      await challenge.service.request({ phone: "13800000001", ip: "127.0.0.1" }),
      { ok: true, message }
    );
    await challenge.runNext();
    assert.equal(challenge.sent.length, 0);
  }
});

test("all SMS purposes share the phone hourly rate limit after their cooldowns", async () => {
  const shared = {};
  const challenges = [
    challengeHarness({ purpose: PURPOSES.registration, shared }),
    challengeHarness({ purpose: PURPOSES.login, shared }),
    challengeHarness({ purpose: PURPOSES.passwordReset, shared })
  ];
  for (let index = 0; index < 5; index += 1) {
    const challenge = challenges[index % challenges.length];
    await challenge.service.request({ phone: "13800000001", ip: "127.0.0.1" });
    await challenge.runNext();
    challenge.advance(61_000);
  }
  await assert.rejects(
    challenges[2].service.request({ phone: "13800000001", ip: "127.0.0.1" }),
    (error) => error.statusCode === 429
  );
});

test("registration rejects invalid mainland phones before rate limiting or dispatch", async () => {
  const registration = challengeHarness({ purpose: PURPOSES.registration });

  await assert.rejects(
    registration.service.request({ phone: "123456", ip: "127.0.0.1" }),
    (error) => error.statusCode === 422 && error.message === "手机号格式无效"
  );
  assert.equal(registration.rateRequests.length, 0);
  assert.equal(registration.scheduled.length, 0);
  assert.equal(registration.sent.length, 0);
});

test("SMS bounds failed captcha verification by IP without consuming the phone allowance", async () => {
  let verifierCalls = 0;
  const challenge = challengeHarness({
    verifyHuman: async ({ captchaVerifyParam }) => {
      verifierCalls += 1;
      if (captchaVerifyParam !== "accepted") {
        throw Object.assign(new Error("人机验证未通过，请重试"), { statusCode: 422 });
      }
      return true;
    }
  });

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    await assert.rejects(
      challenge.service.request({ phone: "13800000001", ip: "203.0.113.10", captchaVerifyParam: `forged-${attempt}` }),
      (error) => error.statusCode === 422
    );
  }
  assert.equal(verifierCalls, 20);

  await assert.rejects(
    challenge.service.request({ phone: "13800000001", ip: "203.0.113.10", captchaVerifyParam: "forged-21" }),
    (error) => error.statusCode === 429
  );
  assert.equal(verifierCalls, 20);

  await assert.rejects(
    challenge.service.request({ phone: "13800000001", ip: "203.0.113.20", captchaVerifyParam: "forged-other-ip" }),
    (error) => error.statusCode === 422
  );
  assert.equal(verifierCalls, 21);

  assert.deepEqual(
    await challenge.service.request({ phone: "13800000001", ip: "203.0.113.20", captchaVerifyParam: "accepted" }),
    { ok: true, message: "如果该手机号已注册，验证码将发送到该号码" }
  );
  assert.equal(verifierCalls, 22);

  await assert.rejects(
    challenge.service.request({ phone: "13800000001", ip: "203.0.113.30", captchaVerifyParam: "accepted" }),
    (error) => error.statusCode === 429
  );
  assert.equal(verifierCalls, 23);
});

test("registration limits an IP address to twenty requests per hour", async () => {
  const registration = challengeHarness({ purpose: PURPOSES.registration });
  for (let number = 1; number <= 20; number += 1) {
    const phone = `138000000${String(number).padStart(2, "0")}`;
    await registration.service.request({ phone, ip: "127.0.0.1" });
  }
  await assert.rejects(
    registration.service.request({ phone: "13900000001", ip: "127.0.0.1" }),
    (error) => error.statusCode === 429
  );
});

test("registration deletes a challenge after five incorrect codes", async () => {
  const registration = challengeHarness({ purpose: PURPOSES.registration });
  await registration.service.request({ phone: "13800000001", ip: "127.0.0.1" });
  await registration.runNext();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await registration.service.consume({ phone: "13800000001", code: "000000" }), false);
  }
  assert.equal(await registration.service.consume({ phone: "13800000001", code: "123456" }), false);
});

test("registration challenge enforces cooldown, IP limit, expiry, attempts, and one-time consumption", async () => {
  const harness = challengeHarness({ purpose: PURPOSES.registration });
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
