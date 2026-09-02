import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";

import { createFileAuthState } from "../src/data/auth-state.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs } from "./helpers/api-client.js";

const SESSION_SECRET = "sms-http-session-integration-secret";
const SMS_ENV = {
  SESSION_SECRET,
  ALIBABA_CLOUD_ACCESS_KEY_ID: "test-access-key-id",
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: "test-access-key-secret",
  ALIYUN_SMS_SIGN_NAME: "测试签名",
  ALIYUN_SMS_LOGIN_TEMPLATE_CODE: "SMS_LOGIN_TEST",
  ALIYUN_SMS_RESET_TEMPLATE_CODE: "SMS_RESET_TEST"
};

async function persistSentChallenge(dbPath, { purpose, phone, code }) {
  const digest = createHmac("sha256", SESSION_SECRET)
    .update(`${purpose}:${phone}:${code}`)
    .digest("hex");
  await createFileAuthState(`${dbPath}.auth.json`).saveChallenge({
    purpose,
    phone,
    digest,
    expiresAt: Date.now() + 5 * 60 * 1000,
    attempts: 0
  });
}

function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

test("a persisted SMS login challenge cannot create a session after the user loses eligibility", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const phone = "13800000001";
    await persistSentChallenge(dbPath, { purpose: "sms-login", phone, code: "123456" });
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.users.find((user) => user.phone === phone).status = "disabled";
    await fs.writeFile(dbPath, JSON.stringify(db), "utf8");

    const confirm = await postJson(`${baseUrl}/api/auth/sms-login/confirm`, { phone, code: "123456" });
    assert.equal(confirm.status, 422);
    assert.deepEqual(await confirm.json(), { error: "验证码无效或已过期" });
    assert.equal(confirm.headers.get("set-cookie"), null);
    assert.equal((await fetch(`${baseUrl}/api/auth/me`)).status, 401);
  }, { prefix: "aerogp-sms-login-session-recheck-", env: SMS_ENV });
});

test("SMS password reset invalidates a real pre-existing HTTP session", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const phone = "13800000001";
    const loggedIn = await loginAs(baseUrl, phone, "123456");
    assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: loggedIn.cookie } })).status, 200);
    await persistSentChallenge(dbPath, { purpose: "sms-password-reset", phone, code: "654321" });

    const reset = await postJson(`${baseUrl}/api/auth/password-reset/sms/confirm`, {
      phone,
      code: "654321",
      password: "NextPass2"
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { ok: true });
    assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: loggedIn.cookie } })).status, 401);
    assert.equal((await postJson(`${baseUrl}/api/auth/login`, { phone, password: "NextPass2" })).status, 200);
  }, { prefix: "aerogp-sms-reset-session-version-", env: SMS_ENV });
});
