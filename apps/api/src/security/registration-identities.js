import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ID_PATTERN = /^\d{17}[\dXx]$/;
const CHECKSUM_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECKSUM_CHARACTERS = "10X98765432";
const KEY_VERSION = 1;
const FINGERPRINT_INFO = Buffer.from("registration-identities:fingerprint:v1", "utf8");

function identityValidationError() {
  return new Error("身份证号校验失败");
}

export function requireRegistrationIdentityEncryptionKey(env = process.env) {
  const encoded = env.REGISTRATION_ID_ENCRYPTION_KEY;
  if (!encoded) throw new Error("REGISTRATION_ID_ENCRYPTION_KEY is required");
  if (!BASE64.test(encoded)) throw new Error("REGISTRATION_ID_ENCRYPTION_KEY must be valid base64");
  const key = Buffer.from(encoded, "base64");
  if (key.toString("base64") !== encoded) throw new Error("REGISTRATION_ID_ENCRYPTION_KEY must be valid base64");
  if (key.length !== 32) throw new Error("REGISTRATION_ID_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

function readEncryptionKey() {
  return requireRegistrationIdentityEncryptionKey(process.env);
}

function decodeCiphertextPart(value, expectedLength) {
  if (typeof value !== "string" || !BASE64.test(value)) throw new Error("invalid encrypted identity");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedLength && decoded.length !== expectedLength)) {
    throw new Error("invalid encrypted identity");
  }
  return decoded;
}

export function normalizeStudentId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw identityValidationError();
  const normalized = `${value.slice(0, 17)}${value.at(-1).toUpperCase()}`;
  const year = Number(normalized.slice(6, 10));
  const month = Number(normalized.slice(10, 12));
  const day = Number(normalized.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw identityValidationError();
  }
  const now = new Date();
  const currentUtcDate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (date.getTime() > currentUtcDate) throw identityValidationError();
  const checksum = CHECKSUM_WEIGHTS.reduce((total, weight, index) => total + Number(normalized[index]) * weight, 0);
  if (CHECKSUM_CHARACTERS[checksum % 11] !== normalized.at(-1)) throw identityValidationError();
  return normalized;
}

export function fingerprintStudentId(value) {
  const identityNumber = normalizeStudentId(value);
  const fingerprintKey = Buffer.from(hkdfSync("sha256", readEncryptionKey(), Buffer.alloc(0), FINGERPRINT_INFO, 32));
  return createHmac("sha256", fingerprintKey).update(identityNumber, "utf8").digest("base64url");
}

export function encryptStudentId(value) {
  const identityNumber = normalizeStudentId(value);
  const key = readEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(identityNumber, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: KEY_VERSION,
    idFingerprint: fingerprintStudentId(identityNumber)
  };
}

export function createParticipantIdentity(participantId, studentIdNumber, timestamp = new Date().toISOString()) {
  return {
    participantId,
    ...encryptStudentId(studentIdNumber),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function decryptStudentId(row) {
  const key = readEncryptionKey();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, decodeCiphertextPart(row?.iv, 12));
    decipher.setAuthTag(decodeCiphertextPart(row?.authTag, 16));
    const plaintext = Buffer.concat([
      decipher.update(decodeCiphertextPart(row?.ciphertext)),
      decipher.final()
    ]).toString("utf8");
    return normalizeStudentId(plaintext);
  } catch {
    throw new Error("身份证解密失败");
  }
}

export function identityDto(row) {
  return {
    registrationId: row?.registrationId,
    keyVersion: row?.keyVersion,
    createdAt: row?.createdAt,
    updatedAt: row?.updatedAt
  };
}
