import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { hashPassword, validatePassword } from "./passwords.js";

const HOUR_MS = 60 * 60 * 1000;
const UNIFORM_RESPONSE = { ok: true, message: "如果该手机号已注册，验证码将发送到该号码" };

class PasswordResetError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const normalizePhone = (value) => String(value || "").replace(/\D/g, "");

function prune(events, threshold) {
  while (events.length && events[0] <= threshold) events.shift();
}

function digestCode(secret, phone, code) {
  return createHmac("sha256", secret).update(`${phone}:${code}`).digest("hex");
}

export function createSmsPasswordResetService({
  secret,
  readDb,
  writeDb,
  smsProvider,
  challengeStore = new Map(),
  clock = Date.now,
  generateCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0")
}) {
  const phoneRequests = new Map();
  const ipRequests = new Map();
  const lastPhoneRequest = new Map();

  function limitRequest(phone, ip, currentTime) {
    const lastRequest = lastPhoneRequest.get(phone);
    if (lastRequest !== undefined && currentTime - lastRequest < 60_000) {
      throw new PasswordResetError(429, "请求过于频繁，请稍后再试");
    }

    const phoneEvents = phoneRequests.get(phone) || [];
    prune(phoneEvents, currentTime - HOUR_MS);
    if (phoneEvents.length >= 5) throw new PasswordResetError(429, "请求过于频繁，请稍后再试");

    const ipEvents = ipRequests.get(ip) || [];
    prune(ipEvents, currentTime - HOUR_MS);
    if (ipEvents.length >= 20) throw new PasswordResetError(429, "请求过于频繁，请稍后再试");

    phoneEvents.push(currentTime);
    ipEvents.push(currentTime);
    phoneRequests.set(phone, phoneEvents);
    ipRequests.set(ip, ipEvents);
    lastPhoneRequest.set(phone, currentTime);
  }

  return {
    enabled: Boolean(smsProvider),
    async request({ phone: incomingPhone, ip = "unknown" }) {
      if (!smsProvider) throw new PasswordResetError(503, "短信密码重置未启用");
      const phone = normalizePhone(incomingPhone);
      const currentTime = clock();
      limitRequest(phone, ip, currentTime);
      const db = await readDb();
      const user = db.users.find((item) => normalizePhone(item.phone) === phone && item.status === "active");
      if (user) {
        const code = generateCode();
        try {
          await smsProvider.sendCode({ phone, code });
        } catch {
          return { ...UNIFORM_RESPONSE };
        }
        challengeStore.set(phone, {
          digest: digestCode(secret, phone, code),
          expiresAt: currentTime + 5 * 60 * 1000,
          attempts: 0
        });
      }
      return { ...UNIFORM_RESPONSE };
    },
    async confirm({ phone: incomingPhone, code: incomingCode, password }) {
      const passwordError = validatePassword(password);
      if (passwordError) throw new PasswordResetError(422, passwordError);
      const phone = normalizePhone(incomingPhone);
      const challenge = challengeStore.get(phone);
      if (!challenge || challenge.expiresAt < clock()) {
        challengeStore.delete(phone);
        throw new PasswordResetError(422, "验证码无效或已过期");
      }

      const expected = Buffer.from(challenge.digest, "hex");
      const actual = Buffer.from(digestCode(secret, phone, String(incomingCode || "")), "hex");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        challenge.attempts += 1;
        if (challenge.attempts >= 5) challengeStore.delete(phone);
        throw new PasswordResetError(422, "验证码无效或已过期");
      }

      const db = await readDb();
      const user = db.users.find((item) => normalizePhone(item.phone) === phone && item.status === "active");
      if (!user) {
        challengeStore.delete(phone);
        throw new PasswordResetError(422, "验证码无效或已过期");
      }
      user.password = await hashPassword(password);
      user.sessionVersion += 1;
      user.mustChangePassword = false;
      await writeDb(db);
      challengeStore.delete(phone);
      return { ok: true };
    }
  };
}

export function sendPasswordResetError(error, res) {
  if (!error?.statusCode) throw error;
  return res.status(error.statusCode).json({ error: error.message });
}
