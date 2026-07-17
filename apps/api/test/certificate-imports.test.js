import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { buildCertificateTemplate } from "../src/certificates/template.js";
import {
  deletePrivateFile,
  readImportStagingFile,
  saveCertificateImportFile,
  saveImportStagingFile
} from "../src/files/storage.js";
import {
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

function workbookForm(buffer, name = "certificates.xlsx") {
  const form = new FormData();
  form.append("workbook", new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }), name);
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

async function previewWorkbook(baseUrl, cookie, buffer, name) {
  return fetch(`${baseUrl}/api/admin/certificate-imports/preview`, withSession(cookie, {
    method: "POST",
    body: workbookForm(buffer, name)
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
      { slot: 1, title: "一等奖证书", mimeType: "image/png", replacing: false, previewUrl: `/api/admin/certificate-imports/${preview.id}/previews/2/1` },
      { slot: 2, title: "优秀选手证书", mimeType: "image/png", replacing: false, previewUrl: `/api/admin/certificate-imports/${preview.id}/previews/2/2` }
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

    const errorReport = await fetch(`${baseUrl}/api/admin/certificate-imports/${preview.id}/errors.xlsx`, withSession(admin.cookie));
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

    const commitResponse = await fetch(`${baseUrl}/api/admin/certificate-imports/${preview.id}/commit`, withSession(admin.cookie, { method: "POST" }));
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
    await assert.rejects(fs.access(stagingDir));

    const duplicateCommit = await fetch(`${baseUrl}/api/admin/certificate-imports/${preview.id}/commit`, withSession(admin.cookie, { method: "POST" }));
    assert.equal(duplicateCommit.status, 409);

    const replacementResponse = await previewWorkbook(baseUrl, admin.cookie, workbook, "replacement.xlsx");
    assert.equal(replacementResponse.status, 201);
    const replacement = await replacementResponse.json();
    assert.equal(replacement.validCount, 1);
    assert.equal(replacement.replaceCount, 2);
    assert.equal(replacement.candidates[0].certificates.every((certificate) => certificate.replacing), true);

    const replacementStagingDir = path.join(tempDir, "uploads", "import-staging", replacement.id);
    assert.equal((await fs.readdir(replacementStagingDir)).length, 2);
    const cancel = await fetch(`${baseUrl}/api/admin/certificate-imports/${replacement.id}`, withSession(admin.cookie, { method: "DELETE" }));
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

    const response = await fetch(`${baseUrl}/api/admin/certificate-imports/${preview.id}/previews/2/1`, withSession(admin.cookie));
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
    previewJson: [previewCandidate([stagedCertificate(1), stagedCertificate(2)])],
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
    previewJson: [previewCandidate([stagedCertificate(1)])],
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

  assert.deepEqual(result, { id: "B2", status: "committed", createdCount: 0, replacedCount: 1 });
  assert.equal(persisted.certificateImportBatches[0].status, "committed");
  assert.equal(persisted.certificates[0].filePath, "C:/uploads/certificates/new.png");
  assert.deepEqual(persisted.fileCleanupJournal.map((marker) => marker.category).sort(), [
    "certificate-import-replaced", "certificate-import-staging"
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
});

test("certificate import commit journals new orphan files when database persistence and rollback deletion both fail", async () => {
  let persisted = serviceDb({ withExistingCertificate: true });
  persisted.certificateImportBatches.push({
    id: "B4", eventId: "E1", createdBy: "U9001", originalName: "orphan.xlsx", status: "preview",
    previewJson: [previewCandidate([stagedCertificate(1), stagedCertificate(2)])],
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
    category: "certificate-import-staging"
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
      candidates: [previewCandidate([{ ...stagedCertificate(1), buffer: ONE_PIXEL_PNG }])],
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
});

test("certificate import commit journals a failed formal write target when rollback deletion also fails", async () => {
  let persisted = serviceDb();
  persisted.certificateImportBatches.push({
    id: "B6", eventId: "E1", createdBy: "U9001", originalName: "partial.xlsx", status: "preview",
    previewJson: [previewCandidate([stagedCertificate(1)])],
    validCount: 1, errorCount: 0, replaceCount: 0, createdAt: "2026-07-17T00:00:00.000Z", committedAt: null
  });
  let writes = 0;
  const failedWrite = new Error("formal write failed");
  failedWrite.cleanupTarget = {
    filePath: "C:/uploads/certificates/partial.png",
    storedName: "partial.png",
    fileName: "partial.png",
    category: "certificate-import-new"
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
});

test("certificate import preview journals staging cleanup failure when no event can own the batch", async () => {
  let persisted = serviceDb();
  persisted.events = [];
  persisted.registrations[0].eventId = null;
  let writes = 0;
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
      candidates: [previewCandidate([{ ...stagedCertificate(1), buffer: ONE_PIXEL_PNG }])],
      errors: []
    }),
    storage: {
      saveStagingFile: async () => ({ relativePath: "2-1.png" }),
      removeStagingBatch: async () => { throw new Error("no-event cleanup failed"); },
      resolveStagingPath: (_batchId, relativePath) => `C:/uploads/import-staging/B7/${relativePath}`
    }
  }), (error) => {
    assert.equal(error.status, 422);
    return true;
  });

  assert.equal(writes, 1);
  assert.equal(persisted.fileCleanupJournal.length, 1);
  assert.equal(persisted.fileCleanupJournal[0].category, "certificate-import-staging");
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
      candidates: [previewCandidate([{ ...stagedCertificate(1), buffer: ONE_PIXEL_PNG }])],
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
    id: "B11", status: "preview", previewJson: [previewCandidate([stagedCertificate(1)])]
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
