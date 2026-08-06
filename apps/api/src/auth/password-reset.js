import { createHmac, randomInt } from "node:crypto";

import { hashPassword, validatePassword } from "./passwords.js";
import { clearUserTemporaryPassword } from "../services/account-passwords.js";

const HOUR_MS = 60 * 60 * 1000;
const UNIFORM_RESPONSE = { ok: true, message: "如果该手机号已注册，验证码将发送到该号码" };

class PasswordResetError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const normalizePhone = (value) => String(value || "").replace(/\D/g, "");

function digestCode(secret, phone, code) {
  return createHmac("sha256", secret).update(`${phone}:${code}`).digest("hex");
}

export function createSmsPasswordResetService({
  secret,
  readDb,
  writeDb,
  smsProvider,
  authState,
  withMutationLock = (handler) => handler(),
  clock = Date.now,
  generateCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0"),
  clearTemporaryPassword = clearUserTemporaryPassword,
  logger = console
}) {
  if (!authState) throw new Error("authState is required");

  function safeLog(method, message) {
    try {
      logger[method]?.(message);
    } catch {}
  }

  function dispatchCode(phone, code, digest) {
    const dispatch = Promise.resolve()
      .then(() => smsProvider.sendCode({ phone, code }))
      .catch(async () => {
        safeLog("warn", "SMS password-reset dispatch failed");
        try {
          await authState.deleteChallenge(phone, digest);
        } catch {
          safeLog("error", "SMS password-reset challenge cleanup failed");
        }
      });
    void dispatch.catch(() => {});
  }

  return {
    enabled: Boolean(smsProvider),
    async request({ phone: incomingPhone, ip = "unknown" }) {
      if (!smsProvider) throw new PasswordResetError(503, "短信密码重置未启用");
      const phone = normalizePhone(incomingPhone);
      const currentTime = clock();
      const allowed = await authState.consumeRateLimits([
        { key: `sms:phone:${phone}`, limit: 5, windowMs: HOUR_MS, cooldownMs: 60_000 },
        { key: `sms:ip:${ip}`, limit: 20, windowMs: HOUR_MS }
      ], currentTime);
      if (!allowed) throw new PasswordResetError(429, "请求过于频繁，请稍后再试");

      const db = await readDb();
      const user = db.users.find((item) => normalizePhone(item.phone) === phone && item.status === "active");
      const code = generateCode();
      const digest = digestCode(secret, phone, code);
      await authState.saveChallenge({
        phone,
        digest,
        expiresAt: currentTime + 5 * 60 * 1000,
        attempts: 0
      }, { enabled: Boolean(user) });
      if (user) dispatchCode(phone, code, digest);
      return { ...UNIFORM_RESPONSE };
    },
    async confirm({ phone: incomingPhone, code: incomingCode, password }) {
      const passwordError = validatePassword(password);
      if (passwordError) throw new PasswordResetError(422, passwordError);
      const phone = normalizePhone(incomingPhone);
      const valid = await authState.consumeChallenge({
        phone,
        digest: digestCode(secret, phone, String(incomingCode || "")),
        now: clock(),
        maxAttempts: 5
      });
      if (!valid) throw new PasswordResetError(422, "验证码无效或已过期");

      await withMutationLock(async () => {
        const db = await readDb();
        const user = db.users.find((item) => normalizePhone(item.phone) === phone && item.status === "active");
        if (!user) throw new PasswordResetError(422, "验证码无效或已过期");
        user.password = await hashPassword(password);
        user.sessionVersion += 1;
        user.mustChangePassword = false;
        clearTemporaryPassword(user);
        await writeDb(db);
      });
      return { ok: true };
    }
  };
}

export function sendPasswordResetError(error, res) {
  if (!error?.statusCode) throw error;
  return res.status(error.statusCode).json({ error: error.message });
}
