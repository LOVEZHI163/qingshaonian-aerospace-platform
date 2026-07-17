import assert from "node:assert/strict";
import test from "node:test";

import { CERTIFICATE_POLICY, validateUpload } from "../src/files/policy.js";
import { ensureDbShape } from "../src/data/seed.js";
import {
  CertificateError,
  removeCertificate,
  setCertificateStatuses,
  updateCertificateMetadata,
  upsertCertificate
} from "../src/services/certificates.js";

function fixture() {
  return {
    registrations: [{
      id: "R1",
      userId: "U1",
      organizationId: "O1",
      awardName: "",
      rank: "",
      score: ""
    }],
    certificates: []
  };
}

const storedFile = (suffix) => ({
  originalName: `${suffix}.png`,
  storedName: `${suffix}.png`,
  filePath: `/safe/certificates/${suffix}.png`
});

const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63600000020001e221bc330000000049454e44ae426082", "hex");
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAFcf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAQUCq//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEABj8Cp//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8h/9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAE/EP/Z", "base64");
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x18, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(20)]);

test("certificate file policy accepts real PDF, PNG, JPEG, and WebP content", async () => {
  assert.deepEqual([...CERTIFICATE_POLICY.extensions], ["pdf", "png", "jpg", "jpeg", "webp"]);
  assert.equal(CERTIFICATE_POLICY.maxBytes, 10 * 1024 * 1024);
  for (const buffer of [pdf, png, jpeg, webp]) {
    await assert.doesNotReject(() => validateUpload({ buffer }, CERTIFICATE_POLICY));
  }
});

test("certificate JSON normalization removes the legacy camel-case number field", () => {
  const legacyKey = ["certificate", "No"].join("");
  const db = ensureDbShape({
    certificates: [{
      id: "C-LEGACY-FIELD",
      registrationId: "R1",
      slot: 1,
      title: "旧证书",
      [legacyKey]: "LEGACY-001"
    }]
  });

  assert.equal(Object.hasOwn(db.certificates[0], legacyKey), false);
});

test("certificate service upserts the two slots and resets replacements to draft", () => {
  const db = fixture();
  const registration = db.registrations[0];
  const first = upsertCertificate(db, {
    registration,
    slot: 1,
    title: "  一等奖  ",
    storedFile: storedFile("first"),
    source: "manual",
    now: "2026-07-17T00:00:00.000Z"
  });
  const second = upsertCertificate(db, {
    registration,
    slot: 2,
    title: "二等奖",
    storedFile: storedFile("second"),
    source: "manual",
    now: "2026-07-17T00:01:00.000Z"
  });
  first.status = "published";
  first.publishedAt = "2026-07-17T00:02:00.000Z";
  const replaced = upsertCertificate(db, {
    registration,
    slot: 1,
    title: "替换证书",
    storedFile: storedFile("replacement"),
    source: "manual",
    now: "2026-07-17T00:03:00.000Z"
  });

  assert.equal(first.title, "替换证书");
  assert.equal(replaced.id, first.id);
  assert.equal(replaced.status, "draft");
  assert.equal(replaced.publishedAt, "");
  assert.deepEqual(db.certificates.map((row) => row.slot).sort(), [1, 2]);
  assert.equal(second.slot, 2);
});

test("certificate service validates metadata, bulk status, and removal atomically", () => {
  const db = fixture();
  const certificate = upsertCertificate(db, {
    registration: db.registrations[0],
    slot: 1,
    title: "初始标题",
    storedFile: storedFile("certificate"),
    source: "manual",
    now: "2026-07-17T00:00:00.000Z"
  });

  assert.throws(() => upsertCertificate(db, {
    registration: db.registrations[0], slot: 3, title: "非法", storedFile: storedFile("invalid"), now: "now"
  }), (error) => error instanceof CertificateError && error.status === 422);
  assert.throws(() => updateCertificateMetadata(db, {
    certificateId: certificate.id, title: "   ", now: "now"
  }), (error) => error instanceof CertificateError && error.status === 422);

  const updated = updateCertificateMetadata(db, {
    certificateId: certificate.id,
    title: "  金奖证书  ",
    awardName: "一等奖",
    rank: "1",
    score: "100",
    now: "2026-07-17T00:01:00.000Z"
  });
  assert.deepEqual({ title: updated.title, awardName: updated.awardName, rank: updated.rank, score: updated.score }, {
    title: "金奖证书", awardName: "一等奖", rank: "1", score: "100"
  });

  assert.throws(() => setCertificateStatuses(db, [certificate.id], "archived", "now"), (error) => error.status === 422);
  assert.throws(() => setCertificateStatuses(db, [certificate.id, "missing"], "published", "now"), (error) => error.status === 404);
  assert.equal(certificate.status, "draft");
  setCertificateStatuses(db, [certificate.id], "published", "2026-07-17T00:02:00.000Z");
  assert.equal(certificate.publishedAt, "2026-07-17T00:02:00.000Z");
  setCertificateStatuses(db, [certificate.id], "draft", "2026-07-17T00:03:00.000Z");
  assert.equal(certificate.publishedAt, "");

  assert.equal(removeCertificate(db, certificate.id), certificate);
  assert.deepEqual(db.certificates, []);
  assert.throws(() => removeCertificate(db, certificate.id), (error) => error.status === 404);
});

test("certificate service rejects publishing any cleaned or fileless certificate without partially changing a bulk request", () => {
  const db = {
    certificates: [
      {
        id: "C-READY", registrationId: "R1", slot: 1, title: "ready", fileName: "ready.png", storedName: "ready.png",
        filePath: "/safe/ready.png", status: "draft", cleanedAt: ""
      },
      {
        id: "C-CLEANED", registrationId: "R2", slot: 1, title: "cleaned", fileName: "cleaned.png", storedName: "cleaned.png",
        filePath: "/safe/cleaned.png", status: "draft", cleanedAt: "2026-07-18T00:00:00.000Z"
      },
      {
        id: "C-FILELESS", registrationId: "R3", slot: 1, title: "fileless", fileName: "", storedName: "",
        filePath: "", status: "draft", cleanedAt: ""
      }
    ]
  };
  const before = structuredClone(db.certificates);

  for (const invalidId of ["C-CLEANED", "C-FILELESS"]) {
    assert.throws(() => setCertificateStatuses(db, ["C-READY", invalidId], "published", "2026-07-18T01:00:00.000Z"), (error) => error.status === 409);
    assert.deepEqual(db.certificates, before);
  }
});
