import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import * as certificateImports from "../src/services/certificate-imports.js";

import { buildCertificateTemplate } from "../src/certificates/template.js";
import {
  deletePrivateFile,
  readImportStagingFile,
  removeImportStagingBatch,
  resolveImportStagingPath,
  saveCertificateImportFile,
  saveImportStagingFile
} from "../src/files/storage.js";
import {
  cancelCertificateImport,
  commitCertificateImport,
  loadCertificateImportErrors,
  loadCertificateImportPreview,
  previewCertificateImport
} from "../src/services/certificate-imports.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const approvedRegistration = {
  id: "R20260627002",
  athlete: { name: "测试选手", school: "测试学校", grade: "初二" },
  group: "中学组",
  projectName: "无人机竞速接力比赛",
  instructor: "测试老师",
  status: "approved",
  awardName: "",
  rank: "",
  score: ""
};

function workbookForm(buffer, name = "certificates.xlsx", eventId = "wz-aerospace-2026") {
  const form = new FormData();
  form.append("workbook", new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }), name);
  form.append("eventId", eventId);
  return form;
}

async function addImage(workbook, sheet, rowNumber, column) {
  const imageId = workbook.addImage({ buffer: ONE_PIXEL_PNG, extension: "png" });
  sheet.addImage(imageId, {
    tl: { col: column - 1 + 0.1, row: rowNumber - 1 + 0.1 },
    ext: { width: 40, height: 40 }
  });
}

async function buildMixedWorkbook() {
  const workbook = await buildCertificateTemplate([
    approvedRegistration,
    { ...approvedRegistration, id: "R-UNKNOWN", athlete: { ...approvedRegistration.athlete, name: "未知选手" } }
  ]);
  const sheet = workbook.worksheets[0];

  sheet.getCell("I2").value = "一等奖";
  sheet.getCell("J2").value = "1";
  sheet.getCell("K2").value = "98.5";
  sheet.getCell("L2").value = "一等奖证书";
  sheet.getCell("N2").value = "优秀选手证书";
  await addImage(workbook, sheet, 2, 13);
  await addImage(workbook, sheet, 2, 15);

  sheet.getCell("L3").value = "未知报名证书";
  await addImage(workbook, sheet, 3, 13);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function readDb(dbPath) {
  return JSON.parse(await fs.readFile(dbPath, "utf8"));
}

async function previewWorkbook(baseUrl, cookie, buffer, name, eventId) {
  return fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/certificate-imports/preview`, withSession(cookie, {
    method: "POST",
    body: workbookForm(buffer, name, eventId)
  }));
}

test("certificate import preview keeps formal data unchanged, reports mixed rows, commits drafts, and detects replacements", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const workbook = await buildMixedWorkbook();

    const forbidden = await previewWorkbook(baseUrl, ordinary.cookie, workbook, "forbidden.xlsx");
    assert.equal(forbidden.status, 403);

    const previewResponse = await previewWorkbook(baseUrl, admin.cookie, workbook, "../mixed.xlsx");
    assert.equal(previewResponse.status, 201);
    const preview = await previewResponse.json();
    assert.equal(preview.status, "preview");
    assert.equal(preview.validCount, 1);
    assert.equal(preview.errorCount, 1);
    assert.equal(preview.replaceCount, 0);
    assert.equal(preview.candidates.length, 1);
    assert.deepEqual(Object.keys(preview.candidates[0]).sort(), [
      "athleteName", "certificates", "projectName", "registrationId", "result", "rowNumber"
    ]);
    assert.deepEqual(preview.candidates[0].certificates.map((certificate) => ({
      slot: certificate.slot,
      title: certificate.title,
      mimeType: certificate.mimeType,
      replacing: certificate.replacing,
      previewUrl: certificate.previewUrl
    })), [
      { slot: 1, title: "一等奖证书", mimeType: "image/png", replacing: false, previewUrl: `/api/admin/events/wz-aerospace-2026/certificate-imports/${preview.id}/previews/2/1` },
      { slot: 2, title: "优秀选手证书", mimeType: "image/png", replacing: false, previewUrl: `/api/admin/events/wz-aerospace-2026/certificate-imports/${preview.id}/previews/2/2` }
    ]);
    assert.equal(JSON.stringify(preview).includes(tempDir), false);
    assert.equal(JSON.stringify(preview).includes("relativePath"), false);

    const afterPreviewDb = await readDb(dbPath);
    assert.equal(afterPreviewDb.certificates.length, 0);
    const storedBatch = afterPreviewDb.certificateImportBatches.find((batch) => batch.id === preview.id);
    assert.equal(storedBatch.originalName, "mixed.xlsx");
    assert.equal(storedBatch.previewJson[0].certificates.every((certificate) => !path.isAbsolute(certificate.relativePath)), true);
    const stagingDir = path.join(tempDir, "uploads", "import-staging", preview.id);
    assert.equal((await fs.readdir(stagingDir)).length, 2);

    const ordinaryImage = await fetch(`${baseUrl}${preview.candidates[0].certificates[0].previewUrl}`, withSession(ordinary.cookie));
    assert.equal(ordinaryImage.status, 403);
    const image = await fetch(`${baseUrl}${preview.candidates[0].certificates[0].previewUrl}`, withSession(admin.cookie));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), ONE_PIXEL_PNG);

    const errorReport = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/certificate-imports/${preview.id}/errors.xlsx`, withSession(admin.cookie));
    assert.equal(errorReport.status, 200);
    assert.match(errorReport.headers.get("content-type") || "", /spreadsheetml/);
    const reportWorkbook = new ExcelJS.Workbook();
    await reportWorkbook.xlsx.load(Buffer.from(await errorReport.arrayBuffer()));
    const reportSheet = reportWorkbook.getWorksheet("导入错误");
    assert.ok(reportSheet);
    assert.deepEqual(reportSheet.getRow(1).values.slice(1), ["Excel 行号", "报名编号", "错误原因"]);
    assert.equal(reportSheet.getCell("A2").value, 3);
    assert.equal(reportSheet.getCell("B2").value, "R-UNKNOWN");
    assert.ok(String(reportSheet.getCell("C2").value || ""));

    const commitResponse = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/certificate-imports/${preview.id}/commit`, withSession(admin.cookie, { method: "POST" }));
    assert.equal(commitResponse.status, 200);
    const commit = await commitResponse.json();
    assert.deepEqual(commit, { id: preview.id, status: "committed", createdCount: 2, replacedCount: 0 });

    const committedDb = await readDb(dbPath);
    const committedRegistration = committedDb.registrations.find((row) => row.id === approvedRegistration.id);
    const committedCertificates = committedDb.certificates.filter((row) => row.registrationId === approvedRegistration.id);
    assert.deepEqual({
      awardName: committedRegistration.awardName,
      rank: committedRegistration.rank,
      score: committedRegistration.score
    }, { awardName: "一等奖", rank: "1", score: "98.5" });
    assert.equal(committedCertificates.length, 2);
    assert.deepEqual(committedCertificates.map((row) => row.slot).sort(), [1, 2]);
    assert.equal(committedCertificates.every((row) => row.status === "draft" && row.source === "import" && row.importBatchId === preview.id), true);
    assert.equal(committedDb.certificateImportBatches.find((batch) => batch.id === preview.id).previewJson.length, 0);
    assert.deepEqual(committedDb.auditLogs.map((row) => ({
      actorUserId: row.actorUserId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId
    })), [{
      actorUserId: "U9001",
      action: "certificate-import.commit",
      targetType: "certificate-import",
      targetId: preview.id
    }]);
    await assert.rejects(fs.access(stagingDir));

    const duplicateCommit = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/certificate-imports/${preview.id}/commit`, withSession(admin.cookie, { method: "POST" }));
    assert.equal(duplicateCommit.status, 409);

    const replacementResponse = await previewWorkbook(baseUrl, admin.cookie, workbook, "replacement.xlsx");
    assert.equal(replacementResponse.status, 201);
    const replacement = await replacementResponse.json();
    assert.equal(replacement.validCount, 1);
    assert.equal(replacement.replaceCount, 2);
    assert.equal(replacement.candidates[0].certificates.every((certificate) => certificate.replacing), true);

    const replacementStagingDir = path.join(tempDir, "uploads", "import-staging", replacement.id);
    assert.equal((await fs.readdir(replacementStagingDir)).length, 2);
    const cancel = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/certificate-imports/${replacement.id}`, withSession(admin.cookie, { method: "DELETE" }));
    assert.equal(cancel.status, 204);
    await assert.rejects(fs.access(replacementStagingDir));
    const cancelledDb = await readDb(dbPath);
    const cancelledBatch = cancelledDb.certificateImportBatches.find((batch) => batch.id === replacement.id);
    assert.equal(cancelledBatch.status, "cancelled");
    assert.deepEqual(cancelledBatch.previewJson, []);
  }, { prefix: "certificate-import-preview-" });
});

test("certificate import preview rejects a staged path that escapes its batch directory", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const workbook = await buildMixedWorkbook();
    const previewResponse = await previewWorkbook(baseUrl, admin.cookie, workbook, "traversal.xlsx");
    assert.equal(previewResponse.status, 201);
    const preview = await previewResponse.json();

    const secretPath = path.join(tempDir, "secret.txt");
    await fs.writeFile(secretPath, "must-not-leak", "utf8");
    const db = await readDb(dbPath);
    const batch = db.certificateImportBatches.find((row) => row.id === preview.id);
    batch.previewJson[0].certificates[0].relativePath = "../../../../secret.txt";
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");

    const response = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/certificate-imports/${preview.id}/previews/2/1`, withSession(admin.cookie));
    assert.equal(response.status, 404);
    assert.equal((await response.text()).includes("must-not-leak"), false);
  }, { prefix: "certificate-import-traversal-" });
});

function sequentialIds() {
  let value = 0;
  return (prefix) => `${prefix}-${++value}`;
}

function serviceDb({ withExistingCertificate = false } = {}) {
  const oldCertificate = {
    id: "C-OLD",
    registrationId: approvedRegistration.id,
    slot: 1,
    title: "旧证书",
    userId: "U2001",
    organizationId: "O1002",
    fileName: "old.png",
    storedName: "old.png",
    filePath: "C:/uploads/certificates/old.png",
    awardName: "旧奖项",
    rank: "9",
    score: "60",
    status: "published",
    source: "manual",
    importBatchId: null,
    uploadedAt: "2026-07-01T00:00:00.000Z",
    publishedAt: "2026-07-01T00:00:00.000Z",
    cleanedAt: ""
  };
  const registration = {
    ...approvedRegistration,
    userId: "U2001",
    organizationId: "O1002",
    eventId: "E1",
    updatedAt: "2026-07-01T00:00:00.000Z"
  };
  return {
    events: [{ id: "E1", isCurrent: true }],
    registrations: [registration],
    certificates: withExistingCertificate ? [oldCertificate] : [],
    certificateImportBatches: [],
    certificateImportErrors: [],
    fileCleanupJournal: []
  };
}

function previewCandidate(certificates) {
  return {
    rowNumber: 2,
    registrationId: approvedRegistration.id,
    result: { awardName: "一等奖", rank: "1", score: "99" },
    certificates
  };
}

function stagedCertificate(slot) {
  return {
    slot,
    title: `证书${slot}`,
    extension: "png",
    mimeType: "image/png",
    replacing: slot === 1,
    relativePath: `2-${slot}.png`
  };
}

function certificateSnapshot(certificate) {
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

function previewCandidateForDb(db, certificates) {
  const candidate = previewCandidate(certificates);
  return {
    ...candidate,
    expectedCertificateStates: Object.fromEntries(certificates.map((certificate) => [
      String(certificate.slot),
      certificateSnapshot(db.certificates.find((row) => row.registrationId === candidate.registrationId && Number(row.slot) === Number(certificate.slot)))
    ]))
  };
}

test("certificate import preview removes staging when saving a later image fails", async () => {
  const db = serviceDb();
  const stagedFiles = new Set();
  let saves = 0;
  let wroteDb = false;
  const storage = {
    async saveStagingFile({ rowNumber, slot }) {
      saves += 1;
      if (saves === 2) throw new Error("staging disk failed");
      const relativePath = `${rowNumber}-${slot}.png`;
      stagedFiles.add(relativePath);
      return { relativePath };
    },
    async removeStagingBatch() { stagedFiles.clear(); }
  };

  await assert.rejects(previewCertificateImport({
    file: { buffer: Buffer.from("workbook"), originalname: "failure.xlsx" },
    userId: "U9001",
    store: {
      readDb: async () => structuredClone(db),
      writeDb: async () => { wroteDb = true; }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-17T00:00:00.000Z",
    parseWorkbook: async () => ({
      candidates: [previewCandidate([
        { ...stagedCertificate(1), buffer: ONE_PIXEL_PNG },
        { ...stagedCertificate(2), buffer: ONE_PIXEL_PNG }
      ])],
      errors: []
    }),
    storage
  }), /staging disk failed/);

  assert.equal(wroteDb, false);
  assert.deepEqual([...stagedFiles], []);
});

test("certificate import commit removes every new file and preserves old data when the database write fails", async () => {
  const persisted = serviceDb({ withExistingCertificate: true });
  persisted.certificateImportBatches.push({
    id: "B1", eventId: "E1", createdBy: "U9001", originalName: "rollback.xlsx", status: "preview",
    previewJson: [previewCandidateForDb(persisted, [stagedCertificate(1), stagedCertificate(2)])],
    validCount: 1, errorCount: 0, replaceCount: 1, createdAt: "2026-07-17T00:00:00.000Z", committedAt: null
  });
  const files = new Set(["C:/uploads/certificates/old.png"]);
  let nextFile = 0;
  const storage = {
    readStagingFile: async () => ONE_PIXEL_PNG,
    async saveCertificateFile({ registrationId, slot }) {
      const filePath = `C:/uploads/certificates/new-${++nextFile}.png`;
      files.add(filePath);
      return { filePath, storedName: path.basename(filePath), fileName: `${registrationId}-${slot}.png` };
    },
    async deleteFile({ filePath }) { files.delete(filePath); },
    resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/B1/${relativePath}`,
    removeStagingBatch: async () => {}
  };

  await assert.rejects(commitCertificateImport({
    batchId: "B1",
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async () => { throw new Error("database write failed"); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-17T01:00:00.000Z",
    storage
  }), /database write failed/);

  assert.deepEqual([...files], ["C:/uploads/certificates/old.png"]);
  assert.equal(persisted.certificates[0].filePath, "C:/uploads/certificates/old.png");
  assert.equal(persisted.certificates[0].status, "published");
  assert.equal(persisted.certificateImportBatches[0].status, "preview");
});

test("certificate import commit journals failed old-file and staging cleanup without undoing committed data", async () => {
  let persisted = serviceDb({ withExistingCertificate: true });
  persisted.certificateImportBatches.push({
    id: "B2", eventId: "E1", createdBy: "U9001", originalName: "cleanup.xlsx", status: "preview",
    previewJson: [previewCandidateForDb(persisted, [stagedCertificate(1), stagedCertificate(2)])],
    validCount: 1, errorCount: 0, replaceCount: 1, createdAt: "2026-07-17T00:00:00.000Z", committedAt: null
  });
  const storage = {
    readStagingFile: async () => ONE_PIXEL_PNG,
    saveCertificateFile: async () => ({
      filePath: "C:/uploads/certificates/new.png",
      storedName: "new.png",
      fileName: "new.png"
    }),
    deleteFile: async () => { throw new Error("old cleanup failed"); },
    resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/B2/${relativePath}`,
    removeStagingBatch: async () => { throw new Error("staging cleanup failed"); }
  };
  const result = await commitCertificateImport({
    batchId: "B2",
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async (next) => { persisted = structuredClone(next); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-17T02:00:00.000Z",
    storage
  });

  assert.deepEqual(result, { id: "B2", status: "committed", createdCount: 1, replacedCount: 1 });
  assert.equal(persisted.certificateImportBatches[0].status, "committed");
  assert.equal(persisted.certificates[0].filePath, "C:/uploads/certificates/new.png");
  assert.deepEqual(persisted.fileCleanupJournal.map((marker) => marker.category).sort(), [
    "certificate-import-replaced", "certificate-import-staging", "certificate-import-staging"
  ]);
  assert.equal(persisted.fileCleanupJournal.every((marker) => marker.attempts === 1), true);
  assert.equal(persisted.fileCleanupJournal.every((marker) => marker.lastAttemptAt === "2026-07-17T02:00:00.000Z"), true);
});

test("certificate import error report lookup returns 404 when a batch has no errors", async () => {
  const db = serviceDb();
  db.certificateImportBatches.push({ id: "B3", status: "preview", previewJson: [] });
  await assert.rejects(loadCertificateImportErrors({
    batchId: "B3",
    store: { readDb: async () => structuredClone(db) }
  }), (error) => {
    assert.equal(error.status, 404);
    return true;
  });
});

test("certificate import preview journals staged files when database persistence and staging cleanup both fail", async () => {
  let persisted = serviceDb();
  let writes = 0;
  const storage = {
    saveStagingFile: async ({ rowNumber, slot }) => ({ relativePath: `${rowNumber}-${slot}.png` }),
    removeStagingBatch: async () => { throw new Error("staging cleanup failed"); },
    resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/B/${relativePath}`
  };

  await assert.rejects(previewCertificateImport({
    file: { buffer: Buffer.from("workbook"), originalname: "journal.xlsx" },
    userId: "U9001",
    store: {
      readDb: async () => structuredClone(persisted),
      async writeDb(next) {
        writes += 1;
        if (writes === 1) throw new Error("database write failed");
        persisted = structuredClone(next);
      }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-17T03:00:00.000Z",
    parseWorkbook: async () => ({
      candidates: [previewCandidate([
        { ...stagedCertificate(1), buffer: ONE_PIXEL_PNG },
        { ...stagedCertificate(2), buffer: ONE_PIXEL_PNG }
      ])],
      errors: []
    }),
    storage
  }), /database write failed/);

  assert.equal(writes, 2);
  assert.deepEqual(persisted.certificateImportBatches, []);
  assert.equal(persisted.fileCleanupJournal.length, 2);
  assert.equal(persisted.fileCleanupJournal.every((marker) => marker.category === "certificate-import-staging"), true);
  assert.equal(persisted.fileCleanupJournal.every((marker) => marker.attempts === 1), true);
});

test("certificate import commit journals new orphan files when database persistence and rollback deletion both fail", async () => {
  let persisted = serviceDb({ withExistingCertificate: true });
  persisted.certificateImportBatches.push({
    id: "B4", eventId: "E1", createdBy: "U9001", originalName: "orphan.xlsx", status: "preview",
    previewJson: [previewCandidateForDb(persisted, [stagedCertificate(1), stagedCertificate(2)])],
    validCount: 1, errorCount: 0, replaceCount: 1, createdAt: "2026-07-17T00:00:00.000Z", committedAt: null
  });
  let writes = 0;
  let nextFile = 0;
  const storage = {
    readStagingFile: async () => ONE_PIXEL_PNG,
    async saveCertificateFile({ registrationId, slot }) {
      const storedName = `orphan-${++nextFile}.png`;
      return { filePath: `C:/uploads/certificates/${storedName}`, storedName, fileName: `${registrationId}-${slot}.png` };
    },
    deleteFile: async () => { throw new Error("new file cleanup failed"); },
    resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/B4/${relativePath}`,
    removeStagingBatch: async () => {}
  };

  await assert.rejects(commitCertificateImport({
    batchId: "B4",
    store: {
      readDb: async () => structuredClone(persisted),
      async writeDb(next) {
        writes += 1;
        if (writes === 1) throw new Error("database write failed");
        persisted = structuredClone(next);
      }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-17T04:00:00.000Z",
    storage
  }), /database write failed/);

  assert.equal(writes, 2);
  assert.equal(persisted.certificateImportBatches[0].status, "preview");
  assert.equal(persisted.certificates[0].filePath, "C:/uploads/certificates/old.png");
  assert.equal(persisted.fileCleanupJournal.length, 2);
  assert.equal(persisted.fileCleanupJournal.every((marker) => marker.category === "certificate-import-new"), true);
  assert.equal(persisted.fileCleanupJournal.every((marker) => marker.attempts === 3), true);
});

test("certificate import staging journal cleanup removes the empty batch directory", async () => {
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "certificate-import-journal-"));
  const previousRoot = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = uploadRoot;
  try {
    const stored = await saveImportStagingFile({
      batchId: "B5",
      rowNumber: 2,
      slot: 1,
      extension: "png",
      buffer: ONE_PIXEL_PNG
    });
    const directory = path.dirname(stored.filePath);
    await deletePrivateFile({ filePath: stored.filePath, category: "certificate-import-staging" });
    await assert.rejects(fs.access(directory));
  } finally {
    if (previousRoot === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previousRoot;
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
});

test("certificate import preview journals the failed staging write target when both internal and batch cleanup fail", async () => {
  let persisted = serviceDb();
  let writes = 0;
  const failedWrite = new Error("staging write failed");
  failedWrite.cleanupTarget = {
    filePath: "C:/uploads/import-staging/B/2-1.png",
    relativePath: "2-1.png",
    category: "certificate-import-staging",
    cleanupAttempts: 1
  };
  await assert.rejects(previewCertificateImport({
    file: { buffer: Buffer.from("workbook"), originalname: "partial.xlsx" },
    userId: "U9001",
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async (next) => { writes += 1; persisted = structuredClone(next); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-17T05:00:00.000Z",
    parseWorkbook: async () => ({
      candidates: [previewCandidate([
        { ...stagedCertificate(1), buffer: ONE_PIXEL_PNG },
        { ...stagedCertificate(2), buffer: ONE_PIXEL_PNG }
      ])],
      errors: []
    }),
    storage: {
      saveStagingFile: async () => { throw failedWrite; },
      removeStagingBatch: async () => { throw new Error("batch cleanup failed"); },
      resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/B/${relativePath}`
    }
  }), /staging write failed/);

  assert.equal(writes, 1);
  assert.deepEqual(persisted.fileCleanupJournal.map((marker) => ({
    filePath: marker.filePath,
    category: marker.category
  })), [{
    filePath: "C:/uploads/import-staging/B/2-1.png",
    category: "certificate-import-staging"
  }]);
  assert.equal(persisted.fileCleanupJournal[0].attempts, 2);
});

test("certificate import commit journals a failed formal write target when rollback deletion also fails", async () => {
  let persisted = serviceDb();
  persisted.certificateImportBatches.push({
    id: "B6", eventId: "E1", createdBy: "U9001", originalName: "partial.xlsx", status: "preview",
    previewJson: [previewCandidateForDb(persisted, [stagedCertificate(1), stagedCertificate(2)])],
    validCount: 1, errorCount: 0, replaceCount: 0, createdAt: "2026-07-17T00:00:00.000Z", committedAt: null
  });
  let writes = 0;
  const failedWrite = new Error("formal write failed");
  failedWrite.cleanupTarget = {
    filePath: "C:/uploads/certificates/partial.png",
    storedName: "partial.png",
    fileName: "partial.png",
    category: "certificate-import-new",
    cleanupAttempts: 1
  };
  await assert.rejects(commitCertificateImport({
    batchId: "B6",
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async (next) => { writes += 1; persisted = structuredClone(next); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-17T06:00:00.000Z",
    storage: {
      readStagingFile: async () => ONE_PIXEL_PNG,
      saveCertificateFile: async () => { throw failedWrite; },
      deleteFile: async () => { throw new Error("rollback delete failed"); },
      resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/B6/${relativePath}`,
      removeStagingBatch: async () => {}
    }
  }), /formal write failed/);

  assert.equal(writes, 1);
  assert.equal(persisted.certificateImportBatches[0].status, "preview");
  assert.deepEqual(persisted.fileCleanupJournal.map((marker) => ({
    filePath: marker.filePath,
    category: marker.category
  })), [{
    filePath: "C:/uploads/certificates/partial.png",
    category: "certificate-import-new"
  }]);
  assert.equal(persisted.fileCleanupJournal[0].attempts, 4);
});

test("certificate import preview rejects before staging when no event can own the batch", async () => {
  let persisted = serviceDb();
  persisted.events = [];
  persisted.registrations[0].eventId = null;
  let writes = 0;
  let stagingWrites = 0;
  let cleanupCalls = 0;
  await assert.rejects(previewCertificateImport({
    file: { buffer: Buffer.from("workbook"), originalname: "no-event.xlsx" },
    userId: "U9001",
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async (next) => { writes += 1; persisted = structuredClone(next); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-17T07:00:00.000Z",
    parseWorkbook: async () => ({
      candidates: [previewCandidate([
        { ...stagedCertificate(1), buffer: ONE_PIXEL_PNG },
        { ...stagedCertificate(2), buffer: ONE_PIXEL_PNG }
      ])],
      errors: []
    }),
    storage: {
      saveStagingFile: async () => { stagingWrites += 1; return { relativePath: "2-1.png" }; },
      removeStagingBatch: async () => { cleanupCalls += 1; },
      resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/B7/${relativePath}`
    }
  }), (error) => {
    assert.equal(error.status, 422);
    return true;
  });

  assert.equal(writes, 0);
  assert.equal(stagingWrites, 0);
  assert.equal(cleanupCalls, 0);
  assert.equal(persisted.fileCleanupJournal.length, 0);
});

async function withLinkedUploadDirectory(relativeDirectory, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "certificate-import-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "certificate-import-outside-"));
  const previousRoot = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = root;
  const linked = path.join(root, ...relativeDirectory.split("/"));
  await fs.mkdir(path.dirname(linked), { recursive: true });
  await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  try {
    await fn({ root, outside, linked });
  } finally {
    if (previousRoot === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
}

test("certificate import staging read rejects a batch directory linked outside the upload root", async () => {
  await withLinkedUploadDirectory("import-staging/B8", async ({ outside }) => {
    await fs.writeFile(path.join(outside, "2-1.png"), ONE_PIXEL_PNG);
    await assert.rejects(readImportStagingFile({ batchId: "B8", relativePath: "2-1.png" }), /upload root|symbolic link|escapes/i);
  });
});

test("certificate import staging write rejects a batch directory linked outside the upload root", async () => {
  await withLinkedUploadDirectory("import-staging/B9", async ({ outside }) => {
    await assert.rejects(saveImportStagingFile({
      batchId: "B9", rowNumber: 2, slot: 1, extension: "png", buffer: ONE_PIXEL_PNG
    }), /upload root|symbolic link|escapes/i);
    assert.deepEqual(await fs.readdir(outside), []);
  });
});

test("certificate import formal write rejects a certificates directory linked outside the upload root", async () => {
  await withLinkedUploadDirectory("certificates", async ({ outside }) => {
    await assert.rejects(saveCertificateImportFile({
      registrationId: approvedRegistration.id, slot: 1, extension: "png", buffer: ONE_PIXEL_PNG
    }), /upload root|symbolic link|escapes/i);
    assert.deepEqual(await fs.readdir(outside), []);
  });
});

test("certificate import deletion rejects an intermediate directory linked outside the upload root", async () => {
  await withLinkedUploadDirectory("certificates", async ({ root, outside }) => {
    const victim = path.join(outside, "victim.png");
    await fs.writeFile(victim, ONE_PIXEL_PNG);
    await assert.rejects(deletePrivateFile({ filePath: path.join(root, "certificates", "victim.png") }), /upload root|symbolic link|escapes/i);
    assert.deepEqual(await fs.readFile(victim), ONE_PIXEL_PNG);
  });
});

test("certificate import preview never removes a staging directory it failed to claim", async () => {
  const db = serviceDb();
  let removed = false;
  let saved = false;
  const collision = Object.assign(new Error("batch already exists"), { code: "EEXIST" });
  await assert.rejects(previewCertificateImport({
    file: { buffer: Buffer.from("workbook"), originalname: "collision.xlsx" },
    userId: "U9001",
    store: {
      readDb: async () => structuredClone(db),
      writeDb: async () => { throw new Error("must not persist"); }
    },
    makeId: () => "B-COLLISION",
    now: () => "2026-07-17T08:00:00.000Z",
    parseWorkbook: async () => ({
      candidates: [previewCandidate([
        { ...stagedCertificate(1), buffer: ONE_PIXEL_PNG },
        { ...stagedCertificate(2), buffer: ONE_PIXEL_PNG }
      ])],
      errors: []
    }),
    storage: {
      createStagingBatch: async () => { throw collision; },
      saveStagingFile: async () => { saved = true; throw new Error("must not save"); },
      removeStagingBatch: async () => { removed = true; },
      resolveStagingPath: () => "unused"
    }
  }), (error) => error.status === 409);
  assert.equal(saved, false);
  assert.equal(removed, false);
});

test("certificate import staging exclusive-create collision preserves the existing preview file", async () => {
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "certificate-import-collision-"));
  const previousRoot = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = uploadRoot;
  try {
    const first = await saveImportStagingFile({
      batchId: "B10", rowNumber: 2, slot: 1, extension: "png", buffer: Buffer.from("original")
    });
    await assert.rejects(saveImportStagingFile({
      batchId: "B10", rowNumber: 2, slot: 1, extension: "png", buffer: Buffer.from("replacement")
    }), (error) => error.code === "EEXIST");
    assert.deepEqual(await fs.readFile(first.filePath), Buffer.from("original"));
  } finally {
    if (previousRoot === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previousRoot;
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
});

test("certificate import preview maps unsafe or missing paths to 404 but preserves operational I/O errors", async () => {
  const db = serviceDb();
  db.certificateImportBatches.push({
    id: "B11", status: "preview", previewJson: [previewCandidate([stagedCertificate(1), stagedCertificate(2)])]
  });
  const diskError = Object.assign(new Error("disk unavailable"), { code: "EIO" });
  await assert.rejects(loadCertificateImportPreview({
    batchId: "B11",
    rowNumber: 2,
    slot: 1,
    store: { readDb: async () => structuredClone(db) },
    storage: { readStagingFile: async () => { throw diskError; } }
  }), (error) => error === diskError);
});

async function seedLinkedBatch(outside, batchId) {
  const directory = path.join(outside, batchId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "2-1.png"), ONE_PIXEL_PNG);
  await fs.writeFile(path.join(directory, "2-2.png"), ONE_PIXEL_PNG);
  const sentinel = path.join(directory, "external-sentinel.txt");
  await fs.writeFile(sentinel, "preserve", "utf8");
  return sentinel;
}

test("certificate import cancel never follows a linked import-staging parent during recursive cleanup", async () => {
  await withLinkedUploadDirectory("import-staging", async ({ outside }) => {
    const batchId = "B-PARENT-CANCEL";
    const sentinel = await seedLinkedBatch(outside, batchId);
    let persisted = serviceDb();
    persisted.certificateImportBatches.push({
      id: batchId, eventId: "E1", createdBy: "U9001", originalName: "cancel.xlsx", status: "preview",
    previewJson: [previewCandidateForDb(persisted, [stagedCertificate(1), stagedCertificate(2)])],
      validCount: 1, errorCount: 0, replaceCount: 0, createdAt: "2026-07-17T00:00:00.000Z", committedAt: null
    });

    await cancelCertificateImport({
      batchId,
      store: {
        readDb: async () => structuredClone(persisted),
        writeDb: async (next) => { persisted = structuredClone(next); }
      },
      makeId: sequentialIds(),
      now: () => "2026-07-18T00:00:00.000Z"
    });

    assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
    assert.equal(persisted.certificateImportBatches[0].status, "cancelled");
    assert.equal(persisted.fileCleanupJournal.length, 2);
    assert.equal(persisted.fileCleanupJournal.every((marker) => marker.attempts === 1), true);
  });
});

test("certificate import commit never follows a linked import-staging parent during post-commit cleanup", async () => {
  await withLinkedUploadDirectory("import-staging", async ({ outside }) => {
    const batchId = "B-PARENT-COMMIT";
    const sentinel = await seedLinkedBatch(outside, batchId);
    let persisted = serviceDb();
    persisted.certificateImportBatches.push({
      id: batchId, eventId: "E1", createdBy: "U9001", originalName: "commit.xlsx", status: "preview",
      previewJson: [previewCandidateForDb(persisted, [stagedCertificate(1), stagedCertificate(2)])],
      validCount: 1, errorCount: 0, replaceCount: 0, createdAt: "2026-07-17T00:00:00.000Z", committedAt: null
    });
    const storage = {
      readStagingFile: async () => ONE_PIXEL_PNG,
      saveCertificateFile: async ({ slot }) => ({
        filePath: `C:/uploads/certificates/new-${slot}.png`, storedName: `new-${slot}.png`, fileName: `new-${slot}.png`
      }),
      deleteFile: async () => {},
      resolveStagingPath: resolveImportStagingPath,
      removeStagingBatch: removeImportStagingBatch
    };

    const committed = await commitCertificateImport({
      batchId,
      store: {
        readDb: async () => structuredClone(persisted),
        writeDb: async (next) => { persisted = structuredClone(next); }
      },
      makeId: sequentialIds(),
      now: () => "2026-07-18T01:00:00.000Z",
      storage
    });

    assert.equal(committed.createdCount, 2);
    assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
    assert.equal(persisted.fileCleanupJournal.length, 2);
    assert.equal(persisted.fileCleanupJournal.every((marker) => marker.attempts === 1), true);
  });
});

test("certificate import preview rollback never follows a linked import-staging parent", async () => {
  await withLinkedUploadDirectory("import-staging", async ({ outside }) => {
    const batchId = "B-PARENT-PREVIEW";
    const sentinel = await seedLinkedBatch(outside, batchId);
    let persisted = serviceDb();
    let writes = 0;
    await assert.rejects(previewCertificateImport({
      file: { buffer: Buffer.from("workbook"), originalname: "preview.xlsx" },
      userId: "U9001",
      store: {
        readDb: async () => structuredClone(persisted),
        async writeDb(next) {
          writes += 1;
          if (writes === 1) throw new Error("database write failed");
          persisted = structuredClone(next);
        }
      },
      makeId: (prefix) => prefix === "CIB" ? batchId : `${prefix}-1`,
      now: () => "2026-07-18T02:00:00.000Z",
      parseWorkbook: async () => ({
        candidates: [previewCandidate([
          { ...stagedCertificate(1), buffer: ONE_PIXEL_PNG },
          { ...stagedCertificate(2), buffer: ONE_PIXEL_PNG }
        ])],
        errors: []
      }),
      storage: {
        createStagingBatch: async () => {},
        saveStagingFile: async ({ rowNumber, slot }) => ({ relativePath: `${rowNumber}-${slot}.png` }),
        removeStagingBatch: removeImportStagingBatch,
        resolveStagingPath: resolveImportStagingPath
      }
    }), /database write failed/);

    assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
    assert.equal(writes, 2);
    assert.equal(persisted.fileCleanupJournal.length, 2);
    assert.equal(persisted.fileCleanupJournal.every((marker) => marker.attempts === 1), true);
  });
});

test("certificate import preview rejects zero or duplicate certificate slots per row", async () => {
  const variants = [
    { name: "zero", certificates: [] },
    { name: "duplicate", certificates: [
      { ...stagedCertificate(1), buffer: ONE_PIXEL_PNG },
      { ...stagedCertificate(1), title: "duplicate", buffer: ONE_PIXEL_PNG }
    ] }
  ];
  for (const variant of variants) {
    let persisted = serviceDb();
    let saves = 0;
    const preview = await previewCertificateImport({
      file: { buffer: Buffer.from("workbook"), originalname: `${variant.name}.xlsx` },
      userId: "U9001",
      store: {
        readDb: async () => structuredClone(persisted),
        writeDb: async (next) => { persisted = structuredClone(next); }
      },
      makeId: sequentialIds(),
      now: () => "2026-07-18T03:00:00.000Z",
      parseWorkbook: async () => ({ candidates: [previewCandidate(variant.certificates)], errors: [] }),
      storage: {
        createStagingBatch: async () => {},
        saveStagingFile: async ({ rowNumber, slot }) => { saves += 1; return { relativePath: `${rowNumber}-${slot}.png` }; },
        removeStagingBatch: async () => {},
        resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/B/${relativePath}`
      }
    });
    assert.equal(preview.validCount, 0, variant.name);
    assert.equal(preview.errorCount, 1, variant.name);
    assert.equal(saves, 0, variant.name);
    assert.deepEqual(persisted.certificates, [], variant.name);
  }
});

test("certificate import commit rejects zero or duplicate slots without changing results or certificates", async () => {
  const variants = [
    { name: "zero", certificates: [] },
    { name: "duplicate", certificates: [stagedCertificate(1), { ...stagedCertificate(1), title: "duplicate" }] }
  ];
  for (const variant of variants) {
    let persisted = serviceDb({ withExistingCertificate: true });
    persisted.registrations[0].awardName = "old-award";
    persisted.registrations[0].rank = "old-rank";
    persisted.registrations[0].score = "old-score";
    persisted.certificates.push({ ...persisted.certificates[0], id: "C-OLD-2", slot: 2, filePath: "C:/uploads/certificates/old-2.png" });
    persisted.certificateImportBatches.push({
      id: `B-INVALID-${variant.name}`, eventId: "E1", createdBy: "U9001", originalName: "invalid.xlsx", status: "preview",
      previewJson: [previewCandidate(variant.certificates)], validCount: 1, errorCount: 0, replaceCount: 0,
      createdAt: "2026-07-17T00:00:00.000Z", committedAt: null
    });
    const before = structuredClone(persisted);
    let saved = 0;
    let writes = 0;
    await assert.rejects(commitCertificateImport({
      batchId: `B-INVALID-${variant.name}`,
      store: {
        readDb: async () => structuredClone(persisted),
        writeDb: async (next) => { writes += 1; persisted = structuredClone(next); }
      },
      makeId: sequentialIds(),
      now: () => "2026-07-18T04:00:00.000Z",
      storage: {
        readStagingFile: async () => ONE_PIXEL_PNG,
        saveCertificateFile: async () => { saved += 1; return {}; },
        deleteFile: async () => {},
        resolveStagingPath: () => "unused",
        removeStagingBatch: async () => {}
      }
    }), (error) => error.status === 409, variant.name);
    assert.equal(saved, 0, variant.name);
    assert.equal(writes, 0, variant.name);
    assert.deepEqual(persisted, before, variant.name);
  }
});

test("certificate import preview rejects duplicate rows for the same registration", async () => {
  let persisted = serviceDb();
  let saves = 0;
  const certificates = () => [
    { ...stagedCertificate(1), buffer: ONE_PIXEL_PNG },
    { ...stagedCertificate(2), buffer: ONE_PIXEL_PNG }
  ];
  const preview = await previewCertificateImport({
    file: { buffer: Buffer.from("workbook"), originalname: "duplicate-rows.xlsx" },
    userId: "U9001",
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async (next) => { persisted = structuredClone(next); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-18T05:00:00.000Z",
    parseWorkbook: async () => ({
      candidates: [previewCandidate(certificates()), { ...previewCandidate(certificates()), rowNumber: 3 }],
      errors: []
    }),
    storage: {
      createStagingBatch: async () => {},
      saveStagingFile: async () => { saves += 1; return { relativePath: "unused.png" }; },
      removeStagingBatch: async () => {},
      resolveStagingPath: () => "unused"
    }
  });
  assert.equal(preview.validCount, 0);
  assert.equal(preview.errorCount, 2);
  assert.equal(preview.replaceCount, 0);
  assert.equal(saves, 0);
});

test("certificate import preview assigns a historical registration batch to its historical event", async () => {
  let persisted = serviceDb();
  persisted.events = [{ id: "E-CURRENT", isCurrent: true }, { id: "E-HISTORICAL", isCurrent: false }];
  persisted.registrations[0].eventId = "E-HISTORICAL";
  await previewCertificateImport({
    file: { buffer: Buffer.from("workbook"), originalname: "historical.xlsx" },
    userId: "U9001",
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async (next) => { persisted = structuredClone(next); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-18T06:00:00.000Z",
    parseWorkbook: async () => ({
      candidates: [previewCandidate([
        { ...stagedCertificate(1), buffer: ONE_PIXEL_PNG },
        { ...stagedCertificate(2), buffer: ONE_PIXEL_PNG }
      ])], errors: []
    }),
    storage: {
      createStagingBatch: async () => {},
      saveStagingFile: async ({ rowNumber, slot }) => ({ relativePath: `${rowNumber}-${slot}.png` }),
      removeStagingBatch: async () => {},
      resolveStagingPath: () => "unused"
    }
  });
  assert.equal(persisted.certificateImportBatches[0].eventId, "E-HISTORICAL");
});

test("certificate import preview rejects candidates from mixed events before staging", async () => {
  const db = serviceDb();
  db.events = [{ id: "E1", isCurrent: true }, { id: "E2", isCurrent: false }];
  db.registrations.push({ ...db.registrations[0], id: "R-E2", eventId: "E2" });
  let saves = 0;
  let writes = 0;
  const certificates = () => [
    { ...stagedCertificate(1), buffer: ONE_PIXEL_PNG },
    { ...stagedCertificate(2), buffer: ONE_PIXEL_PNG }
  ];
  await assert.rejects(previewCertificateImport({
    file: { buffer: Buffer.from("workbook"), originalname: "mixed-events.xlsx" },
    userId: "U9001",
    store: {
      readDb: async () => structuredClone(db),
      writeDb: async () => { writes += 1; }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-18T07:00:00.000Z",
    parseWorkbook: async () => ({
      candidates: [previewCandidate(certificates()), { ...previewCandidate(certificates()), registrationId: "R-E2", rowNumber: 3 }],
      errors: []
    }),
    storage: {
      createStagingBatch: async () => {},
      saveStagingFile: async () => { saves += 1; return { relativePath: "unused" }; },
      removeStagingBatch: async () => {},
      resolveStagingPath: () => "unused"
    }
  }), (error) => error.status === 422);
  assert.equal(saves, 0);
  assert.equal(writes, 0);
});

test("certificate import accepts one supplied certificate slot and keeps an unspecified slot unchanged", async () => {
  let persisted = serviceDb({ withExistingCertificate: true });
  persisted.certificates[0].slot = 2;
  const originalSecondSlot = structuredClone(persisted.certificates[0]);
  let saved = 0;
  const preview = await previewCertificateImport({
    file: { buffer: Buffer.from("workbook"), originalname: "one-slot.xlsx" },
    eventId: "E1",
    userId: "U9001",
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async (next) => { persisted = structuredClone(next); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-18T08:00:00.000Z",
    parseWorkbook: async () => ({
      candidates: [previewCandidate([{ ...stagedCertificate(1), buffer: ONE_PIXEL_PNG }])],
      errors: []
    }),
    storage: {
      createStagingBatch: async () => {},
      saveStagingFile: async ({ rowNumber, slot }) => ({ relativePath: `${rowNumber}-${slot}.png` }),
      readStagingFile: async () => ONE_PIXEL_PNG,
      saveCertificateFile: async () => {
        saved += 1;
        return { fileName: "new.png", storedName: "new.png", filePath: "C:/uploads/certificates/new.png" };
      },
      deleteFile: async () => {},
      removeStagingBatch: async () => {},
      resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/${relativePath}`
    }
  });

  assert.equal(preview.validCount, 1);
  assert.equal(preview.candidates[0].certificates.length, 1);
  await commitCertificateImport({
    batchId: preview.id,
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async (next) => { persisted = structuredClone(next); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-18T08:01:00.000Z",
    storage: {
      readStagingFile: async () => ONE_PIXEL_PNG,
      saveCertificateFile: async () => {
        saved += 1;
        return { fileName: "new.png", storedName: "new.png", filePath: "C:/uploads/certificates/new.png" };
      },
      deleteFile: async () => {},
      removeStagingBatch: async () => {},
      resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/${relativePath}`
    }
  });

  assert.equal(saved, 1);
  assert.deepEqual(persisted.certificates.find((row) => row.slot === 2), originalSecondSlot);
  assert.equal(persisted.certificates.some((row) => row.slot === 1), true);
});

test("certificate import preserves an internal expected certificate state and rejects a stale preview before formal writes", async () => {
  let persisted = serviceDb({ withExistingCertificate: true });
  let formalWrites = 0;
  const preview = await previewCertificateImport({
    file: { buffer: Buffer.from("workbook"), originalname: "stale.xlsx" },
    eventId: "E1",
    userId: "U9001",
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async (next) => { persisted = structuredClone(next); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-18T09:00:00.000Z",
    parseWorkbook: async () => ({
      candidates: [previewCandidate([
        { ...stagedCertificate(1), buffer: ONE_PIXEL_PNG },
        { ...stagedCertificate(2), buffer: ONE_PIXEL_PNG }
      ])],
      errors: []
    }),
    storage: {
      createStagingBatch: async () => {},
      saveStagingFile: async ({ rowNumber, slot }) => ({ relativePath: `${rowNumber}-${slot}.png` }),
      removeStagingBatch: async () => {},
      resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/${relativePath}`
    }
  });
  const storedCandidate = persisted.certificateImportBatches[0].previewJson[0];
  assert.ok(storedCandidate.expectedCertificateStates);
  assert.equal(Object.hasOwn(preview.candidates[0], "expectedCertificateStates"), false);

  persisted.certificates[0].title = "changed after preview";
  const beforeCommit = structuredClone(persisted);
  await assert.rejects(commitCertificateImport({
    batchId: preview.id,
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async (next) => { persisted = structuredClone(next); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-18T09:01:00.000Z",
    storage: {
      readStagingFile: async () => ONE_PIXEL_PNG,
      saveCertificateFile: async () => {
        formalWrites += 1;
        return { fileName: "new.png", storedName: "new.png", filePath: "C:/uploads/certificates/new.png" };
      },
      deleteFile: async () => {},
      removeStagingBatch: async () => {},
      resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/${relativePath}`
    }
  }), (error) => error.status === 409);
  assert.equal(formalWrites, 0);
  assert.deepEqual(persisted, beforeCommit);
});

test("certificate import creates an error-only selected-event preview without staging files", async () => {
  let persisted = serviceDb();
  let createdBatches = 0;
  let stagedFiles = 0;
  const preview = await previewCertificateImport({
    file: { buffer: Buffer.from("workbook"), originalname: "all-errors.xlsx" },
    eventId: "E1",
    userId: "U9001",
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async (next) => { persisted = structuredClone(next); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-18T10:00:00.000Z",
    parseWorkbook: async () => ({ candidates: [], errors: [{ rowNumber: 2, registrationId: "BAD", message: "invalid row" }] }),
    storage: {
      createStagingBatch: async () => { createdBatches += 1; },
      saveStagingFile: async () => { stagedFiles += 1; return { relativePath: "never.png" }; },
      removeStagingBatch: async () => {},
      resolveStagingPath: () => "unused"
    }
  });

  assert.equal(preview.status, "preview");
  assert.equal(preview.validCount, 0);
  assert.equal(preview.errorCount, 1);
  assert.equal(createdBatches, 0);
  assert.equal(stagedFiles, 0);
  assert.equal(persisted.certificateImportBatches.length, 1);
  assert.deepEqual(persisted.fileCleanupJournal, []);
});

test("certificate import turns candidates from a different selected event into preview errors", async () => {
  let persisted = serviceDb();
  persisted.events.push({ id: "E2", isCurrent: false });
  persisted.registrations[0].eventId = "E2";
  let stagedFiles = 0;
  const preview = await previewCertificateImport({
    file: { buffer: Buffer.from("workbook"), originalname: "wrong-event.xlsx" },
    eventId: "E1",
    userId: "U9001",
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async (next) => { persisted = structuredClone(next); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-18T11:00:00.000Z",
    parseWorkbook: async () => ({
      candidates: [previewCandidate([
        { ...stagedCertificate(1), buffer: ONE_PIXEL_PNG },
        { ...stagedCertificate(2), buffer: ONE_PIXEL_PNG }
      ])],
      errors: []
    }),
    storage: {
      createStagingBatch: async () => {},
      saveStagingFile: async () => { stagedFiles += 1; return { relativePath: "never.png" }; },
      removeStagingBatch: async () => {},
      resolveStagingPath: () => "unused"
    }
  });

  assert.equal(preview.validCount, 0);
  assert.equal(preview.errorCount, 1);
  assert.equal(stagedFiles, 0);
  assert.equal(persisted.certificateImportBatches[0].eventId, "E1");
});

test("certificate import rejects an OOXML workbook whose sanitized filename is not .xlsx", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const workbook = await buildMixedWorkbook();
    const response = await previewWorkbook(baseUrl, admin.cookie, workbook, "workbook.xlsx.txt");
    assert.equal(response.status, 422);
  }, { prefix: "certificate-import-extension-" });
});

test("certificate import lists recoverable preview batches only for the selected event", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const workbook = await buildMixedWorkbook();
    const created = await previewWorkbook(baseUrl, admin.cookie, workbook, "recoverable.xlsx");
    assert.equal(created.status, 201);
    const preview = await created.json();

    const response = await fetch(
      `${baseUrl}/api/admin/events/wz-aerospace-2026/certificate-imports`,
      withSession(admin.cookie)
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.rows.map((row) => row.id), [preview.id]);
    assert.equal(JSON.stringify(payload).includes("relativePath"), false);
    assert.equal(JSON.stringify(payload).includes("expectedCertificateStates"), false);
  }, { prefix: "certificate-import-recovery-" });
});

test("certificate import expiry cleanup clears preview data and staging with an injected clock", async () => {
  assert.equal(typeof certificateImports.cleanupExpiredCertificateImportPreviews, "function");
  assert.equal(typeof certificateImports.CERTIFICATE_IMPORT_PREVIEW_TTL_MS, "number");

  let persisted = serviceDb();
  const oldCandidate = previewCandidateForDb(persisted, [stagedCertificate(1)]);
  persisted.certificateImportBatches.push(
    {
      id: "B-EXPIRED", eventId: "E1", createdBy: "U9001", originalName: "expired.xlsx", status: "preview",
      previewJson: [oldCandidate], validCount: 1, errorCount: 1, replaceCount: 0,
      createdAt: "2026-07-17T00:00:00.000Z", committedAt: null
    },
    {
      id: "B-FRESH", eventId: "E1", createdBy: "U9001", originalName: "fresh.xlsx", status: "preview",
      previewJson: [previewCandidateForDb(persisted, [stagedCertificate(2)])], validCount: 1, errorCount: 0, replaceCount: 0,
      createdAt: "2026-07-18T11:59:59.999Z", committedAt: null
    }
  );
  persisted.certificateImportErrors.push({ id: "CIE-EXPIRED", batchId: "B-EXPIRED", rowNumber: 2, registrationId: approvedRegistration.id, message: "keep audit error" });
  const removed = [];
  const cleaned = await certificateImports.cleanupExpiredCertificateImportPreviews({
    store: {
      readDb: async () => structuredClone(persisted),
      writeDb: async (next) => { persisted = structuredClone(next); }
    },
    makeId: sequentialIds(),
    now: () => "2026-07-18T12:00:00.000Z",
    storage: {
      removeStagingBatch: async (batchId) => { removed.push(batchId); },
      resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/${relativePath}`
    }
  });

  assert.deepEqual(cleaned, ["B-EXPIRED"]);
  const expired = persisted.certificateImportBatches.find((batch) => batch.id === "B-EXPIRED");
  const fresh = persisted.certificateImportBatches.find((batch) => batch.id === "B-FRESH");
  assert.equal(expired.status, "expired");
  assert.deepEqual(expired.previewJson, []);
  assert.equal(fresh.status, "preview");
  assert.equal(fresh.previewJson.length, 1);
  assert.deepEqual(removed, ["B-EXPIRED"]);
  assert.equal(persisted.certificateImportErrors.some((row) => row.batchId === "B-EXPIRED"), true);
});

test("certificate import list cleanup cannot overwrite a concurrent commit", async () => {
  let persisted = serviceDb();
  persisted.certificateImportBatches.push({
    id: "B-RACE",
    eventId: "E1",
    createdBy: "U9001",
    originalName: "race.xlsx",
    status: "preview",
    previewJson: [],
    validCount: 0,
    errorCount: 0,
    replaceCount: 0,
    createdAt: "2026-07-17T00:00:00.000Z",
    committedAt: null
  });

  let mutationTail = Promise.resolve();
  let pauseFirstRead = true;
  let releaseCommitRead;
  let commitReadStarted;
  const commitReadGate = new Promise((resolve) => { releaseCommitRead = resolve; });
  const commitReadStartedGate = new Promise((resolve) => { commitReadStarted = resolve; });
  let releaseExpiredWrite;
  const expiredWriteGate = new Promise((resolve) => { releaseExpiredWrite = resolve; });
  const store = {
    async withMutationLock(handler) {
      let release;
      const previous = mutationTail;
      mutationTail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await handler();
      } finally {
        release();
      }
    },
    async readDb() {
      const snapshot = structuredClone(persisted);
      if (pauseFirstRead) {
        pauseFirstRead = false;
        commitReadStarted();
        await commitReadGate;
      }
      return snapshot;
    },
    async writeDb(next) {
      if (next.certificateImportBatches.find((batch) => batch.id === "B-RACE")?.status === "expired") {
        await expiredWriteGate;
      }
      persisted = structuredClone(next);
    }
  };
  const storage = {
    removeStagingBatch: async () => {},
    resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/${relativePath}`
  };

  const commit = store.withMutationLock(() => commitCertificateImport({
    batchId: "B-RACE",
    store,
    makeId: sequentialIds(),
    now: () => "2026-07-18T12:00:00.000Z",
    storage
  }));
  await commitReadStartedGate;
  const list = certificateImports.listActiveCertificateImportPreviews({
    eventId: "E1",
    store,
    makeId: sequentialIds(),
    now: () => "2026-07-18T12:00:00.000Z",
    storage
  });
  await new Promise((resolve) => setImmediate(resolve));

  releaseCommitRead();
  await commit;
  releaseExpiredWrite();
  await list;

  assert.equal(
    persisted.certificateImportBatches.find((batch) => batch.id === "B-RACE").status,
    "committed"
  );
});

test("certificate import list cleanup serializes with concurrent preview creation and cancellation", async () => {
  const scenarios = [
    {
      name: "preview creation",
      mutate(db) {
        db.certificateImportBatches.push({
          id: "B-NEW",
          eventId: "E1",
          createdBy: "U9001",
          originalName: "new.xlsx",
          status: "preview",
          previewJson: [],
          validCount: 0,
          errorCount: 0,
          replaceCount: 0,
          createdAt: "2026-07-18T11:59:00.000Z",
          committedAt: null
        });
      },
      verify(db) {
        assert.equal(db.certificateImportBatches.some((batch) => batch.id === "B-NEW"), true);
      }
    },
    {
      name: "cancellation",
      mutate(db) {
        const batch = db.certificateImportBatches.find((row) => row.id === "B-RACE");
        batch.status = "cancelled";
        batch.previewJson = [];
      },
      verify(db) {
        assert.equal(db.certificateImportBatches.find((batch) => batch.id === "B-RACE").status, "cancelled");
      }
    }
  ];

  for (const scenario of scenarios) {
    let persisted = serviceDb();
    persisted.certificateImportBatches.push({
      id: "B-RACE",
      eventId: "E1",
      createdBy: "U9001",
      originalName: "race.xlsx",
      status: "preview",
      previewJson: [],
      validCount: 0,
      errorCount: 0,
      replaceCount: 0,
      createdAt: "2026-07-17T00:00:00.000Z",
      committedAt: null
    });

    let mutationTail = Promise.resolve();
    let pauseFirstRead = true;
    let releaseMutationRead;
    let mutationReadStarted;
    const mutationReadGate = new Promise((resolve) => { releaseMutationRead = resolve; });
    const mutationReadStartedGate = new Promise((resolve) => { mutationReadStarted = resolve; });
    let releaseExpiredWrite;
    const expiredWriteGate = new Promise((resolve) => { releaseExpiredWrite = resolve; });
    const store = {
      async withMutationLock(handler) {
        let release;
        const previous = mutationTail;
        mutationTail = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
          return await handler();
        } finally {
          release();
        }
      },
      async readDb() {
        const snapshot = structuredClone(persisted);
        if (pauseFirstRead) {
          pauseFirstRead = false;
          mutationReadStarted();
          await mutationReadGate;
        }
        return snapshot;
      },
      async writeDb(next) {
        if (next.certificateImportBatches.find((batch) => batch.id === "B-RACE")?.status === "expired") {
          await expiredWriteGate;
        }
        persisted = structuredClone(next);
      }
    };
    const storage = {
      removeStagingBatch: async () => {},
      resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/${relativePath}`
    };

    const mutation = store.withMutationLock(async () => {
      const db = await store.readDb();
      scenario.mutate(db);
      await store.writeDb(db);
    });
    await mutationReadStartedGate;
    const list = certificateImports.listActiveCertificateImportPreviews({
      eventId: "E1",
      store,
      makeId: sequentialIds(),
      now: () => "2026-07-18T12:00:00.000Z",
      storage
    });
    await new Promise((resolve) => setImmediate(resolve));

    releaseMutationRead();
    await mutation;
    releaseExpiredWrite();
    await list;

    assert.doesNotThrow(() => scenario.verify(persisted), scenario.name);
  }
});
