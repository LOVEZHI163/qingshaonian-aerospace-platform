import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  decryptStudentId,
  encryptStudentId,
  fingerprintStudentId,
  identityDto,
  normalizeStudentId
} from "../src/security/registration-identities.js";
import { recordAudit } from "../src/services/audit.js";

const validId = "11010519491231002X";
const testKey = Buffer.alloc(32, 19).toString("base64");
const previousKey = process.env.REGISTRATION_ID_ENCRYPTION_KEY;

after(() => {
  if (previousKey === undefined) delete process.env.REGISTRATION_ID_ENCRYPTION_KEY;
  else process.env.REGISTRATION_ID_ENCRYPTION_KEY = previousKey;
});

test("normalizes a valid identity number and rejects invalid length, date, and checksum", () => {
  assert.equal(normalizeStudentId("11010519491231002x"), validId);
  assert.throws(() => normalizeStudentId("11010519491231002"), /身份证号校验失败/);
  assert.throws(() => normalizeStudentId("110105199902290021"), /身份证号校验失败/);
  assert.throws(() => normalizeStudentId("110105194912310021"), /身份证号校验失败/);
});

test("encrypts each identity number with a fresh IV and decrypts it without serializing plaintext", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const first = encryptStudentId(validId);
  const second = encryptStudentId(validId);

  assert.equal(decryptStudentId(first), validId);
  assert.notEqual(first.iv, second.iv);
  assert.equal(JSON.stringify(first).includes(validId), false);
  assert.equal(first.idFingerprint, fingerprintStudentId("11010519491231002x"));
  assert.notEqual(first.idFingerprint, fingerprintStudentId("110105194912310038"));
});

test("fails closed for missing, malformed, and wrong encryption keys without exposing identity plaintext", () => {
  delete process.env.REGISTRATION_ID_ENCRYPTION_KEY;
  assert.throws(() => encryptStudentId(validId), /REGISTRATION_ID_ENCRYPTION_KEY/);

  process.env.REGISTRATION_ID_ENCRYPTION_KEY = "not-base64";
  assert.throws(() => encryptStudentId(validId), /REGISTRATION_ID_ENCRYPTION_KEY/);

  process.env.REGISTRATION_ID_ENCRYPTION_KEY = Buffer.alloc(16, 19).toString("base64");
  assert.throws(() => encryptStudentId(validId), /32 bytes/);

  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const encrypted = encryptStudentId(validId);
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = Buffer.alloc(32, 20).toString("base64");
  assert.throws(
    () => decryptStudentId(encrypted),
    (error) => /身份证解密失败/.test(error.message) && !error.message.includes(validId)
  );
});

test("identity DTO excludes ciphertext, cryptographic material, fingerprints, and plaintext", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const encrypted = encryptStudentId(validId);
  const row = {
    registrationId: "R-IDENTITY",
    ...encrypted,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T01:00:00.000Z"
  };

  assert.deepEqual(identityDto(row), {
    registrationId: "R-IDENTITY",
    keyVersion: 1,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T01:00:00.000Z"
  });
  assert.equal(JSON.stringify(identityDto(row)).includes(validId), false);
});

test("audit summaries redact identity-number fields before persistence", () => {
  const db = { auditLogs: [] };
  const summary = 'payload={"studentIdNumber":"11010519491231002X","identityNumber":"11010519491231002X","idCardNumber":"11010519491231002X"}';
  const row = recordAudit(db, {
    actor: { id: "U-AUDIT", name: "安全测试" },
    action: "identity.audit",
    targetType: "registration",
    targetId: "R-IDENTITY",
    summary
  });

  assert.equal(JSON.stringify(db.auditLogs).includes(validId), false);
  assert.equal(row.summary.includes("studentIdNumber"), true);
  assert.equal(row.summary.includes("identityNumber"), true);
  assert.equal(row.summary.includes("idCardNumber"), true);
});

test("audit summaries redact identity-number fields embedded in escaped JSON", () => {
  const db = { auditLogs: [] };
  const summary = 'payload={\\"studentIdNumber\\":\\"11010519491231002X\\"}';
  const row = recordAudit(db, {
    actor: { id: "U-AUDIT", name: "安全测试" },
    action: "identity.audit",
    targetType: "registration",
    targetId: "R-IDENTITY-ESCAPED",
    summary
  });

  assert.equal(row.summary.includes(validId), false);
  assert.equal(JSON.stringify(db.auditLogs).includes(validId), false);
});

test("audit summaries redact identity-number fields embedded in URL-encoded text", () => {
  const db = { auditLogs: [] };
  const summary = "studentIdNumber%22%3A%2211010519491231002X%22";
  const row = recordAudit(db, {
    actor: { id: "U-AUDIT", name: "安全测试" },
    action: "identity.audit",
    targetType: "registration",
    targetId: "R-IDENTITY-URL-ENCODED",
    summary
  });

  assert.equal(row.summary.includes(validId), false);
  assert.equal(row.summary.includes("2X"), false);
  assert.equal(JSON.stringify(db.auditLogs).includes(validId), false);
});

test("audit summaries redact identity-number fields embedded in double URL-encoded text", () => {
  const db = { auditLogs: [] };
  const summary = "studentIdNumber%2522%253A%252211010519491231002X%2522";
  const row = recordAudit(db, {
    actor: { id: "U-AUDIT", name: "安全测试" },
    action: "identity.audit",
    targetType: "registration",
    targetId: "R-IDENTITY-DOUBLE-URL-ENCODED",
    summary
  });

  assert.equal(row.summary.includes(validId), false);
  assert.equal(JSON.stringify(db.auditLogs).includes(validId), false);
});
