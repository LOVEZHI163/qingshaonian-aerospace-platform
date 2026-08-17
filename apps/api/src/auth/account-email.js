import { createHmac, randomBytes as secureRandomBytes } from "node:crypto";

import { clearUserTemporaryPassword } from "../services/account-passwords.js";
import { recordAudit } from "../services/audit.js";
import { hashPassword as defaultHashPassword, validatePassword, verifyPassword as defaultVerifyPassword } from "./passwords.js";

const HOUR_MS = 60 * 60 * 1000;
export const UNIFORM_EMAIL_RESET_RESPONSE = {
  ok: true,
  message: "如果该邮箱已绑定并完成验证，重置邮件将在几分钟内发送，请同时检查垃圾邮件目录。"
};

export class AccountEmailError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AccountEmailError(422, "INVALID_EMAIL", "邮箱格式不正确");
  }
  return email;
}

function digestToken(secret, purpose, token) {
  return createHmac("sha256", secret).update(`${purpose}:${token}`).digest("hex");
}

function makeUrl(publicAppUrl, view, token) {
  const url = new URL("/admin/", publicAppUrl);
  url.searchParams.set("view", view);
  url.searchParams.set("token", token);
  return url.toString();
}

export function createAccountEmailService({
  readDb, writeDb, withMutationLock = (handler) => handler(), tokenStore, authState, emailProvider,
  secret, publicAppUrl, clock = Date.now, randomBytes = secureRandomBytes,
  verifyPassword = defaultVerifyPassword, hashPassword = defaultHashPassword
}) {
  if (!tokenStore || !authState || !secret || !publicAppUrl) throw new Error("Account email service configuration is incomplete");
  const nowIso = () => new Date(clock()).toISOString();

  function createToken(purpose) {
    const raw = randomBytes(32).toString("base64url");
    return { raw, digest: digestToken(secret, purpose, raw) };
  }
  function invalidToken() {
    return new AccountEmailError(422, "INVALID_OR_EXPIRED_TOKEN", "链接无效或已过期，请重新申请");
  }
  async function rateLimit(keys) {
    if (!await authState.consumeRateLimits(keys, clock())) {
      throw new AccountEmailError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试");
    }
  }

  return {
    async requestVerification({ userId, currentPassword, email: incomingEmail, ip = "unknown" }) {
      if (!emailProvider) throw new AccountEmailError(503, "EMAIL_SERVICE_UNAVAILABLE", "邮箱服务暂未启用");
      const email = normalizeEmail(incomingEmail);
      await rateLimit([
        { key: `email-verify:user:${userId}`, limit: 5, windowMs: HOUR_MS, cooldownMs: 60_000 },
        { key: `email-verify:ip:${ip}`, limit: 20, windowMs: HOUR_MS }
      ]);
      const db = await readDb();
      const user = db.users.find((row) => row.id === userId && row.status === "active");
      if (!user || !await verifyPassword(currentPassword, user.password)) {
        throw new AccountEmailError(422, "CURRENT_PASSWORD_INVALID", "当前密码不正确");
      }
      if (db.users.some((row) => row.id !== userId && row.email?.toLowerCase() === email)) {
        throw new AccountEmailError(409, "EMAIL_ALREADY_BOUND", "该邮箱已绑定其他账户");
      }
      const token = createToken("verify_email");
      const createdAt = nowIso();
      await tokenStore.replace({ userId, purpose: "verify_email", targetEmail: email, digest: token.digest, expiresAt: new Date(clock() + 30 * 60_000).toISOString(), requestIp: ip, createdAt });
      try {
        await emailProvider.sendVerification({ to: email, verifyUrl: makeUrl(publicAppUrl, "verifyEmail", token.raw), expiresMinutes: 30 });
      } catch (error) {
        await tokenStore.revokeUserPurpose(userId, "verify_email");
        throw error;
      }
      return { ok: true, message: "验证邮件已发送，请在 30 分钟内完成验证。" };
    },
    async confirmVerification({ token }) {
      const consumed = await tokenStore.consume({ digest: digestToken(secret, "verify_email", String(token || "")), purpose: "verify_email", now: nowIso() });
      if (!consumed) throw invalidToken();
      return withMutationLock(async () => {
        const db = await readDb();
        const user = db.users.find((row) => row.id === consumed.userId && row.status === "active");
        if (!user || db.users.some((row) => row.id !== user.id && row.email?.toLowerCase() === consumed.targetEmail.toLowerCase())) throw invalidToken();
        user.email = consumed.targetEmail.toLowerCase();
        user.emailVerifiedAt = nowIso();
        user.emailUpdatedAt = nowIso();
        recordAudit(db, { actor: user, action: "account.email.verified", targetType: "user", targetId: user.id, summary: "账户邮箱已完成验证", createdAt: nowIso() });
        await writeDb(db);
        return { ok: true, email: user.email };
      });
    },
    async requestPasswordReset({ email: incomingEmail, ip = "unknown" }) {
      if (!emailProvider) throw new AccountEmailError(503, "EMAIL_SERVICE_UNAVAILABLE", "邮箱服务暂未启用");
      let email;
      try { email = normalizeEmail(incomingEmail); } catch { email = "invalid"; }
      await rateLimit([
        { key: `email-reset:email:${email}`, limit: 5, windowMs: HOUR_MS, cooldownMs: 60_000 },
        { key: `email-reset:ip:${ip}`, limit: 20, windowMs: HOUR_MS }
      ]);
      const db = await readDb();
      const user = db.users.find((row) => row.status === "active" && row.emailVerifiedAt && row.email?.toLowerCase() === email);
      if (!user) return { ...UNIFORM_EMAIL_RESET_RESPONSE };
      const token = createToken("reset_password");
      await tokenStore.replace({ userId: user.id, purpose: "reset_password", targetEmail: email, digest: token.digest, expiresAt: new Date(clock() + 10 * 60_000).toISOString(), requestIp: ip, createdAt: nowIso() });
      try {
        await emailProvider.sendPasswordReset({ to: email, resetUrl: makeUrl(publicAppUrl, "resetPassword", token.raw), expiresMinutes: 10 });
      } catch (error) {
        await tokenStore.revokeUserPurpose(user.id, "reset_password");
        throw error;
      }
      return { ...UNIFORM_EMAIL_RESET_RESPONSE };
    },
    async inspectPasswordReset({ token }) {
      const row = await tokenStore.inspect({ digest: digestToken(secret, "reset_password", String(token || "")), purpose: "reset_password", now: nowIso() });
      return row ? { email: row.targetEmail } : null;
    },
    async confirmPasswordReset({ token, password }) {
      const passwordError = validatePassword(password);
      if (passwordError) throw new AccountEmailError(422, "INVALID_PASSWORD", passwordError);
      const consumed = await tokenStore.consume({ digest: digestToken(secret, "reset_password", String(token || "")), purpose: "reset_password", now: nowIso() });
      if (!consumed) throw invalidToken();
      const result = await withMutationLock(async () => {
        const db = await readDb();
        const user = db.users.find((row) => row.id === consumed.userId && row.status === "active" && row.emailVerifiedAt && row.email?.toLowerCase() === consumed.targetEmail.toLowerCase());
        if (!user) throw invalidToken();
        user.password = await hashPassword(password);
        user.sessionVersion = Number(user.sessionVersion || 0) + 1;
        user.mustChangePassword = false;
        clearUserTemporaryPassword(user);
        recordAudit(db, { actor: user, action: "account.password.email_reset", targetType: "user", targetId: user.id, summary: "账户已通过验证邮箱重置密码", createdAt: nowIso() });
        await writeDb(db);
        return { ok: true, email: user.email };
      });
      try { await emailProvider?.sendSecurityNotice({ to: result.email, kind: "password_changed" }); } catch { /* password change remains authoritative */ }
      return { ok: true };
    }
  };
}
