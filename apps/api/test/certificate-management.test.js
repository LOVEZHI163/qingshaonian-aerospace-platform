import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import express from "express";

import { createCertificatesRouter } from "../src/routes/certificates.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

function certificateForm(buffer, fileName, mimeType, fields = {}) {
  const form = new FormData();
  form.append("certificate", new Blob([buffer], { type: mimeType }), fileName);
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  return form;
}

function uploadCertificate(baseUrl, cookie, registrationId, slot, {
  buffer = ONE_PIXEL_PNG,
  fileName = `slot-${slot}.png`,
  mimeType = "image/png",
  title = `证书 ${slot}`
} = {}) {
  return fetch(`${baseUrl}/api/admin/registrations/${registrationId}/certificates/${slot}`, withSession(cookie, {
    method: "POST",
    body: certificateForm(buffer, fileName, mimeType, { title })
  }));
}

function jsonRequest(method, body, cookie) {
  return withSession(cookie, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function responseJson(response) {
  const payload = await response.json();
  assert.ok(payload && typeof payload === "object");
  return payload;
}

function manualDb() {
  return {
    registrations: [{
      id: "R1",
      userId: "U1",
      organizationId: null,
      athlete: { name: "测试运动员" },
      projectName: "测试赛项",
      awardName: "",
      rank: "",
      score: ""
    }],
    certificates: [{
      id: "C1",
      registrationId: "R1",
      slot: 1,
      title: "旧证书",
      userId: "U1",
      organizationId: null,
      fileName: "old.png",
      storedName: "old.png",
      filePath: "/safe/certificates/old.png",
      awardName: "",
      rank: "",
      score: "",
      status: "draft",
      source: "manual",
      importBatchId: null,
      uploadedAt: "2026-07-17T00:00:00.000Z",
      publishedAt: "",
      cleanedAt: ""
    }],
    organizations: [],
    memberships: [],
    fileCleanupJournal: []
  };
}

function paginationDb() {
  const registrations = [
    { id: "R1", eventId: "E1", group: "G1", projectId: "P1", projectName: "Project one", athlete: { name: "Alice", school: "A" } },
    { id: "R2", eventId: "E1", group: "G1", projectId: "P1", projectName: "Project one", athlete: { name: "Alice", school: "B" } },
    { id: "R3", eventId: "E1", group: "G2", projectId: "P2", projectName: "Project two", athlete: { name: "Bob", school: "C" } },
    { id: "R4", eventId: "E2", group: "G1", projectId: "P1", projectName: "Project one", athlete: { name: "Alice", school: "D" } }
  ];
  return {
    registrations,
    certificates: [
      { id: "C1", registrationId: "R1", slot: 1, title: "First", fileName: "first.png", storedName: "first.png", filePath: "/safe/first.png", status: "draft", source: "manual", importBatchId: null, uploadedAt: "2026-07-17T00:00:00.000Z", publishedAt: "", cleanedAt: "" },
      { id: "C2", registrationId: "R2", slot: 1, title: "Second", fileName: "second.png", storedName: "second.png", filePath: "/safe/second.png", status: "draft", source: "manual", importBatchId: null, uploadedAt: "2026-07-18T00:00:00.000Z", publishedAt: "", cleanedAt: "" },
      { id: "C3", registrationId: "R3", slot: 1, title: "Third", fileName: "third.png", storedName: "third.png", filePath: "/safe/third.png", status: "published", source: "manual", importBatchId: null, uploadedAt: "2026-07-18T00:00:00.000Z", publishedAt: "2026-07-18T00:00:00.000Z", cleanedAt: "" },
      { id: "C4", registrationId: "R4", slot: 1, title: "Fourth", fileName: "fourth.png", storedName: "fourth.png", filePath: "/safe/fourth.png", status: "draft", source: "manual", importBatchId: null, uploadedAt: "2026-07-18T00:00:00.000Z", publishedAt: "", cleanedAt: "" }
    ],
    organizations: [],
    memberships: [],
    fileCleanupJournal: []
  };
}

async function withCertificateRouter({ store, storage }, fn) {
  const app = express();
  const allow = (req, _res, next) => {
    req.user = { id: "ADMIN", type: "admin" };
    next();
  };
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  let sequence = 0;
  app.use("/api", createCertificatesRouter({
    store,
    storage,
    requireUser: allow,
    requireAdmin: allow,
    requirePasswordReady: allow,
    asyncRoute: wrap,
    mutationAsyncRoute: wrap,
    makeId: (prefix) => `${prefix}${++sequence}`,
    now: () => "2026-07-17T12:00:00.000Z"
  }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("admin certificate list filters, sorts stably, and returns bounded paging metadata", async () => {
  let persisted = paginationDb();
  const store = {
    readDb: async () => structuredClone(persisted),
    writeDb: async (next) => { persisted = structuredClone(next); }
  };
  const storage = { saveFile: async () => ({}), deleteFile: async () => {}, readFile: async () => ONE_PIXEL_PNG };

  await withCertificateRouter({ store, storage }, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/admin/certificates?eventId=E1&status=draft&group=G1&projectId=P1&name=Alice&sort=name&direction=asc&page=1&pageSize=1`);
    assert.equal(first.status, 200);
    const firstPayload = await responseJson(first);
    assert.deepEqual({ total: firstPayload.total, page: firstPayload.page, pageSize: firstPayload.pageSize }, { total: 2, page: 1, pageSize: 1 });
    assert.deepEqual(firstPayload.rows.map((row) => row.id), ["C1"]);

    const second = await fetch(`${baseUrl}/api/admin/certificates?eventId=E1&status=draft&group=G1&projectId=P1&name=Alice&sort=name&direction=asc&page=2&pageSize=1`);
    assert.equal(second.status, 200);
    assert.deepEqual((await responseJson(second)).rows.map((row) => row.id), ["C2"]);

    const tooLarge = await fetch(`${baseUrl}/api/admin/certificates?pageSize=101`);
    assert.equal(tooLarge.status, 422);
  });
});

test("manual certificate management uploads both slots, edits, replaces, deletes, and changes status in bulk", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");

    const firstUpload = await uploadCertificate(baseUrl, admin.cookie, "R20260627001", 1, { title: "一等奖图片" });
    const secondUpload = await uploadCertificate(baseUrl, admin.cookie, "R20260627001", 2, {
      buffer: PDF,
      fileName: "runner-up.pdf",
      mimeType: "application/pdf",
      title: "二等奖文件"
    });
    assert.equal(firstUpload.status, 201);
    assert.equal(secondUpload.status, 201);

    const first = (await responseJson(firstUpload)).row;
    const second = (await responseJson(secondUpload)).row;
    assert.deepEqual([first.slot, second.slot], [1, 2]);
    assert.deepEqual([first.status, second.status], ["draft", "draft"]);
    assert.equal(first.title, "一等奖图片");
    assert.equal(second.title, "二等奖文件");
    let persistedDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const firstFilePath = persistedDb.certificates.find((row) => row.id === first.id).filePath;
    const secondFilePath = persistedDb.certificates.find((row) => row.id === second.id).filePath;
    assert.deepEqual(await fs.readFile(firstFilePath), ONE_PIXEL_PNG);
    assert.deepEqual(await fs.readFile(secondFilePath), PDF);

    const resultUpdate = await fetch(`${baseUrl}/api/admin/registrations/R20260627001/result`, jsonRequest("POST", {
      awardName: "特等奖",
      rank: "1",
      score: "99.9"
    }, admin.cookie));
    assert.equal(resultUpdate.status, 200);
    const resultPayload = await responseJson(resultUpdate);
    assert.deepEqual(resultPayload.certificates.map((row) => ({
      id: row.id,
      awardName: row.awardName,
      rank: row.rank,
      score: row.score
    })).sort((left, right) => left.id.localeCompare(right.id)), [first.id, second.id].sort().map((id) => ({
      id,
      awardName: "特等奖",
      rank: "1",
      score: "99.9"
    })));

    const resultCertificates = (await responseJson(await fetch(`${baseUrl}/api/admin/certificates`, withSession(admin.cookie)))).rows
      .filter((row) => row.registrationId === "R20260627001");
    assert.equal(resultCertificates.length, 2);
    assert.equal(resultCertificates.every((row) => row.awardName === "特等奖" && row.rank === "1" && row.score === "99.9"), true);

    async function assertExactResultSync(expected) {
      const response = await fetch(`${baseUrl}/api/admin/registrations/R20260627001/result`, jsonRequest("POST", expected, admin.cookie));
      assert.equal(response.status, 200);
      const payload = await responseJson(response);
      assert.equal(payload.certificates.length, 2);
      assert.equal(payload.certificates.every((row) => (
        row.awardName === expected.awardName && row.rank === expected.rank && row.score === expected.score
      )), true);
      assert.equal(payload.certificates.every((row) => !("filePath" in row) && !("storedName" in row)), true);
      const persisted = (await responseJson(await fetch(`${baseUrl}/api/admin/certificates`, withSession(admin.cookie)))).rows
        .filter((row) => row.registrationId === "R20260627001");
      assert.equal(persisted.length, 2);
      assert.equal(persisted.every((row) => (
        row.awardName === expected.awardName && row.rank === expected.rank && row.score === expected.score
      )), true);
    }

    await assertExactResultSync({ awardName: "", rank: "1", score: "99.9" });
    await assertExactResultSync({ awardName: "特等奖", rank: "", score: "99.9" });
    await assertExactResultSync({ awardName: "特等奖", rank: "1", score: "" });

    const metadata = await fetch(`${baseUrl}/api/admin/certificates/${first.id}`, jsonRequest("PATCH", {
      title: "  金奖证书  ",
      awardName: "一等奖",
      rank: "1",
      score: "99.5"
    }, admin.cookie));
    assert.equal(metadata.status, 200);
    assert.deepEqual(((await responseJson(metadata)).row), {
      ...(await responseJson(await fetch(`${baseUrl}/api/admin/certificates`, withSession(admin.cookie)))).rows.find((row) => row.id === first.id),
      title: "金奖证书",
      awardName: "一等奖",
      rank: "1",
      score: "99.5"
    });

    const replacement = await uploadCertificate(baseUrl, admin.cookie, "R20260627001", 1, { title: "替换后的金奖" });
    assert.equal(replacement.status, 201);
    const replaced = (await responseJson(replacement)).row;
    assert.equal(replaced.id, first.id);
    assert.equal(replaced.title, "替换后的金奖");
    assert.equal(replaced.status, "draft");
    persistedDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const replacedFilePath = persistedDb.certificates.find((row) => row.id === first.id).filePath;
    assert.notEqual(replacedFilePath, firstFilePath);
    await assert.rejects(fs.access(firstFilePath), { code: "ENOENT" });

    const published = await fetch(`${baseUrl}/api/admin/certificates/bulk-status`, jsonRequest("POST", {
      ids: [first.id, second.id],
      status: "published"
    }, admin.cookie));
    assert.equal(published.status, 200);
    const publishedRows = (await responseJson(published)).rows;
    assert.equal(publishedRows.every((row) => row.status === "published" && row.publishedAt), true);

    const withdrawn = await fetch(`${baseUrl}/api/admin/certificates/bulk-status`, jsonRequest("POST", {
      ids: [first.id, second.id],
      status: "draft"
    }, admin.cookie));
    assert.equal(withdrawn.status, 200);
    assert.equal((await responseJson(withdrawn)).rows.every((row) => row.status === "draft" && !row.publishedAt), true);

    const removed = await fetch(`${baseUrl}/api/admin/certificates/${second.id}`, withSession(admin.cookie, { method: "DELETE" }));
    assert.equal(removed.status, 204);
    await assert.rejects(fs.access(secondFilePath), { code: "ENOENT" });
    persistedDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(persistedDb.certificates.some((row) => row.id === second.id), false);
  }, { prefix: "manual-certificate-management-crud-" });
});

test("manual certificate management applies the same file authorization to preview and download", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const athleteOwner = await loginAs(baseUrl, "13800000001", "123456");
    const organizationOwner = await loginAs(baseUrl, "13800000011", "123456");
    const outsiderRegistration = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "无关用户", phone: "13600007777", password: "Strong123" })
    });
    assert.equal(outsiderRegistration.status, 201);
    const outsider = await loginAs(baseUrl, "13600007777", "Strong123");

    const upload = await uploadCertificate(baseUrl, admin.cookie, "R20260627001", 1, { title: "飞行金奖" });
    assert.equal(upload.status, 201);
    const certificate = (await responseJson(upload)).row;
    const fileUrl = `${baseUrl}/api/certificates/${certificate.id}/file`;

    assert.equal((await fetch(fileUrl)).status, 401);
    assert.equal((await fetch(fileUrl, withSession(athleteOwner.cookie))).status, 403);
    assert.equal((await fetch(fileUrl, withSession(organizationOwner.cookie))).status, 403);
    assert.equal((await fetch(fileUrl, withSession(outsider.cookie))).status, 403);

    const adminPreview = await fetch(fileUrl, withSession(admin.cookie));
    assert.equal(adminPreview.status, 200);
    assert.equal(adminPreview.headers.get("content-type"), "image/png");
    assert.match(adminPreview.headers.get("content-disposition") || "", /^inline;/);
    assert.deepEqual(Buffer.from(await adminPreview.arrayBuffer()), ONE_PIXEL_PNG);

    const publish = await fetch(`${baseUrl}/api/admin/certificates/bulk-status`, jsonRequest("POST", {
      ids: [certificate.id], status: "published"
    }, admin.cookie));
    assert.equal(publish.status, 200);

    for (const viewer of [athleteOwner, organizationOwner]) {
      const preview = await fetch(fileUrl, withSession(viewer.cookie));
      assert.equal(preview.status, 200);
      assert.match(preview.headers.get("content-disposition") || "", /^inline;/);
    }
    assert.equal((await fetch(fileUrl, withSession(outsider.cookie))).status, 403);

    const download = await fetch(`${fileUrl}?download=1`, withSession(athleteOwner.cookie));
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") || "", /^attachment;/);
    assert.match(download.headers.get("content-disposition") || "", /\.png/i);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), ONE_PIXEL_PNG);

    const adminList = await fetch(`${baseUrl}/api/admin/certificates`, withSession(admin.cookie));
    assert.equal(adminList.status, 200);
    assert.equal((await responseJson(adminList)).rows.some((row) => row.id === certificate.id), true);
    const ownList = await fetch(`${baseUrl}/api/me/certificates`, withSession(athleteOwner.cookie));
    assert.deepEqual((await responseJson(ownList)).rows.map((row) => row.id), [certificate.id]);
    const organizationList = await fetch(`${baseUrl}/api/organizations/O1001/certificates`, withSession(organizationOwner.cookie));
    assert.deepEqual((await responseJson(organizationList)).rows.map((row) => row.id), [certificate.id]);
  }, { prefix: "manual-certificate-management-access-" });
});

test("manual certificate management rejects invalid uploads, preserves cleaned history metadata, and never serves a cleaned file", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const athleteOwner = await loginAs(baseUrl, "13800000001", "123456");
    const organizationOwner = await loginAs(baseUrl, "13800000011", "123456");

    const invalidSlot = await uploadCertificate(baseUrl, admin.cookie, "R20260627001", 3);
    assert.equal(invalidSlot.status, 422);
    const blankTitle = await uploadCertificate(baseUrl, admin.cookie, "R20260627001", 1, { title: "   " });
    assert.equal(blankTitle.status, 422);
    const disguised = await uploadCertificate(baseUrl, admin.cookie, "R20260627001", 1, {
      buffer: Buffer.from("MZ this is not an image"),
      fileName: "malware.png",
      mimeType: "image/png",
      title: "伪装文件"
    });
    assert.equal(disguised.status, 422);

    const tooLarge = Buffer.concat([ONE_PIXEL_PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const oversized = await uploadCertificate(baseUrl, admin.cookie, "R20260627001", 1, {
      buffer: tooLarge,
      title: "超限文件"
    });
    assert.equal(oversized.status, 413);

    const valid = await uploadCertificate(baseUrl, admin.cookie, "R20260627001", 1, { title: "待清理证书" });
    assert.equal(valid.status, 201);
    const certificate = (await responseJson(valid)).row;
    const publish = await fetch(`${baseUrl}/api/admin/certificates/bulk-status`, jsonRequest("POST", {
      ids: [certificate.id], status: "published"
    }, admin.cookie));
    assert.equal(publish.status, 200);
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.certificates.find((row) => row.id === certificate.id).cleanedAt = "2026-07-17T12:00:00.000Z";
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
    assert.equal((await fetch(`${baseUrl}/api/certificates/${certificate.id}/file`, withSession(admin.cookie))).status, 404);

    const adminRows = (await responseJson(await fetch(`${baseUrl}/api/admin/certificates`, withSession(admin.cookie)))).rows;
    const cleaned = adminRows.find((row) => row.id === certificate.id);
    assert.ok(cleaned);
    assert.equal(cleaned.cleanedAt, "2026-07-17T12:00:00.000Z");
    assert.equal(Object.hasOwn(cleaned, "previewUrl"), false);
    assert.equal(Object.hasOwn(cleaned, "downloadUrl"), false);
    const ownRows = (await responseJson(await fetch(`${baseUrl}/api/me/certificates`, withSession(athleteOwner.cookie)))).rows;
    const ownCleaned = ownRows.find((row) => row.id === certificate.id);
    assert.ok(ownCleaned);
    assert.equal(ownCleaned.cleanedAt, "2026-07-17T12:00:00.000Z");
    assert.equal(Object.hasOwn(ownCleaned, "downloadUrl"), false);
    const organizationRows = (await responseJson(await fetch(`${baseUrl}/api/organizations/O1001/certificates`, withSession(organizationOwner.cookie)))).rows;
    const organizationCleaned = organizationRows.find((row) => row.id === certificate.id);
    assert.ok(organizationCleaned);
    assert.equal(organizationCleaned.cleanedAt, "2026-07-17T12:00:00.000Z");
    assert.equal(Object.hasOwn(organizationCleaned, "downloadUrl"), false);

    const files = await fs.readdir(path.join(tempDir, "uploads", "certificates"));
    assert.equal(files.length, 1);
  }, { prefix: "manual-certificate-management-validation-" });
});

test("manual certificate management journals old files when committed replacement and deletion cleanup fails", async () => {
  let persisted = manualDb();
  const store = {
    readDb: async () => structuredClone(persisted),
    writeDb: async (db) => { persisted = structuredClone(db); }
  };
  const storage = {
    saveFile: async () => ({
      originalName: "new.png",
      storedName: "new.png",
      filePath: "/safe/certificates/new.png"
    }),
    deleteFile: async () => { throw new Error("disk unavailable"); },
    readFile: async () => ONE_PIXEL_PNG
  };

  await withCertificateRouter({ store, storage }, async (baseUrl) => {
    const replacement = await fetch(`${baseUrl}/api/admin/registrations/R1/certificates/1`, {
      method: "POST",
      body: certificateForm(ONE_PIXEL_PNG, "new.png", "image/png", { title: "新证书" })
    });
    assert.equal(replacement.status, 201);
    assert.equal(persisted.certificates[0].filePath, "/safe/certificates/new.png");
    assert.deepEqual(persisted.fileCleanupJournal.map((row) => ({
      filePath: row.filePath,
      category: row.category,
      attempts: row.attempts,
      lastError: row.lastError
    })), [{
      filePath: "/safe/certificates/old.png",
      category: "certificate-manual-replaced",
      attempts: 3,
      lastError: "disk unavailable"
    }]);

    const removed = await fetch(`${baseUrl}/api/admin/certificates/C1`, { method: "DELETE" });
    assert.equal(removed.status, 204);
    assert.deepEqual(persisted.certificates, []);
    assert.deepEqual(persisted.fileCleanupJournal.map((row) => row.category).sort(), [
      "certificate-manual-deleted",
      "certificate-manual-replaced"
    ]);
    assert.equal(persisted.fileCleanupJournal.every((row) => row.attempts === 3), true);
  });
});

test("manual certificate management rolls back a new file and journals it when database persistence and cleanup both fail", async () => {
  let persisted = manualDb();
  let writes = 0;
  const store = {
    readDb: async () => structuredClone(persisted),
    writeDb: async (db) => {
      writes += 1;
      if (writes === 1) throw new Error("database unavailable");
      persisted = structuredClone(db);
    }
  };
  const storage = {
    saveFile: async () => ({
      originalName: "orphan.png",
      storedName: "orphan.png",
      filePath: "/safe/certificates/orphan.png"
    }),
    deleteFile: async () => { throw new Error("disk unavailable"); },
    readFile: async () => ONE_PIXEL_PNG
  };

  await withCertificateRouter({ store, storage }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/registrations/R1/certificates/1`, {
      method: "POST",
      body: certificateForm(ONE_PIXEL_PNG, "orphan.png", "image/png", { title: "不应提交" })
    });
    assert.equal(response.status, 500);
  });

  assert.equal(persisted.certificates[0].filePath, "/safe/certificates/old.png");
  assert.deepEqual(persisted.fileCleanupJournal.map((row) => ({
    filePath: row.filePath,
    category: row.category,
    attempts: row.attempts,
    lastError: row.lastError
  })), [{
    filePath: "/safe/certificates/orphan.png",
    category: "certificate-manual-new",
    attempts: 3,
    lastError: "disk unavailable"
  }]);
});

test("manual certificate management whitelists certificate fields in admin, owner, organization, and single payloads", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const athleteOwner = await loginAs(baseUrl, "13800000001", "123456");
    const organizationOwner = await loginAs(baseUrl, "13800000011", "123456");
    const upload = await uploadCertificate(baseUrl, admin.cookie, "R20260627001", 1, { title: "白名单证书" });
    assert.equal(upload.status, 201);
    const certificate = (await responseJson(upload)).row;
    const published = await fetch(`${baseUrl}/api/admin/certificates/bulk-status`, jsonRequest("POST", {
      ids: [certificate.id], status: "published"
    }, admin.cookie));
    assert.equal(published.status, 200);

    const legacyKey = ["certificate", "No"].join("");
    const unknownKey = ["internal", "Secret"].join("");
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const stored = db.certificates.find((row) => row.id === certificate.id);
    stored[legacyKey] = "LEGACY-LEAK";
    stored[unknownKey] = "UNKNOWN-LEAK";
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");

    const responses = [
      await fetch(`${baseUrl}/api/admin/certificates`, withSession(admin.cookie)),
      await fetch(`${baseUrl}/api/me/certificates`, withSession(athleteOwner.cookie)),
      await fetch(`${baseUrl}/api/organizations/O1001/certificates`, withSession(organizationOwner.cookie))
    ];
    for (const response of responses) {
      assert.equal(response.status, 200);
      const row = (await responseJson(response)).rows.find((item) => item.id === certificate.id);
      assert.ok(row);
      assert.equal(Object.hasOwn(row, legacyKey), false);
      assert.equal(Object.hasOwn(row, unknownKey), false);
      assert.equal(Object.hasOwn(row, "filePath"), false);
      assert.equal(Object.hasOwn(row, "storedName"), false);
    }

    const single = await fetch(`${baseUrl}/api/admin/certificates/${certificate.id}`, jsonRequest("PATCH", {
      title: "白名单证书（修改）"
    }, admin.cookie));
    assert.equal(single.status, 200);
    const row = (await responseJson(single)).row;
    assert.equal(Object.hasOwn(row, legacyKey), false);
    assert.equal(Object.hasOwn(row, unknownKey), false);
    assert.equal(Object.hasOwn(row, "filePath"), false);
    assert.equal(Object.hasOwn(row, "storedName"), false);
  }, { prefix: "manual-certificate-management-whitelist-" });
});
