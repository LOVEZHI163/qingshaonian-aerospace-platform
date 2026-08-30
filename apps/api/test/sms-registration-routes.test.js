import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { withTestServer } from "../test-support/server.js";

const smsRegistrationRoutesModule = await import("../src/routes/sms-registration.js").catch(() => ({}));

async function withRouter(smsRegistration, run) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api", smsRegistrationRoutesModule.createSmsRegistrationRouter({ smsRegistration }));
  app.use((_error, _req, res, _next) => res.status(500).json({ error: "服务器内部错误" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

test("registration SMS routes expose a uniform request response and only the signed confirmation fields", async () => {
  assert.equal(typeof smsRegistrationRoutesModule.createSmsRegistrationRouter, "function");
  const calls = [];
  const smsRegistration = {
    enabled: true,
    async request(input) {
      calls.push({ operation: "request", input });
      return { accepted: true, phone: input.phone, ip: input.ip, accountState: "registered" };
    },
    async confirm(input) {
      calls.push({ operation: "confirm", input });
      return {
        phoneVerificationToken: "signed-registration-token",
        expiresAt: "2026-08-30T10:15:00.000Z",
        internal: "must-not-be-exposed"
      };
    }
  };

  await withRouter(smsRegistration, async (baseUrl) => {
    const requested = await postJson(`${baseUrl}/api/auth/register/sms/request`, {
      phone: "138 0000 0001",
      captchaVerifyParam: "captcha-once"
    }, { "X-Forwarded-For": "203.0.113.10" });
    assert.equal(requested.status, 200);
    assert.deepEqual(await requested.json(), {
      ok: true,
      message: "如果该手机号可用于注册，验证码将发送到该号码"
    });
    assert.deepEqual(calls[0], {
      operation: "request",
      input: {
        phone: "138 0000 0001",
        captchaVerifyParam: "captcha-once",
        ip: "203.0.113.10"
      }
    });

    const confirmed = await postJson(`${baseUrl}/api/auth/register/sms/confirm`, {
      phone: "13800000001",
      code: "123456"
    });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(await confirmed.json(), {
      phoneVerificationToken: "signed-registration-token",
      expiresAt: "2026-08-30T10:15:00.000Z"
    });
    assert.deepEqual(calls[1], {
      operation: "confirm",
      input: { phone: "13800000001", code: "123456" }
    });
  });
});
test("registration SMS routes preserve safe service status codes and conceal unexpected details", async () => {
  const expectedErrors = new Map([
    ["disabled", { statusCode: 503, message: "短信验证暂未启用" }],
    ["phone", { statusCode: 422, message: "手机号格式无效" }],
    ["rate", { statusCode: 429, message: "请求过于频繁，请稍后再试" }],
    ["code", { statusCode: 422, message: "验证码无效或已过期" }]
  ]);
  let mode = "disabled";
  const fail = () => {
    const detail = expectedErrors.get(mode);
    throw Object.assign(new Error(detail.message), { statusCode: detail.statusCode });
  };
  const smsRegistration = {
    enabled: false,
    request: async () => fail(),
    confirm: async () => fail()
  };

  await withRouter(smsRegistration, async (baseUrl) => {
    for (const [nextMode, expected] of [...expectedErrors].slice(0, 3)) {
      mode = nextMode;
      const response = await postJson(`${baseUrl}/api/auth/register/sms/request`, { phone: "13800000001" });
      assert.equal(response.status, expected.statusCode);
      assert.deepEqual(await response.json(), { error: expected.message });
    }

    mode = "code";
    const invalidCode = await postJson(`${baseUrl}/api/auth/register/sms/confirm`, {
      phone: "13800000001",
      code: "654321"
    });
    assert.equal(invalidCode.status, 422);
    assert.deepEqual(await invalidCode.json(), { error: "验证码无效或已过期" });

    smsRegistration.confirm = async () => {
      throw new Error("provider failure for phone 13800000001 and code 654321");
    };
    const unexpected = await postJson(`${baseUrl}/api/auth/register/sms/confirm`, {
      phone: "13800000001",
      code: "654321"
    });
    assert.equal(unexpected.status, 500);
    const unexpectedBody = await unexpected.json();
    assert.deepEqual(unexpectedBody, { error: "服务器内部错误" });
    assert.doesNotMatch(JSON.stringify(unexpectedBody), /13800000001|654321/);
  });
});

test("public features independently report SMS registration and conditionally expose its captcha scene", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/public/features`);
    assert.equal(response.status, 200);
    const features = await response.json();
    assert.equal(features.smsRegistrationEnabled, true);
    assert.equal(features.smsLoginEnabled, false);
    assert.equal(features.smsPasswordResetEnabled, false);
    assert.equal(features.captcha.enabled, true);
    assert.equal(features.captcha.scenes.smsRegistration, "registration-scene");
  }, {
    prefix: "aerogp-sms-registration-features-",
    env: {
      ALIBABA_CLOUD_ACCESS_KEY_ID: "test-access-key-id",
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: "test-access-key-secret",
      ALIYUN_SMS_SIGN_NAME: "测试签名",
      ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE: "SMS_REGISTER_TEST",
      ALIYUN_CAPTCHA_ENABLED: "true",
      ALIYUN_CAPTCHA_REGION: "cn",
      ALIYUN_CAPTCHA_PREFIX: "test-prefix",
      ALIYUN_CAPTCHA_SMS_REGISTRATION_SCENE_ID: "registration-scene",
      ALIYUN_CAPTCHA_LOGIN_SCENE_ID: "login-scene",
      ALIYUN_CAPTCHA_SMS_RESET_SCENE_ID: "reset-scene",
      ALIYUN_CAPTCHA_EMAIL_RESET_SCENE_ID: "email-reset-scene"
    }
  });
});
