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

const importError = (status, message) => new CertificateImportError(status, message);

function originalFileName(value) {
  const normalized = String(value || "certificates.xlsx").replace(/\\/g, "/");
  return path.posix.basename(normalized).slice(0, 255) || "certificates.xlsx";
}

function currentEventId(db, candidates) {
  return db.events.find((event) => event.isCurrent)?.id
    || db.registrations.find((registration) => candidates.some((candidate) => candidate.registrationId === registration.id))?.eventId
    || db.events[0]?.id;
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
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

async function bestEffortDeleteFiles(storage, files) {
  const failed = [];
  for (const file of files) {
    let removed = false;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
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
    if (!removed) failed.push({ file, error: lastError });
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

async function cleanupStagingOrJournal({ storage, batchId, relativePaths, store, db, makeId, now }) {
  const cleanup = await bestEffortRemoveStaging(storage, batchId);
  if (cleanup.ok) return;
  await persistCleanupJournal({
    store,
    db,
    entries: [...new Set(relativePaths)].map((relativePath) => ({
      filePath: storage.resolveStagingPath(batchId, relativePath),
      category: "certificate-import-staging",
      error: cleanup.error
    })),
    makeId,
    now
  });
}

export async function previewCertificateImport({
  file,
  userId,
  store,
  makeId,
  now,
  parseWorkbook = parseCertificateWorkbook,
  storage = defaultCertificateImportStorage
}) {
  if (!file?.buffer) throw importError(422, "请上传证书 Excel 工作簿");
  const db = await store.readDb();
  const rollbackDb = structuredClone(db);
  const parsed = await parseWorkbook(file.buffer, registrationsForParser(db));
  const batchId = makeId("CIB");
  const stagedCandidates = [];
  const stagedFiles = [];

  if (db.certificateImportBatches.some((batch) => batch.id === batchId)) {
    throw importError(409, "证书导入批次编号冲突，请重试");
  }
  if (storage.createStagingBatch) {
    try {
      await storage.createStagingBatch(batchId);
    } catch (error) {
      if (error?.code === "EEXIST") throw importError(409, "证书导入批次编号冲突，请重试");
      throw error;
    }
  }

  try {
    for (const candidate of parsed.candidates) {
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
        stagedFiles.push(staged.relativePath);
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
        certificates
      });
    }
  } catch (error) {
    if (error.cleanupTarget?.relativePath) stagedFiles.push(error.cleanupTarget.relativePath);
    await cleanupStagingOrJournal({ storage, batchId, relativePaths: stagedFiles, store, db: rollbackDb, makeId, now });
    throw error;
  }

  const eventId = currentEventId(db, stagedCandidates);
  if (!eventId) {
    await cleanupStagingOrJournal({ storage, batchId, relativePaths: stagedFiles, store, db: rollbackDb, makeId, now });
    throw importError(422, "没有可用于导入证书的赛事");
  }
  const createdAt = now();
  const batch = {
    id: batchId,
    eventId,
    createdBy: userId,
    originalName: originalFileName(file.originalname),
    status: "preview",
    previewJson: stagedCandidates,
    validCount: stagedCandidates.length,
    errorCount: parsed.errors.length,
    replaceCount: stagedCandidates.reduce((total, candidate) => total + candidate.certificates.filter((certificate) => certificate.replacing).length, 0),
    createdAt,
    committedAt: null
  };
  const errors = parsed.errors.map((error) => ({
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
    await cleanupStagingOrJournal({ storage, batchId, relativePaths: stagedFiles, store, db: rollbackDb, makeId, now });
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
    marker.attempts = 3;
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

export async function commitCertificateImport({
  batchId,
  store,
  makeId,
  now,
  storage = defaultCertificateImportStorage
}) {
  const originalDb = await store.readDb();
  const sourceBatch = batchOrError(originalDb, batchId);
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
    await store.writeDb(db);
  } catch (error) {
    if (error.cleanupTarget?.filePath && !savedFiles.some((file) => file.filePath === error.cleanupTarget.filePath)) {
      savedFiles.push(error.cleanupTarget);
    }
    const failed = await bestEffortDeleteFiles(storage, savedFiles);
    await persistCleanupJournal({
      store,
      db: originalDb,
      entries: failed.map(({ file, error: cleanupError }) => ({
        filePath: file.filePath,
        category: "certificate-import-new",
        error: cleanupError
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
