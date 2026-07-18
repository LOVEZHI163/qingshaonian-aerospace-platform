import path from "node:path";

import { parseCertificateWorkbook } from "../certificates/workbook-parser.js";
import {
  createImportStagingBatch,
  deletePrivateFile,
  readImportStagingFile,
  removeImportStagingBatch,
  resolveImportStagingPath,
  saveCertificateImportFile,
  saveImportStagingFile
} from "../files/storage.js";
import { recordAudit } from "./audit.js";

export class CertificateImportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const defaultCertificateImportStorage = {
  createStagingBatch: createImportStagingBatch,
  saveStagingFile: saveImportStagingFile,
  readStagingFile: readImportStagingFile,
  removeStagingBatch: removeImportStagingBatch,
  resolveStagingPath: resolveImportStagingPath,
  saveCertificateFile: saveCertificateImportFile,
  deleteFile: deletePrivateFile
};

export const CERTIFICATE_IMPORT_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

const importError = (status, message) => new CertificateImportError(status, message);

function originalFileName(value) {
  const normalized = String(value || "certificates.xlsx").replace(/\\/g, "/");
  const base = path.posix.basename(normalized)
    .replace(/[\x00-\x1f<>:"|?*]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 255);
  return base || "certificates.xlsx";
}

function eventIdForCandidates(db, candidates) {
  const registrationById = new Map(db.registrations.map((registration) => [registration.id, registration]));
  const eventIds = new Set(candidates.map((candidate) => registrationById.get(candidate.registrationId)?.eventId).filter(Boolean));
  if (eventIds.size !== 1) {
    throw importError(422, eventIds.size > 1 ? "同一导入批次不能包含多个赛事" : "无法从有效报名记录确定导入赛事");
  }
  return [...eventIds][0];
}

function hasValidCertificateSlots(candidate) {
  const slots = (candidate.certificates || []).map((certificate) => Number(certificate.slot)).sort();
  return slots.length >= 1
    && slots.length <= 2
    && new Set(slots).size === slots.length
    && slots.every((slot) => slot === 1 || slot === 2);
}

function candidateValidation(parsedCandidates) {
  const counts = parsedCandidates.reduce((byRegistration, candidate) => {
    byRegistration.set(candidate.registrationId, (byRegistration.get(candidate.registrationId) || 0) + 1);
    return byRegistration;
  }, new Map());
  const candidates = [];
  const errors = [];
  for (const candidate of parsedCandidates) {
    if (counts.get(candidate.registrationId) > 1) {
      errors.push({ rowNumber: candidate.rowNumber, registrationId: candidate.registrationId, message: "同一报名编号只能出现一行" });
    } else if (!hasValidCertificateSlots(candidate)) {
      errors.push({ rowNumber: candidate.rowNumber, registrationId: candidate.registrationId, message: "每行必须提供不重复的证书位置 1 或 2" });
    } else {
      candidates.push(candidate);
    }
  }
  return { candidates, errors };
}

function selectedEventOrError(db, eventId) {
  if (!eventId) return null;
  const event = db.events.find((row) => row.id === eventId);
  if (!event) throw importError(422, "Selected event does not exist");
  return event;
}

function candidatesForSelectedEvent(db, candidates, eventId) {
  if (!eventId) return { candidates, errors: [] };
  const registrations = new Map(db.registrations.map((registration) => [registration.id, registration]));
  const accepted = [];
  const errors = [];
  for (const candidate of candidates) {
    if (registrations.get(candidate.registrationId)?.eventId !== eventId) {
      errors.push({
        rowNumber: candidate.rowNumber,
        registrationId: candidate.registrationId,
        message: "Registration does not belong to the selected event"
      });
      continue;
    }
    accepted.push(candidate);
  }
  return { candidates: accepted, errors };
}

function certificateState(certificate) {
  if (!certificate) return { state: "missing" };
  return {
    state: "existing",
    id: String(certificate.id || ""),
    version: [
      certificate.id,
      certificate.slot,
      certificate.title,
      certificate.fileName,
      certificate.storedName,
      certificate.filePath,
      certificate.status,
      certificate.source,
      certificate.importBatchId,
      certificate.uploadedAt,
      certificate.publishedAt,
      certificate.cleanedAt,
      certificate.updatedAt
    ].map((value) => String(value ?? "")).join("|")
  };
}

function expectedCertificateStates(db, candidate) {
  return Object.fromEntries((candidate.certificates || []).map((certificate) => [
    String(certificate.slot),
    certificateState(db.certificates.find((row) => row.registrationId === candidate.registrationId && Number(row.slot) === Number(certificate.slot)))
  ]));
}

function sameCertificateState(left, right) {
  return left?.state === right?.state
    && left?.id === right?.id
    && left?.version === right?.version;
}

function publicCandidate(batchId, candidate) {
  return {
    rowNumber: candidate.rowNumber,
    registrationId: candidate.registrationId,
    athleteName: candidate.athleteName,
    projectName: candidate.projectName,
    result: { ...candidate.result },
    certificates: candidate.certificates.map((certificate) => ({
      slot: certificate.slot,
      title: certificate.title,
      mimeType: certificate.mimeType,
      replacing: certificate.replacing,
      previewUrl: `/api/admin/certificate-imports/${batchId}/previews/${candidate.rowNumber}/${certificate.slot}`
    }))
  };
}

export function publicCertificateImportPreview(batch, errors = []) {
  return {
    id: batch.id,
    status: batch.status,
    originalName: batch.originalName,
    validCount: batch.validCount,
    errorCount: batch.errorCount,
    replaceCount: batch.replaceCount,
    createdAt: batch.createdAt,
    candidates: batch.previewJson.map((candidate) => publicCandidate(batch.id, candidate)),
    errors: errors.map(({ rowNumber, registrationId, message }) => ({ rowNumber, registrationId, message }))
  };
}

async function bestEffortRemoveStaging(storage, batchId) {
  try {
    await storage.removeStagingBatch(batchId);
    return { ok: true, attempts: 1 };
  } catch (error) {
    return { ok: false, error, attempts: 1 };
  }
}

async function bestEffortDeleteFiles(storage, files) {
  const failed = [];
  for (const file of files) {
    let removed = false;
    let lastError;
    let attempts = Number(file.cleanupAttempts || 0);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      attempts += 1;
      try {
        await storage.deleteFile(file);
        removed = true;
        break;
      } catch (error) {
        if (error?.code === "ENOENT") {
          removed = true;
          break;
        }
        lastError = error;
      }
    }
    if (!removed) failed.push({ file, error: lastError, attempts });
  }
  return failed;
}

function registrationsForParser(db) {
  return db.registrations.map((registration) => ({
    ...registration,
    certificates: db.certificates
      .filter((certificate) => certificate.registrationId === registration.id)
      .map((certificate) => ({ slot: certificate.slot }))
  }));
}

async function cleanupStagingOrJournal({ storage, batchId, stagedFiles, store, db, makeId, now }) {
  const cleanup = await bestEffortRemoveStaging(storage, batchId);
  if (cleanup.ok) return;
  const targets = new Map();
  for (const target of stagedFiles) {
    const normalized = typeof target === "string" ? { relativePath: target, cleanupAttempts: 0 } : target;
    const previous = targets.get(normalized.relativePath);
    if (!previous || Number(normalized.cleanupAttempts || 0) > Number(previous.cleanupAttempts || 0)) {
      targets.set(normalized.relativePath, normalized);
    }
  }
  await persistCleanupJournal({
    store,
    db,
    entries: [...targets.values()].map((target) => ({
      filePath: storage.resolveStagingPath(batchId, target.relativePath),
      category: "certificate-import-staging",
      error: cleanup.error,
      attempts: Number(target.cleanupAttempts || 0) + cleanup.attempts
    })),
    makeId,
    now
  });
}

export async function previewCertificateImport({
  file,
  eventId,
  userId,
  store,
  makeId,
  now,
  parseWorkbook = parseCertificateWorkbook,
  storage = defaultCertificateImportStorage
}) {
  if (!file?.buffer) throw importError(422, "请上传证书 Excel 工作簿");
  const sanitizedName = originalFileName(file.originalname);
  if (!sanitizedName.toLowerCase().endsWith(".xlsx")) {
    throw importError(422, "Certificate imports require a .xlsx file");
  }
  await cleanupExpiredCertificateImportPreviews({ store, makeId, now, storage });
  const db = await store.readDb();
  const rollbackDb = structuredClone(db);
  const selectedEvent = selectedEventOrError(db, String(eventId || "").trim());
  const parsed = await parseWorkbook(file.buffer, registrationsForParser(db));
  const validation = candidateValidation(parsed.candidates);
  const eventValidation = candidatesForSelectedEvent(db, validation.candidates, selectedEvent?.id);
  const validCandidates = eventValidation.candidates;
  const batchEventId = selectedEvent?.id || eventIdForCandidates(db, validCandidates.length ? validCandidates : parsed.candidates);
  const parsedErrors = [...parsed.errors, ...validation.errors, ...eventValidation.errors];
  const batchId = makeId("CIB");
  const stagedCandidates = [];
  const stagedFiles = [];

  if (db.certificateImportBatches.some((batch) => batch.id === batchId)) {
    throw importError(409, "证书导入批次编号冲突，请重试");
  }
  if (validCandidates.length && storage.createStagingBatch) {
    try {
      await storage.createStagingBatch(batchId);
    } catch (error) {
      if (error?.code === "EEXIST") throw importError(409, "证书导入批次编号冲突，请重试");
      throw error;
    }
  }

  try {
    for (const candidate of validCandidates) {
      const registration = db.registrations.find((row) => row.id === candidate.registrationId);
      const certificates = [];
      for (const certificate of candidate.certificates) {
        const staged = await storage.saveStagingFile({
          batchId,
          rowNumber: candidate.rowNumber,
          slot: certificate.slot,
          extension: certificate.extension,
          buffer: certificate.buffer
        });
        stagedFiles.push({ relativePath: staged.relativePath, cleanupAttempts: 0 });
        certificates.push({
          slot: certificate.slot,
          title: certificate.title,
          extension: certificate.extension,
          mimeType: certificate.mimeType,
          replacing: certificate.replacing,
          relativePath: staged.relativePath
        });
      }
      stagedCandidates.push({
        rowNumber: candidate.rowNumber,
        registrationId: candidate.registrationId,
        athleteName: registration?.athlete?.name || "",
        projectName: registration?.projectName || "",
        result: { ...candidate.result },
        expectedCertificateStates: expectedCertificateStates(db, candidate),
        certificates
      });
    }
  } catch (error) {
    if (error.cleanupTarget?.relativePath) stagedFiles.push({
      relativePath: error.cleanupTarget.relativePath,
      cleanupAttempts: Number(error.cleanupTarget.cleanupAttempts || 0)
    });
    await cleanupStagingOrJournal({ storage, batchId, stagedFiles, store, db: rollbackDb, makeId, now });
    throw error;
  }

  const createdAt = now();
  const batch = {
    id: batchId,
    eventId: batchEventId,
    createdBy: userId,
    originalName: sanitizedName,
    status: "preview",
    previewJson: stagedCandidates,
    validCount: stagedCandidates.length,
    errorCount: parsedErrors.length,
    replaceCount: stagedCandidates.reduce((total, candidate) => total + candidate.certificates.filter((certificate) => certificate.replacing).length, 0),
    createdAt,
    committedAt: null
  };
  const errors = parsedErrors.map((error) => ({
    id: makeId("CIE"),
    batchId,
    rowNumber: error.rowNumber,
    registrationId: error.registrationId || null,
    message: error.message
  }));
  db.certificateImportBatches.push(batch);
  db.certificateImportErrors.push(...errors);
  try {
    await store.writeDb(db);
  } catch (error) {
    await cleanupStagingOrJournal({ storage, batchId, stagedFiles, store, db: rollbackDb, makeId, now });
    throw error;
  }
  return publicCertificateImportPreview(batch, errors);
}

function cleanupMarker({ makeId, filePath, category, now }) {
  return {
    id: makeId("CLN"),
    filePath,
    category,
    attempts: 0,
    lastError: "pending cleanup",
    createdAt: now(),
    lastAttemptAt: now()
  };
}

async function persistCleanupJournal({ store, db, entries, makeId, now }) {
  if (!entries.length) return;
  const rollback = structuredClone(db);
  rollback.fileCleanupJournal ||= [];
  for (const entry of entries) {
    const marker = cleanupMarker({ makeId, filePath: entry.filePath, category: entry.category, now });
    marker.attempts = Number(entry.attempts || 0);
    marker.lastError = String(entry.error?.message || entry.error || "cleanup failed");
    rollback.fileCleanupJournal.push(marker);
  }
  try { await store.writeDb(rollback); } catch { /* primary persistence failure remains authoritative */ }
}

function batchOrError(db, batchId) {
  const batch = db.certificateImportBatches.find((row) => row.id === batchId);
  if (!batch) throw importError(404, "证书导入批次不存在");
  if (batch.status !== "preview") throw importError(409, "证书导入批次已处理");
  return batch;
}

function assertCommitCandidates(db, batch) {
  const seen = new Set();
  for (const candidate of batch.previewJson) {
    if (seen.has(candidate.registrationId) || !hasValidCertificateSlots(candidate)) {
      throw importError(409, "证书导入批次预览数据无效");
    }
    seen.add(candidate.registrationId);
    const expected = candidate.expectedCertificateStates;
    if (!expected || typeof expected !== "object") {
      throw importError(409, "Certificate import preview is stale; run preview again");
    }
    for (const certificate of candidate.certificates) {
      const slot = String(certificate.slot);
      if (!Object.hasOwn(expected, slot)) {
        throw importError(409, "Certificate import preview is stale; run preview again");
      }
      const current = certificateState(db.certificates.find((row) =>
        row.registrationId === candidate.registrationId && Number(row.slot) === Number(certificate.slot)
      ));
      if (!sameCertificateState(expected[slot], current)) {
        throw importError(409, "Certificate import preview is stale; run preview again");
      }
    }
    const registration = db.registrations.find((row) => row.id === candidate.registrationId);
    if (!registration || registration.status !== "approved" || registration.eventId !== batch.eventId) {
      throw importError(409, `报名记录 ${candidate.registrationId} 已不再满足导入条件`);
    }
  }
}

async function finishCleanup({ store, db, markers, oldFiles, batchId, storage, now }) {
  const completed = new Set();
  let changed = false;
  for (const { marker, file } of oldFiles) {
    try {
      await storage.deleteFile(file);
      completed.add(marker.id);
    } catch (error) {
      if (error?.code === "ENOENT") completed.add(marker.id);
      else {
        marker.attempts += 1;
        marker.lastError = String(error?.message || error);
        marker.lastAttemptAt = now();
        changed = true;
      }
    }
  }

  const stagingMarkers = markers.filter((marker) => marker.category === "certificate-import-staging");
  try {
    await storage.removeStagingBatch(batchId);
    for (const marker of stagingMarkers) completed.add(marker.id);
  } catch (error) {
    for (const marker of stagingMarkers) {
      marker.attempts += 1;
      marker.lastError = String(error?.message || error);
      marker.lastAttemptAt = now();
      changed = true;
    }
  }

  if (!completed.size && !changed) return;
  db.fileCleanupJournal = db.fileCleanupJournal.filter((marker) => !completed.has(marker.id));
  try { await store.writeDb(db); } catch { /* persisted markers safely replay missing files */ }
}

function isExpiredPreview(batch, nowValue) {
  if (batch.status !== "preview") return false;
  const createdAt = Date.parse(batch.createdAt || "");
  const current = Date.parse(nowValue);
  return Number.isFinite(createdAt) && Number.isFinite(current)
    && current - createdAt >= CERTIFICATE_IMPORT_PREVIEW_TTL_MS;
}

export async function cleanupExpiredCertificateImportPreviews({
  store,
  makeId,
  now,
  storage = defaultCertificateImportStorage
}) {
  const originalDb = await store.readDb();
  const timestamp = now();
  const expiredIds = originalDb.certificateImportBatches
    .filter((batch) => isExpiredPreview(batch, timestamp))
    .map((batch) => batch.id);
  if (!expiredIds.length) return [];

  const db = structuredClone(originalDb);
  const cleanups = [];
  for (const batch of db.certificateImportBatches) {
    if (!expiredIds.includes(batch.id)) continue;
    const markers = batch.previewJson.flatMap((candidate) => candidate.certificates.map((certificate) => cleanupMarker({
      makeId,
      filePath: storage.resolveStagingPath(batch.id, certificate.relativePath),
      category: "certificate-import-staging",
      now
    })));
    db.fileCleanupJournal ||= [];
    db.fileCleanupJournal.push(...markers);
    batch.status = "expired";
    batch.previewJson = [];
    cleanups.push({ batchId: batch.id, markers });
  }
  await store.writeDb(db);
  for (const cleanup of cleanups) {
    await finishCleanup({
      store,
      db,
      markers: cleanup.markers,
      oldFiles: [],
      batchId: cleanup.batchId,
      storage,
      now
    });
  }
  return expiredIds;
}

export async function listActiveCertificateImportPreviews({
  eventId,
  store,
  makeId,
  now,
  storage = defaultCertificateImportStorage
}) {
  const selectedEventId = String(eventId || "").trim();
  if (!selectedEventId) throw importError(422, "请选择赛事");
  await store.withMutationLock(() => cleanupExpiredCertificateImportPreviews({
    store,
    makeId,
    now,
    storage
  }));
  const db = await store.readDb();
  selectedEventOrError(db, selectedEventId);
  return db.certificateImportBatches
    .filter((batch) => batch.status === "preview" && batch.eventId === selectedEventId)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.id).localeCompare(String(left.id)))
    .map((batch) => publicCertificateImportPreview(
      batch,
      db.certificateImportErrors.filter((error) => error.batchId === batch.id)
    ));
}

export async function commitCertificateImport({
  batchId,
  store,
  makeId,
  now,
  actor,
  storage = defaultCertificateImportStorage
}) {
  const originalDb = await store.readDb();
  const sourceBatch = batchOrError(originalDb, batchId);
  assertCommitCandidates(originalDb, sourceBatch);
  const db = structuredClone(originalDb);
  const batch = db.certificateImportBatches.find((row) => row.id === batchId);
  const savedFiles = [];
  const oldFiles = [];
  const markers = [];
  let createdCount = 0;
  let replacedCount = 0;

  try {
    for (const candidate of batch.previewJson) {
      const registration = db.registrations.find((row) => row.id === candidate.registrationId);
      if (!registration || registration.status !== "approved") {
        throw importError(409, `报名记录 ${candidate.registrationId} 已不再满足导入条件`);
      }

      const prepared = [];
      for (const certificate of candidate.certificates) {
        const buffer = await storage.readStagingFile({ batchId, relativePath: certificate.relativePath });
        const stored = await storage.saveCertificateFile({
          registrationId: registration.id,
          slot: certificate.slot,
          extension: certificate.extension,
          buffer
        });
        savedFiles.push(stored);
        prepared.push({ certificate, stored });
      }

      const recordedAt = now();
      registration.awardName = candidate.result.awardName || "";
      registration.rank = candidate.result.rank || "";
      registration.score = candidate.result.score || "";
      registration.resultRecordedAt = recordedAt;
      registration.updatedAt = recordedAt;

      for (const { certificate, stored } of prepared) {
        let row = db.certificates.find((item) => item.registrationId === registration.id && Number(item.slot) === certificate.slot);
        if (row) {
          const marker = cleanupMarker({ makeId, filePath: row.filePath, category: "certificate-import-replaced", now });
          markers.push(marker);
          oldFiles.push({ marker, file: { filePath: row.filePath } });
          replacedCount += 1;
        } else {
          row = { id: makeId("C"), registrationId: registration.id, slot: certificate.slot };
          db.certificates.unshift(row);
          createdCount += 1;
        }
        Object.assign(row, {
          title: certificate.title,
          userId: registration.userId || null,
          organizationId: registration.organizationId || null,
          fileName: stored.fileName,
          storedName: stored.storedName,
          filePath: stored.filePath,
          awardName: registration.awardName,
          rank: registration.rank,
          score: registration.score,
          status: "draft",
          source: "import",
          importBatchId: batchId,
          uploadedAt: recordedAt,
          publishedAt: "",
          cleanedAt: ""
        });
      }
    }

    for (const candidate of batch.previewJson) {
      for (const certificate of candidate.certificates) {
        markers.push(cleanupMarker({
          makeId,
          filePath: storage.resolveStagingPath(batchId, certificate.relativePath),
          category: "certificate-import-staging",
          now
        }));
      }
    }
    db.fileCleanupJournal.push(...markers);
    batch.status = "committed";
    batch.committedAt = now();
    batch.previewJson = [];
    recordAudit(db, {
      actor,
      action: "certificate-import.commit",
      targetType: "certificate-import",
      targetId: batch.id,
      summary: `提交证书导入：新增 ${createdCount} 张，替换 ${replacedCount} 张`,
      createdAt: batch.committedAt
    });
    await store.writeDb(db);
  } catch (error) {
    if (error.cleanupTarget?.filePath && !savedFiles.some((file) => file.filePath === error.cleanupTarget.filePath)) {
      savedFiles.push(error.cleanupTarget);
    }
    const failed = await bestEffortDeleteFiles(storage, savedFiles);
    await persistCleanupJournal({
      store,
      db: originalDb,
      entries: failed.map(({ file, error: cleanupError, attempts }) => ({
        filePath: file.filePath,
        category: "certificate-import-new",
        error: cleanupError,
        attempts
      })),
      makeId,
      now
    });
    throw error;
  }

  await finishCleanup({ store, db, markers, oldFiles, batchId, storage, now });
  return { id: sourceBatch.id, status: "committed", createdCount, replacedCount };
}

export async function cancelCertificateImport({ batchId, store, makeId, now, storage = defaultCertificateImportStorage }) {
  const originalDb = await store.readDb();
  batchOrError(originalDb, batchId);
  const db = structuredClone(originalDb);
  const batch = db.certificateImportBatches.find((row) => row.id === batchId);
  const markers = batch.previewJson.flatMap((candidate) => candidate.certificates.map((certificate) => cleanupMarker({
    makeId,
    filePath: storage.resolveStagingPath(batchId, certificate.relativePath),
    category: "certificate-import-staging",
    now
  })));
  db.fileCleanupJournal.push(...markers);
  batch.status = "cancelled";
  batch.previewJson = [];
  await store.writeDb(db);
  await finishCleanup({ store, db, markers, oldFiles: [], batchId, storage, now });
}

export async function loadCertificateImportPreview({ batchId, rowNumber, slot, store, storage = defaultCertificateImportStorage }) {
  const db = await store.readDb();
  const batch = db.certificateImportBatches.find((row) => row.id === batchId && row.status === "preview");
  const candidate = batch?.previewJson.find((row) => Number(row.rowNumber) === Number(rowNumber));
  const certificate = candidate?.certificates.find((row) => Number(row.slot) === Number(slot));
  if (!certificate) throw importError(404, "证书预览不存在");
  try {
    const buffer = await storage.readStagingFile({ batchId, relativePath: certificate.relativePath });
    return { buffer, mimeType: certificate.mimeType };
  } catch (error) {
    const unsafePath = /(?:path|component).*(?:invalid|escapes|symbolic link|changed)/i.test(String(error?.message || ""));
    if (error?.code === "ENOENT" || unsafePath) throw importError(404, "证书预览不存在");
    throw error;
  }
}

export async function loadCertificateImportErrors({ batchId, store }) {
  const db = await store.readDb();
  const batch = db.certificateImportBatches.find((row) => row.id === batchId);
  if (!batch) throw importError(404, "证书导入批次不存在");
  const errors = db.certificateImportErrors.filter((row) => row.batchId === batchId);
  if (!errors.length) throw importError(404, "该导入批次没有错误报告");
  return { batch, errors };
}
