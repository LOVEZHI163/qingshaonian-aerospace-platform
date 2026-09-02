import assert from "node:assert/strict";
import test from "node:test";

import { createEmailProvider } from "../src/auth/email-provider.js";

const env = {
  DIRECTMAIL_SMTP_HOST: "smtpdm.aliyun.com",
  DIRECTMAIL_SMTP_PORT: "465",
  DIRECTMAIL_SMTP_USER: "no-reply@mail.aerogp.cn",
  DIRECTMAIL_SMTP_PASSWORD: "smtp-secret-value",
  DIRECTMAIL_FROM: "温州市青少年航空航天创新比赛 <no-reply@mail.aerogp.cn>"
};

test("email provider stays disabled until every DirectMail setting is present", () => {
  assert.equal(createEmailProvider({}), null);
  assert.equal(createEmailProvider({ ...env, DIRECTMAIL_SMTP_PASSWORD: "" }), null);
});

test("email provider sends local verification and reset templates through injected transport", async () => {
  const sent = [];
  let transportOptions;
  const provider = createEmailProvider(env, {
    transportFactory(options) {
      transportOptions = options;
      return { sendMail: async (message) => { sent.push(message); } };
    }
  });

  await provider.sendVerification({
    to: "user@example.com",
    verifyUrl: "https://aerogp.cn/admin/?view=verifyEmail&token=verify-abc",
    expiresMinutes: 30
  });
  await provider.sendPasswordReset({
    to: "user@example.com",
    resetUrl: "https://aerogp.cn/admin/?view=resetPassword&token=reset-abc",
    expiresMinutes: 10
  });
  await provider.sendSecurityNotice({ to: "user@example.com", kind: "password_changed" });

  assert.deepEqual(transportOptions, {
    host: "smtpdm.aliyun.com",
    port: 465,
    secure: true,
    auth: { user: "no-reply@mail.aerogp.cn", pass: "smtp-secret-value" }
  });
  assert.equal(sent[0].from, env.DIRECTMAIL_FROM);
  assert.equal(sent[0].to, "user@example.com");
  assert.match(sent[0].html, /30 分钟/);
  assert.match(sent[0].html, /view=verifyEmail/);
  assert.match(sent[1].html, /10 分钟/);
  assert.match(sent[1].html, /view=resetPassword/);
  assert.match(sent[2].subject, /密码已修改/);
});

test("email provider exposes a safe delivery error without SMTP password or link token", async () => {
  const provider = createEmailProvider(env, {
    transportFactory() {
      return { sendMail: async () => { throw new Error("smtp-secret-value reset-abc vendor failure"); } };
    }
  });

  await assert.rejects(
    provider.sendPasswordReset({
      to: "user@example.com",
      resetUrl: "https://aerogp.cn/admin/?view=resetPassword&token=reset-abc",
      expiresMinutes: 10
    }),
    (error) => error.code === "EMAIL_DELIVERY_FAILED"
      && !String(error.message).includes("smtp-secret-value")
      && !String(error.message).includes("reset-abc")
  );
});
