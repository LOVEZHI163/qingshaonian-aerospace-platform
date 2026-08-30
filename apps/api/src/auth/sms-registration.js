import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 15 * 60 * 1000;
const PURPOSE = "sms-registration";
const TOKEN_VERSION = 1;
const TOKEN_DOMAIN = "sms-registration-ticket:v1";

const normalizePhone = (value) => String(value || "").replace(/\D/g, "");

export class SmsRegistrationError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const expiredVerification = () => new SmsRegistrationError(422, "手机号验证已过期，请重新验证");
const invalidCode = () => new SmsRegistrationError(422, "验证码无效或已过期");

function signingKey(secret) {
  return createHmac("sha256", secret)
    .update(TOKEN_DOMAIN)
    .digest();
}

function sign(encodedPayload, secret) {
  return createHmac("sha256", signingKey(secret))
    .update(encodedPayload)
    .digest();
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw expiredVerification();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw expiredVerification();
  return decoded;
}

export function createPhoneRegistrationToken({ phone, secret, now, nonce }) {
  const issuedAt = Number(now);
  if (!Number.isFinite(issuedAt)) throw new TypeError("now must be a finite timestamp");
  if (typeof nonce !== "string" || !nonce) throw new TypeError("nonce is required");

  const payload = {
    v: TOKEN_VERSION,
    purpose: PURPOSE,
    phone: normalizePhone(phone),
    iat: issuedAt,
    exp: issuedAt + TOKEN_TTL_MS,
    nonce
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encodedPayload, secret).toString("base64url");
  return {
    phoneVerificationToken: `${encodedPayload}.${signature}`,
    expiresAt: new Date(payload.exp).toISOString()
  };
}

export function verifyPhoneRegistrationToken({ phone, phoneVerificationToken, secret, now }) {
  try {
    if (typeof phoneVerificationToken !== "string") throw expiredVerification();
    const segments = phoneVerificationToken.split(".");
    if (segments.length !== 2 || !segments[0] || !segments[1]) throw expiredVerification();

    const [encodedPayload, encodedSignature] = segments;
    const suppliedSignature = decodeBase64Url(encodedSignature);
    const expectedSignature = sign(encodedPayload, secret);
    if (suppliedSignature.length !== expectedSignature.length) throw expiredVerification();
    if (!timingSafeEqual(suppliedSignature, expectedSignature)) throw expiredVerification();

    const payloadBuffer = decodeBase64Url(encodedPayload);
    const payload = JSON.parse(payloadBuffer.toString("utf8"));
    const currentTime = Number(now);
    const expectedPhone = normalizePhone(phone);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw expiredVerification();
    if (payload.v !== TOKEN_VERSION || payload.purpose !== PURPOSE) throw expiredVerification();
    if (payload.phone !== expectedPhone) throw expiredVerification();
    if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || !Number.isFinite(currentTime)) {
      throw expiredVerification();
    }
    if (payload.exp !== payload.iat + TOKEN_TTL_MS || payload.iat > currentTime || currentTime >= payload.exp) {
      throw expiredVerification();
    }
    if (typeof payload.nonce !== "string" || !payload.nonce) throw expiredVerification();
    return true;
  } catch {
    throw expiredVerification();
  }
}

export function createSmsRegistrationService({
  challengeService,
  readDb,
  secret,
  clock = Date.now,
  randomNonce = () => randomBytes(16).toString("base64url")
}) {
  if (!challengeService) throw new Error("challengeService is required");

  return {
    enabled: challengeService.enabled,
    request(input) {
      return challengeService.request(input);
    },
    async confirm({ phone, code }) {
      const normalized = normalizePhone(phone);
      if (!await challengeService.consume({ phone: normalized, code })) throw invalidCode();
      const db = await readDb();
      if (db.users.some((user) => normalizePhone(user.phone) === normalized)) throw invalidCode();
      return createPhoneRegistrationToken({
        phone: normalized,
        secret,
        now: clock(),
        nonce: randomNonce()
      });
    },
    verify({ phone, phoneVerificationToken }) {
      return verifyPhoneRegistrationToken({
        phone,
        phoneVerificationToken,
        secret,
        now: clock()
      });
    }
  };
}
