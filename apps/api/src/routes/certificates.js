import path from "node:path";

import express from "express";
import multer from "multer";

import { deletePrivateFile, readPrivateFile, saveCertificateFile } from "../files/storage.js";
import {
  CertificateError,
  removeCertificate,
  setCertificateStatuses,
  updateCertificateMetadata,
  upsertCertificate
} from "../services/certificates.js";

export const defaultCertificateStorage = {
  saveFile: saveCertificateFile,
  deleteFile: deletePrivateFile,
  readFile: readPrivateFile
};

const MIME_BY_EXTENSION = new Map([
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"]
]);

function cleanupMarker({ makeId, filePath, category, now, attempts = 0, error = "pending cleanup" }) {
  return {
    id: makeId("CLN"),
    filePath,
    category,
    attempts,
    lastError: String(error?.message || error),
    createdAt: now(),
    lastAttemptAt: now()
  };
}

async function bestEffortDelete(storage, file) {
  let lastError;
  for (let attempts = 1; attempts <= 3; attempts += 1) {
    try {
      await storage.deleteFile(file);
      return { removed: true, attempts };
    } catch (error) {
      if (error?.code === "ENOENT") return { removed: true, attempts };
      lastError = error;
    }
  }
  return { removed: false, attempts: 3, error: lastError };
}

async function persistOrphanJournal({ store, originalDb, file, category, result, makeId, now }) {
  if (!file?.filePath || result.removed) return;
  const rollback = structuredClone(originalDb);
  rollback.fileCleanupJournal ||= [];
  rollback.fileCleanupJournal.push(cleanupMarker({
    makeId,
    filePath: file.filePath,
    category,
    now,
    attempts: result.attempts + Number(file.cleanupAttempts || 0),
    error: result.error
  }));
  try { await store.writeDb(rollback); } catch { /* the primary persistence error remains authoritative */ }
}

async function finishCommittedCleanup({ store, db, marker, file, storage, now }) {
  if (!marker || !file?.filePath) return;
  const result = await bestEffortDelete(storage, file);
  if (result.removed) {
    db.fileCleanupJournal = db.fileCleanupJournal.filter((row) => row.id !== marker.id);
  } else {
    marker.attempts += result.attempts;
    marker.lastError = String(result.error?.message || result.error);
    marker.lastAttemptAt = now();
  }
  try { await store.writeDb(db); } catch { /* the committed marker remains safe to replay */ }
}

function certificatePayload(certificate, registration, { includePrivate = false } = {}) {
  const payload = {
    id: certificate.id,
    registrationId: certificate.registrationId,
    slot: certificate.slot,
    title: certificate.title,
    userId: certificate.userId,
    organizationId: certificate.organizationId,
    fileName: certificate.fileName,
    storedName: certificate.storedName,
    filePath: certificate.filePath,
    awardName: certificate.awardName,
    rank: certificate.rank,
    score: certificate.score,
    status: certificate.status,
    source: certificate.source,
    importBatchId: certificate.importBatchId,
    uploadedAt: certificate.uploadedAt,
    publishedAt: certificate.publishedAt,
    cleanedAt: certificate.cleanedAt,
    updatedAt: certificate.updatedAt,
    registration,
    athlete: registration?.athlete,
    projectName: registration?.projectName,
    organization: registration?.organization || "",
    previewUrl: `/api/certificates/${certificate.id}/file`,
    downloadUrl: `/api/certificates/${certificate.id}/file?download=1`
  };
  if (includePrivate) return payload;
  const { filePath, storedName, ...safe } = payload;
  return safe;
}

function isOperationalOrganization(db, organizationId) {
  const organization = db.organizations.find((row) => row.id === organizationId);
  return organization?.status === "active" && organization.reviewStatus === "approved";
}

function canManageOrganization(db, userId, organizationId) {
  if (!isOperationalOrganization(db, organizationId)) return false;
  const membership = db.memberships.find((row) =>
    row.userId === userId
    && row.organizationId === organizationId
    && row.status === "active"
  );
  return ["owner", "manager"].includes(membership?.role);
}

function activeMemberIds(db, organizationId) {
  return new Set(db.memberships
    .filter((row) => row.organizationId === organizationId && row.status === "active" && row.userId)
    .map((row) => row.userId));
}

function canReadCertificate(db, user, certificate) {
  if (user.type === "admin") return true;
  if (certificate.status !== "published") return false;
  const registration = db.registrations.find((row) => row.id === certificate.registrationId);
  if (!registration) return false;
  if (registration.userId === user.id) return true;
  if (!registration.organizationId || !canManageOrganization(db, user.id, registration.organizationId)) return false;
  return activeMemberIds(db, registration.organizationId).has(registration.userId);
}

function extensionFor(certificate) {
  return path.extname(certificate.storedName || certificate.fileName || "").slice(1).toLowerCase();
}

function encodedFileName(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function contentDisposition(disposition, fileName) {
  const fallback = fileName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 180) || "certificate";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodedFileName(fileName)}`;
}

function uploadError(error) {
  if (error?.status) return error;
  if (/^(A non-empty|File exceeds|Unsupported file signature|Invalid PDF signature)/.test(String(error?.message || ""))) {
    error.status = 422;
  }
  return error;
}

function fileNotFoundError(error) {
  return error?.code === "ENOENT" || /escapes upload root|symbolic link|changed during validation/i.test(String(error?.message || ""));
}

export function createCertificatesRouter({
  store,
  requireUser,
  requireAdmin,
  requirePasswordReady,
  asyncRoute,
  mutationAsyncRoute = asyncRoute,
  makeId,
  now,
  storage = defaultCertificateStorage
}) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  const admin = [requireAdmin, requirePasswordReady];
  const user = [requireUser, requirePasswordReady];
  const uploadOne = (req, res, next) => upload.single("certificate")(req, res, (error) => {
    if (!error) return next();
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    return res.status(tooLarge ? 413 : 422).json({
      error: tooLarge ? "证书文件不能超过 10 MB" : "证书文件上传无效"
    });
  });

  router.post("/admin/registrations/:id/certificates/:slot", ...admin, uploadOne, mutationAsyncRoute(async (req, res) => {
    const originalDb = await store.readDb();
    const db = structuredClone(originalDb);
    const registration = db.registrations.find((row) => row.id === req.params.id);
    if (!registration) throw new CertificateError(404, "报名记录不存在");
    if (!req.file) throw new CertificateError(422, "证书文件不能为空");

    const slot = Number(req.params.slot);
    if (![1, 2].includes(slot)) throw new CertificateError(422, "证书位置只能为 1 或 2");
    const previous = db.certificates.find((row) => row.registrationId === registration.id && Number(row.slot) === slot);
    const previousFile = previous?.filePath ? { filePath: previous.filePath } : null;
    let stored;
    try {
      stored = await storage.saveFile({ registrationId: registration.id, slot, file: req.file });
      const certificate = upsertCertificate(db, {
        registration,
        slot,
        title: req.body.title,
        storedFile: stored,
        source: "manual",
        now: now()
      });
      let marker;
      if (previousFile) {
        marker = cleanupMarker({ makeId, filePath: previousFile.filePath, category: "certificate-manual-replaced", now });
        db.fileCleanupJournal.push(marker);
      }
      await store.writeDb(db);
      await finishCommittedCleanup({ store, db, marker, file: previousFile, storage, now });
      res.status(201).json({ row: certificatePayload(certificate, registration, { includePrivate: true }) });
    } catch (error) {
      const orphan = stored || error.cleanupTarget;
      if (orphan?.filePath) {
        const result = await bestEffortDelete(storage, orphan);
        await persistOrphanJournal({
          store,
          originalDb,
          file: orphan,
          category: "certificate-manual-new",
          result,
          makeId,
          now
        });
      }
      throw uploadError(error);
    }
  }));

  router.patch("/admin/certificates/:id", ...admin, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    const certificate = updateCertificateMetadata(db, {
      certificateId: req.params.id,
      title: req.body.title,
      awardName: req.body.awardName,
      rank: req.body.rank,
      score: req.body.score,
      now: now()
    });
    await store.writeDb(db);
    const registration = db.registrations.find((row) => row.id === certificate.registrationId);
    res.json({ row: certificatePayload(certificate, registration, { includePrivate: true }) });
  }));

  router.delete("/admin/certificates/:id", ...admin, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    const certificate = removeCertificate(db, req.params.id);
    const marker = cleanupMarker({ makeId, filePath: certificate.filePath, category: "certificate-manual-deleted", now });
    db.fileCleanupJournal.push(marker);
    await store.writeDb(db);
    await finishCommittedCleanup({ store, db, marker, file: certificate, storage, now });
    res.status(204).end();
  }));

  router.post("/admin/certificates/bulk-status", ...admin, mutationAsyncRoute(async (req, res) => {
    const db = await store.readDb();
    const rows = setCertificateStatuses(db, req.body.ids, req.body.status, now());
    await store.writeDb(db);
    res.json({
      rows: rows.map((certificate) => certificatePayload(
        certificate,
        db.registrations.find((row) => row.id === certificate.registrationId),
        { includePrivate: true }
      ))
    });
  }));

  router.get("/admin/certificates", ...admin, asyncRoute(async (_req, res) => {
    const db = await store.readDb();
    const rows = db.certificates
      .filter((certificate) => !certificate.cleanedAt)
      .map((certificate) => certificatePayload(
        certificate,
        db.registrations.find((row) => row.id === certificate.registrationId),
        { includePrivate: true }
      ));
    res.json({ rows });
  }));

  router.get("/me/certificates", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const rows = db.certificates
      .filter((certificate) => {
        if (certificate.cleanedAt || certificate.status !== "published") return false;
        return db.registrations.find((row) => row.id === certificate.registrationId)?.userId === req.user.id;
      })
      .map((certificate) => certificatePayload(certificate, db.registrations.find((row) => row.id === certificate.registrationId)));
    res.json({ rows });
  }));

  router.get("/organizations/:id/certificates", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    if (!canManageOrganization(db, req.user.id, req.params.id)) throw new CertificateError(403, "无权查看该组织证书");
    const memberIds = activeMemberIds(db, req.params.id);
    const registrationIds = new Set(db.registrations
      .filter((row) => row.organizationId === req.params.id && memberIds.has(row.userId))
      .map((row) => row.id));
    const rows = db.certificates
      .filter((certificate) => !certificate.cleanedAt && certificate.status === "published" && registrationIds.has(certificate.registrationId))
      .map((certificate) => certificatePayload(certificate, db.registrations.find((row) => row.id === certificate.registrationId)));
    res.json({ rows });
  }));

  router.get("/certificates/:id/file", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const certificate = db.certificates.find((row) => row.id === req.params.id);
    if (!certificate || certificate.cleanedAt) throw new CertificateError(404, "证书不存在");
    if (!canReadCertificate(db, req.user, certificate)) throw new CertificateError(403, "无权读取该证书");
    const registration = db.registrations.find((row) => row.id === certificate.registrationId);
    const extension = extensionFor(certificate);
    const mimeType = MIME_BY_EXTENSION.get(extension);
    if (!registration || !mimeType) throw new CertificateError(404, "证书不存在");
    let buffer;
    try {
      buffer = await storage.readFile(certificate);
    } catch (error) {
      if (fileNotFoundError(error)) throw new CertificateError(404, "证书文件不存在");
      throw error;
    }
    const downloadName = `${registration.athlete?.name || "运动员"}_${registration.projectName}_${certificate.title}.${extension}`;
    const disposition = ["1", "true"].includes(String(req.query.download || "").toLowerCase()) ? "attachment" : "inline";
    res
      .type(mimeType)
      .set("Cache-Control", "private, no-store")
      .set("Content-Disposition", contentDisposition(disposition, downloadName))
      .send(buffer);
  }));

  return router;
}
