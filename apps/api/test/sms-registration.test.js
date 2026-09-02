import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  SmsRegistrationError,
  createPhoneRegistrationToken,
  createSmsRegistrationService,
  verifyPhoneRegistrationToken
} from "../src/auth/sms-registration.js";

const NOW = Date.parse("2026-08-30T00:00:00.000Z");
const SECRET = "s".repeat(32);
const EXPIRED_MESSAGE = "手机号验证已过期，请重新验证";

function assertExpired(error) {
  return error instanceof SmsRegistrationError
    && error.statusCode === 422
    && error.message === EXPIRED_MESSAGE;
}

function assertDisabled(error) {
  return error instanceof SmsRegistrationError
    && error.statusCode === 503
    && error.message === "短信验证暂未启用";
}

function signPayload(payload, secret = SECRET) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const key = createHmac("sha256", secret)
    .update("sms-registration-ticket:v1")
    .digest();
  const signature = createHmac("sha256", key)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

test("phone registration tokens normalize the phone and remain valid until the 15-minute boundary", () => {
  const issued = createPhoneRegistrationToken({
    phone: "138 0000 0001",
    secret: SECRET,
    now: NOW,
    nonce: "fixed-nonce"
  });

  assert.equal(issued.expiresAt, "2026-08-30T00:15:00.000Z");
  assert.equal(verifyPhoneRegistrationToken({
    phone: "13800000001",
    phoneVerificationToken: issued.phoneVerificationToken,
    secret: SECRET,
    now: NOW + 14 * 60 * 1000
  }), true);
  assert.throws(() => verifyPhoneRegistrationToken({
    phone: "13800000001",
    phoneVerificationToken: issued.phoneVerificationToken,
    secret: SECRET,
    now: NOW + 15 * 60 * 1000
  }), assertExpired);
});

test("phone registration token verification rejects identity, signature, and secret mismatches uniformly", () => {
  const { phoneVerificationToken } = createPhoneRegistrationToken({
    phone: "13800000001",
    secret: SECRET,
    now: NOW,
    nonce: "fixed-nonce"
  });
  const tampered = `${phoneVerificationToken.slice(0, -1)}${phoneVerificationToken.endsWith("A") ? "B" : "A"}`;

  for (const input of [
    { phone: "13800000002", phoneVerificationToken, secret: SECRET },
    { phone: "13800000001", phoneVerificationToken: tampered, secret: SECRET },
    { phone: "13800000001", phoneVerificationToken, secret: "x".repeat(32) }
  ]) {
    assert.throws(() => verifyPhoneRegistrationToken({ ...input, now: NOW }), assertExpired);
  }
});

test("phone registration token verification rejects malformed and wrong-domain payloads uniformly", () => {
  const validPayload = {
    v: 1,
    purpose: "sms-registration",
    phone: "13800000001",
    iat: NOW,
    exp: NOW + 15 * 60 * 1000,
    nonce: "fixed-nonce"
  };
  const invalidTokens = [
    "",
    "one-segment",
    "one.two.three",
    "not-json.AA",
    signPayload({ ...validPayload, v: 2 }),
    signPayload({ ...validPayload, purpose: "sms-login" }),
    signPayload({ ...validPayload, phone: "13800000002" }),
    signPayload({ ...validPayload, exp: validPayload.exp + 1 }),
    signPayload({ ...validPayload, iat: "not-a-time" }),
    signPayload({ ...validPayload, nonce: "" })
  ];

  for (const phoneVerificationToken of invalidTokens) {
    assert.throws(() => verifyPhoneRegistrationToken({
      phone: "13800000001",
      phoneVerificationToken,
      secret: SECRET,
      now: NOW
    }), assertExpired);
  }
});

test("an unexpired phone registration token is retryable after unrelated form validation fails", () => {
  const issued = createPhoneRegistrationToken({
    phone: "13800000001",
    secret: SECRET,
    now: NOW,
    nonce: "fixed-nonce"
  });

  assert.equal(verifyPhoneRegistrationToken({
    phone: "13800000001",
    phoneVerificationToken: issued.phoneVerificationToken,
    secret: SECRET,
    now: NOW + 1_000
  }), true);
  assert.equal(verifyPhoneRegistrationToken({
    phone: "13800000001",
    phoneVerificationToken: issued.phoneVerificationToken,
    secret: SECRET,
    now: NOW + 2_000
  }), true);
});

function registrationHarness({ valid = true, users = [] } = {}) {
  let currentUsers = structuredClone(users);
  const consumed = [];
  let databaseReads = 0;
  const challengeService = {
    enabled: true,
    async request(input) { return { ok: true, input }; },
    async consume(input) {
      consumed.push(input);
      return valid;
    }
  };
  const service = createSmsRegistrationService({
    challengeService,
    readDb: async () => {
      databaseReads += 1;
      return { users: structuredClone(currentUsers) };
    },
    secret: SECRET,
    clock: () => NOW,
    randomNonce: () => "fixed-nonce"
  });
  return {
    service,
    consumed,
    databaseReads: () => databaseReads,
    setUsers(next) { currentUsers = structuredClone(next); }
  };
}

test("SMS registration delegates requests and returns a verifiable token after a valid code", async () => {
  const harness = registrationHarness();
  const requestInput = { phone: "138 0000 0001", ip: "127.0.0.1", captchaVerifyParam: "captcha" };

  assert.equal(harness.service.enabled, true);
  assert.deepEqual(await harness.service.request(requestInput), { ok: true, input: requestInput });
  const issued = await harness.service.confirm({ phone: "138 0000 0001", code: "123456" });
  assert.deepEqual(harness.consumed, [{ phone: "13800000001", code: "123456" }]);
  assert.equal(harness.databaseReads(), 1);
  assert.equal(harness.service.verify({
    phone: "13800000001",
    phoneVerificationToken: issued.phoneVerificationToken
  }), true);
  assert.equal(issued.expiresAt, "2026-08-30T00:15:00.000Z");
});

test("SMS registration rejects an invalid code without reading account state", async () => {
  const harness = registrationHarness({ valid: false });

  await assert.rejects(
    harness.service.confirm({ phone: "13800000001", code: "000000" }),
    (error) => error instanceof SmsRegistrationError
      && error.statusCode === 422
      && error.message === "验证码无效或已过期"
  );
  assert.equal(harness.databaseReads(), 0);
});

test("SMS registration rechecks account state after consuming the code", async () => {
  const harness = registrationHarness();
  harness.setUsers([{ id: "U1", phone: "138 0000 0001" }]);

  await assert.rejects(
    harness.service.confirm({ phone: "13800000001", code: "123456" }),
    (error) => error instanceof SmsRegistrationError
      && error.statusCode === 422
      && error.message === "验证码无效或已过期"
  );
  assert.equal(harness.databaseReads(), 1);
});

test("disabling SMS registration blocks requests, old challenges, and previously issued tokens", async () => {
  const enabled = registrationHarness();
  const historicalToken = await enabled.service.confirm({ phone: "13800000001", code: "123456" });
  let requests = 0;
  let consumes = 0;
  let databaseReads = 0;
  const disabled = createSmsRegistrationService({
    challengeService: {
      enabled: false,
      async request() { requests += 1; return { ok: true }; },
      async consume() { consumes += 1; return true; }
    },
    readDb: async () => { databaseReads += 1; return { users: [] }; },
    secret: SECRET,
    clock: () => NOW,
    randomNonce: () => "disabled-nonce"
  });

  const [requestResult, confirmResult] = await Promise.allSettled([
    Promise.resolve().then(() => disabled.request({ phone: "13800000001", ip: "127.0.0.1" })),
    disabled.confirm({ phone: "13800000001", code: "123456" })
  ]);
  assert.equal(requestResult.status, "rejected");
  assert.equal(assertDisabled(requestResult.reason), true);
  assert.equal(confirmResult.status, "rejected");
  assert.equal(assertDisabled(confirmResult.reason), true);
  assert.throws(() => disabled.verify({
    phone: "13800000001",
    phoneVerificationToken: historicalToken.phoneVerificationToken
  }), assertDisabled);
  assert.equal(requests, 0);
  assert.equal(consumes, 0);
  assert.equal(databaseReads, 0);
});
