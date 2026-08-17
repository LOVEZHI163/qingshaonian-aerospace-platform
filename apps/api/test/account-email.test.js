import assert from "node:assert/strict";
import test from "node:test";

import { createAccountEmailService, normalizeEmail, UNIFORM_EMAIL_RESET_RESPONSE } from "../src/auth/account-email.js";
import { createAccountEmailTokenStore } from "../src/data/account-email-tokens.js";

function fixture({ sendFailure = false, verifiedEmail = false, deferredReset = false } = {}) {
  let currentTime = Date.parse("2026-08-17T10:00:00.000Z");
  let tokenCounter = 0;
  let state = { users: [{
    id: "U1", name: "用户", phone: "13800000001", password: "OldPass1", type: "ordinary", status: "active",
    email: verifiedEmail ? "user@example.com" : null,
    emailVerifiedAt: verifiedEmail ? "2026-08-17T09:00:00.000Z" : null,
    emailUpdatedAt: verifiedEmail ? "2026-08-17T09:00:00.000Z" : null,
    sessionVersion: 3, mustChangePassword: true,
    temporaryPasswordCiphertext: "cipher", temporaryPasswordIv: "iv", temporaryPasswordTag: "tag", temporaryPasswordCreatedAt: "2026-08-17T09:00:00.000Z"
  }], accountEmailTokens: [], auditLogs: [] };
  let tail = Promise.resolve();
  const withMutationLock = async (handler) => {
    let release; const previous = tail; tail = new Promise((resolve) => { release = resolve; }); await previous;
    try { return await handler(); } finally { release(); }
  };
  const readDb = async () => structuredClone(state);
  const writeDb = async (db) => { state = structuredClone(db); };
  const tokenStore = createAccountEmailTokenStore({ readDb, writeDb, withMutationLock });
  const sent = [];
  const resetDeliveries = [];
  const emailProvider = {
    async sendVerification(message) { if (sendFailure) throw Object.assign(new Error("safe"), { code: "EMAIL_DELIVERY_FAILED" }); sent.push({ kind: "verify", ...message }); },
    async sendPasswordReset(message) {
      sent.push({ kind: "reset", ...message });
      if (sendFailure) throw Object.assign(new Error("safe"), { code: "EMAIL_DELIVERY_FAILED" });
      if (deferredReset) return new Promise((resolve, reject) => resetDeliveries.push({ resolve, reject, message }));
    },
    async sendSecurityNotice(message) { sent.push({ kind: "notice", ...message }); }
  };
  const service = createAccountEmailService({
    readDb, writeDb, withMutationLock, tokenStore, emailProvider, secret: "test-secret", publicAppUrl: "https://aerogp.cn",
    authState: { consumeRateLimits: async () => true }, clock: () => currentTime,
    randomBytes: () => Buffer.alloc(32, ++tokenCounter),
    verifyPassword: async (value, stored) => value === stored,
    hashPassword: async (value) => `hashed:${value}`
  });
  return { service, sent, db: () => structuredClone(state), tokenStore, resetDeliveries, advanceClock: (ms) => { currentTime += ms; } };
}

test("email normalization lowercases and rejects malformed values", () => {
  assert.equal(normalizeEmail(" USER@Example.COM "), "user@example.com");
  assert.throws(() => normalizeEmail("bad address"), /邮箱格式/);
});

test("binding requires current password and confirms a digest-only verification token", async () => {
  const { service, sent, db } = fixture();
  await assert.rejects(service.requestVerification({ userId: "U1", currentPassword: "wrong", email: "USER@example.com", ip: "ip" }), (e) => e.code === "CURRENT_PASSWORD_INVALID");
  await service.requestVerification({ userId: "U1", currentPassword: "OldPass1", email: "USER@example.com", ip: "ip" });
  const token = new URL(sent[0].verifyUrl).searchParams.get("token");
  assert.equal(JSON.stringify(db()).includes(token), false);
  await service.confirmVerification({ token });
  assert.equal(db().users[0].email, "user@example.com");
  assert.equal(Boolean(db().users[0].emailVerifiedAt), true);
  await assert.rejects(service.confirmVerification({ token }), (e) => e.code === "INVALID_OR_EXPIRED_TOKEN");
});

test("email password reset is uniform, one-time, and invalidates sessions", async () => {
  const { service, sent, db } = fixture();
  await service.requestVerification({ userId: "U1", currentPassword: "OldPass1", email: "user@example.com", ip: "ip" });
  await service.confirmVerification({ token: new URL(sent[0].verifyUrl).searchParams.get("token") });
  sent.length = 0;
  assert.deepEqual(await service.requestPasswordReset({ email: "unknown@example.com", ip: "ip" }), UNIFORM_EMAIL_RESET_RESPONSE);
  assert.deepEqual(await service.requestPasswordReset({ email: " USER@example.com ", ip: "ip" }), UNIFORM_EMAIL_RESET_RESPONSE);
  await new Promise((resolve) => setImmediate(resolve));
  const token = new URL(sent[0].resetUrl).searchParams.get("token");
  assert.equal((await service.inspectPasswordReset({ token })).email, "user@example.com");
  await service.confirmPasswordReset({ token, password: "NextPass2" });
  assert.equal(db().users[0].password, "hashed:NextPass2");
  assert.equal(db().users[0].sessionVersion, 4);
  assert.equal(db().users[0].mustChangePassword, false);
  assert.equal(db().users[0].temporaryPasswordCiphertext, null);
  assert.equal(await service.inspectPasswordReset({ token }), null);
});

test("failed delivery revokes the newly created token", async () => {
  const { service, tokenStore } = fixture({ sendFailure: true });
  await assert.rejects(service.requestVerification({ userId: "U1", currentPassword: "OldPass1", email: "user@example.com", ip: "ip" }), (e) => e.code === "EMAIL_DELIVERY_FAILED");
  assert.equal(await tokenStore.inspect({ digest: "missing", purpose: "verify_email", now: "2026-08-17T10:00:00.000Z" }), null);
});

test("password reset remains uniform when delivery fails and revokes the token asynchronously", async () => {
  const { service, db } = fixture({ sendFailure: true, verifiedEmail: true });
  assert.deepEqual(await service.requestPasswordReset({ email: "unknown@example.com", ip: "ip" }), UNIFORM_EMAIL_RESET_RESPONSE);
  assert.deepEqual(await service.requestPasswordReset({ email: "user@example.com", ip: "another-ip" }), UNIFORM_EMAIL_RESET_RESPONSE);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(db().accountEmailTokens.length, 0);
});

test("an older failed delivery cannot revoke a newer password-reset token", async () => {
  const { service, resetDeliveries, advanceClock } = fixture({ verifiedEmail: true, deferredReset: true });
  await service.requestPasswordReset({ email: "user@example.com", ip: "ip-1" });
  await new Promise((resolve) => setImmediate(resolve));
  const oldToken = new URL(resetDeliveries[0].message.resetUrl).searchParams.get("token");
  advanceClock(61_000);
  await service.requestPasswordReset({ email: "user@example.com", ip: "ip-2" });
  await new Promise((resolve) => setImmediate(resolve));
  const newToken = new URL(resetDeliveries[1].message.resetUrl).searchParams.get("token");

  resetDeliveries[0].reject(new Error("late SMTP failure"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await service.inspectPasswordReset({ token: oldToken }), null);
  assert.equal((await service.inspectPasswordReset({ token: newToken })).email, "user@example.com");
  resetDeliveries[1].resolve();
});
