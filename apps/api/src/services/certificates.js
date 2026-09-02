import crypto from "node:crypto";

export class CertificateError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const invalid = (message) => new CertificateError(422, message);

function requiredTitle(value) {
  const title = String(value ?? "").trim();
  if (!title) throw invalid("证书标题不能为空");
  return title;
}

function validSlot(value) {
  const slot = Number(value);
  if (![1, 2].includes(slot)) throw invalid("证书位置只能为 1 或 2");
  return slot;
}

function certificateOrError(db, certificateId) {
  const certificate = db.certificates.find((row) => row.id === certificateId);
  if (!certificate) throw new CertificateError(404, "证书不存在");
  return certificate;
}

function optionalText(value, fallback) {
  return value === undefined ? fallback : String(value ?? "").trim();
}

export function upsertCertificate(db, {
  registration,
  participantId: inputParticipantId = null,
  slot: inputSlot,
  title: inputTitle,
  storedFile,
  source,
  importBatchId = null,
  now
}) {
  const slot = validSlot(inputSlot);
  const title = requiredTitle(inputTitle);
  if (!registration) throw new CertificateError(404, "报名记录不存在");
  if (!storedFile?.filePath || !storedFile?.storedName) throw invalid("证书文件不能为空");
  const participantId = String(inputParticipantId || "").trim() || null;
  if (registration.projectType === "team") {
    const participants = (db.registrationParticipants || []).filter((row) => row.registrationId === registration.id);
    if (!participantId && participants.length > 0) throw invalid("团队证书必须选择队员");
    const belongs = !participantId || participants.some((row) => (
      row.id === participantId && row.registrationId === registration.id
    ));
    if (!belongs) throw invalid("证书对象不属于该报名");
  } else if (participantId) {
    throw invalid("个人报名不能指定证书对象");
  }

  let certificate = db.certificates.find((row) => (
    row.registrationId === registration.id
    && (row.participantId || null) === participantId
    && Number(row.slot) === slot
  ));
  if (!certificate) {
    certificate = { id: `C${crypto.randomUUID()}`, registrationId: registration.id, participantId, slot };
    db.certificates.unshift(certificate);
  }

  Object.assign(certificate, {
    title,
    fileName: storedFile.originalName || storedFile.fileName,
    storedName: storedFile.storedName,
    filePath: storedFile.filePath,
    awardName: registration.awardName || "",
    rank: registration.rank || "",
    score: registration.score || "",
    status: "draft",
    source: source || "manual",
    importBatchId,
    uploadedAt: now,
    publishedAt: "",
    cleanedAt: ""
  });
  return certificate;
}

export function canReadCertificate(db, user, certificate) {
  if (user?.type === "admin") return true;
  if (certificate?.status !== "published") return false;
  const registration = db.registrations.find((row) => row.id === certificate.registrationId);
  if (!registration) return false;
  if (user?.type === "ordinary") return registration.personalUserId === user.id;
  if (user?.type !== "organization") return false;
  const organization = db.organizations.find((row) => row.ownerUserId === user.id);
  return Boolean(organization && registration.organizationId === organization.id);
}

export function updateCertificateMetadata(db, { certificateId, title, awardName, rank, score, now }) {
  const certificate = certificateOrError(db, certificateId);
  if (title !== undefined) certificate.title = requiredTitle(title);
  certificate.awardName = optionalText(awardName, certificate.awardName || "");
  certificate.rank = optionalText(rank, certificate.rank || "");
  certificate.score = optionalText(score, certificate.score || "");
  certificate.updatedAt = now;
  return certificate;
}

export function removeCertificate(db, certificateId) {
  const certificate = certificateOrError(db, certificateId);
  db.certificates.splice(db.certificates.indexOf(certificate), 1);
  return certificate;
}

export function setCertificateStatuses(db, ids, status, now) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || !id.trim())) {
    throw invalid("请选择需要更新的证书");
  }
  if (!new Set(["draft", "published"]).has(status)) throw invalid("证书状态只能为 draft 或 published");
  const uniqueIds = [...new Set(ids)];
  const rows = uniqueIds.map((certificateId) => certificateOrError(db, certificateId));
  if (status === "published") {
    const invalidTarget = rows.find((certificate) => certificate.cleanedAt
      || !String(certificate.filePath || "").trim()
      || !String(certificate.storedName || "").trim()
      || !String(certificate.fileName || "").trim());
    if (invalidTarget) {
      throw new CertificateError(409, "已清理或缺少文件的证书不能发布");
    }
  }
  for (const certificate of rows) {
    certificate.status = status;
    certificate.publishedAt = status === "published" ? now : "";
  }
  return rows;
}
