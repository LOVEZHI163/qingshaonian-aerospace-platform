import { createHmac, randomBytes, randomInt } from "node:crypto";

const HOUR_MS = 60 * 60 * 1000;
const MESSAGE_BY_PURPOSE = Object.freeze({
  "sms-registration": "如果该手机号可用于注册，验证码将发送到该号码",
  "sms-login": "如果该手机号已注册，验证码将发送到该号码",
  "sms-password-reset": "如果该手机号已注册，验证码将发送到该号码"
});

export const SMS_PURPOSES = Object.freeze({
  registration: "sms-registration",
  login: "sms-login",
  passwordReset: "sms-password-reset"
});

export class SmsChallengeError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const normalizePhone = (value) => String(value || "").replace(/\D/g, "");

function digestCode(secret, purpose, phone, code) {
  return createHmac("sha256", secret)
    .update(`${purpose}:${phone}:${code}`)
    .digest("hex");
}

export function createSmsChallengeService({
  purpose,
  secret,
  readDb,
  smsProvider,
  authState,
  resolveEligibleTarget,
  verifyHuman = async () => true,
  clock = Date.now,
  generateCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0"),
  logger = console,
  schedule = setImmediate
}) {
  if (!Object.values(SMS_PURPOSES).includes(purpose)) throw new Error("unsupported SMS challenge purpose");
  if (!authState) throw new Error("authState is required");

  const enabled = Boolean(smsProvider?.enabled(purpose));

  function safeLog(method, message) {
    try {
      logger[method]?.(message);
    } catch {}
  }

  async function runBackground(phone, currentTime, requestDigest) {
    let digest;
    try {
      const db = await readDb();
      const eligibleTarget = await resolveEligibleTarget(db, phone);
      if (!eligibleTarget) {
        await authState.deleteChallenge({ purpose, phone, digest: requestDigest });
        return;
      }
      const code = generateCode();
      digest = digestCode(secret, purpose, phone, code);
      const saved = await authState.saveChallenge({
        purpose,
        phone,
        digest,
        expiresAt: currentTime + 5 * 60 * 1000,
        attempts: 0
      }, { expectedDigest: requestDigest });
      if (!saved) return;
      await smsProvider.sendCode({ purpose, phone, code });
    } catch {
      safeLog("warn", "SMS authentication dispatch failed");
      if (!digest) return;
      try {
        await authState.deleteChallenge({ purpose, phone, digest });
      } catch {
        safeLog("error", "SMS authentication challenge cleanup failed");
      }
    }
  }

  return {
    enabled,
    async request({ phone: incomingPhone, ip = "unknown", captchaVerifyParam = "" }) {
      if (!enabled) throw new SmsChallengeError(503, "短信验证暂未启用");
      const phone = normalizePhone(incomingPhone);
      if (!/^1[3-9]\d{9}$/.test(phone)) {
        throw new SmsChallengeError(422, "手机号格式无效");
      }
      const currentTime = clock();
      const allowed = await authState.consumeRateLimits([
        { key: `sms:phone:${phone}`, limit: 5, windowMs: HOUR_MS, cooldownMs: 60_000 },
        { key: `sms:ip:${ip}`, limit: 20, windowMs: HOUR_MS }
      ], currentTime);
      if (!allowed) throw new SmsChallengeError(429, "请求过于频繁，请稍后再试");

      const verified = await verifyHuman({ scene: purpose, captchaVerifyParam });
      if (!verified) throw new SmsChallengeError(422, "人机验证未通过，请重试");
      const requestDigest = randomBytes(32).toString("hex");
      await authState.saveChallenge({
        purpose,
        phone,
        digest: requestDigest,
        expiresAt: currentTime + 5 * 60 * 1000,
        attempts: 0
      });
      schedule(() => runBackground(phone, currentTime, requestDigest));
      return { ok: true, message: MESSAGE_BY_PURPOSE[purpose] };
    },
    async consume({ phone: incomingPhone, code: incomingCode }) {
      const phone = normalizePhone(incomingPhone);
      return authState.consumeChallenge({
        purpose,
        phone,
        digest: digestCode(secret, purpose, phone, String(incomingCode || "")),
        now: clock(),
        maxAttempts: 5
      });
    }
  };
}
