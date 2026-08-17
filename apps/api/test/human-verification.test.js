import assert from "node:assert/strict";
import test from "node:test";

import { createHumanVerification } from "../src/auth/human-verification.js";

const COMPLETE_ENV = {
  ALIBABA_CLOUD_ACCESS_KEY_ID: "id",
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret",
  ALIYUN_CAPTCHA_ENABLED: "true",
  ALIYUN_CAPTCHA_REGION: "cn",
  ALIYUN_CAPTCHA_PREFIX: "abc123",
  ALIYUN_CAPTCHA_LOGIN_SCENE_ID: "login-scene",
  ALIYUN_CAPTCHA_SMS_RESET_SCENE_ID: "sms-reset-scene",
  ALIYUN_CAPTCHA_EMAIL_RESET_SCENE_ID: "email-reset-scene"
};

test("human verification is a no-op when the feature gate is disabled", async () => {
  const disabled = createHumanVerification({ ALIYUN_CAPTCHA_ENABLED: "false" });

  assert.equal(disabled.enabled, false);
  assert.equal(disabled.ready, true);
  assert.equal(await disabled.verify({ scene: "sms-login", captchaVerifyParam: "" }), true);
});

test("human verification keeps the API available but rejects protected sends when configuration is incomplete", async () => {
  const incomplete = createHumanVerification({
    ALIYUN_CAPTCHA_ENABLED: "true",
    ALIYUN_CAPTCHA_REGION: "cn"
  });

  assert.equal(incomplete.enabled, true);
  assert.equal(incomplete.ready, false);
  await assert.rejects(
    incomplete.verify({ scene: "sms-login", captchaVerifyParam: "signed" }),
    (error) => error.statusCode === 503 && /人机验证暂不可用/.test(error.message)
  );
});

test("human verification uses the server-owned scene and forwards the signed parameter unchanged", async () => {
  const requests = [];
  const client = {
    async verifyIntelligentCaptcha(request) {
      requests.push(request);
      return { body: { result: { verifyResult: true } } };
    }
  };
  const enabled = createHumanVerification(COMPLETE_ENV, { client });

  assert.equal(enabled.enabled, true);
  assert.equal(enabled.ready, true);
  assert.equal(await enabled.verify({
    scene: "sms-login",
    captchaVerifyParam: "signed-client-payload"
  }), true);
  assert.equal(requests[0].sceneId, "login-scene");
  assert.equal(requests[0].captchaVerifyParam, "signed-client-payload");
  assert.equal(enabled.publicConfig.prefix, "abc123");
  assert.equal(enabled.publicConfig.region, "cn");
});

test("human verification maps empty, rejected, and provider failures to a stable safe error", async () => {
  const rejected = createHumanVerification(COMPLETE_ENV, {
    client: { verifyIntelligentCaptcha: async () => ({ body: { result: { verifyResult: false } } }) },
    logger: { warn() {} }
  });
  await assert.rejects(
    rejected.verify({ scene: "sms-login", captchaVerifyParam: "" }),
    (error) => error.statusCode === 422 && /人机验证未通过/.test(error.message)
  );
  await assert.rejects(
    rejected.verify({ scene: "sms-login", captchaVerifyParam: "signed" }),
    (error) => error.statusCode === 422 && /人机验证未通过/.test(error.message)
  );

  const failed = createHumanVerification(COMPLETE_ENV, {
    client: { verifyIntelligentCaptcha: async () => { throw new Error("secret provider details"); } },
    logger: { warn(message) { assert.equal(message, "Aliyun captcha verification failed"); } }
  });
  await assert.rejects(
    failed.verify({ scene: "email-password-reset", captchaVerifyParam: "signed" }),
    (error) => error.statusCode === 422 && error.message === "人机验证未通过，请重试"
  );
});
