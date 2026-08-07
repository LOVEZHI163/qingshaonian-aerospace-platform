import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import JSZip from "jszip";

import { ensureDbShape, seedDb } from "../src/data/seed.js";
import { createOrganizationLeadersRouter } from "../src/routes/organization-leaders.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const authorizationPdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

function authorizationForm(input = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(input)) form.set(key, String(value));
  form.set("authorization", new Blob([authorizationPdf], { type: "application/pdf" }), "leader-authorization.pdf");
  return form;
}

async function json(response) {
  const payload = await response.json();
  return { response, payload };
}

async function createLeader(baseUrl, session, input) {
  const response = await fetch(`${baseUrl}/api/organization/leaders`, withSession(session.cookie, {
    method: "POST",
    body: authorizationForm(input)
  }));
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return JSON.parse(body);
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function testRouter(store, options = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api", createOrganizationLeadersRouter({
    store,
    requireUser: (req, _res, next) => {
      req.user = options.user || store.currentUser();
      next();
    },
    requireAdmin: (req, res, next) => {
      req.user = options.user || store.currentUser();
      if (req.user?.type !== "admin") return res.status(403).json({ error: "admin required" });
      next();
    },
    requirePasswordReady: (_req, _res, next) => next(),
    asyncRoute: (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next),
    removePrivateFile: options.removePrivateFile
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  return app;
}

test("ordinary users receive 403 from every organization-leader API", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const requests = [
      ["GET", "/api/organization/leaders"],
      ["POST", "/api/organization/leaders/authorization-template.docx"],
      ["POST", "/api/organization/leaders"],
      ["PATCH", "/api/organization/leaders/leader-1"],
      ["PATCH", "/api/organization/leaders/leader-1/enabled"],
      ["GET", "/api/organization/leaders/leader-1/authorization/document-1"],
      ["GET", "/api/organization/leaders/leader-1/reviews"],
      ["GET", "/api/admin/organization-leaders"],
      ["PATCH", "/api/admin/organization-leaders/leader-1/review"],
      ["PATCH", "/api/admin/organization-leaders/leader-1/enabled"]
    ];

    for (const [method, pathname] of requests) {
      const response = await fetch(`${baseUrl}${pathname}`, withSession(ordinary.cookie, { method }));
      assert.equal(response.status, 403, `${method} ${pathname}`);
    }
  }, { prefix: "organization-leader-ordinary-permissions-" });
});

test("authorization template takes the approved operational organization name from the session", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const response = await fetch(`${baseUrl}/api/organization/leaders/authorization-template.docx`, withSession(owner.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "张老师",
        phone: "13800009999",
        organizationName: "客户端伪造组织"
      })
    }));

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /wordprocessingml\.document/);
    const archive = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
    const documentXml = await archive.file("word/document.xml").async("string");
    assert.match(documentXml, /温州市实验小学/);
    assert.match(documentXml, /张老师/);
    assert.match(documentXml, /13800009999/);
    assert.doesNotMatch(documentXml, /客户端伪造组织/);
  }, { prefix: "organization-leader-template-" });
});

test("organization owners manage only their own leaders and protected authorization history", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const otherOwner = await loginAs(baseUrl, "13800000012", "123456");
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const created = await createLeader(baseUrl, owner, {
      name: "张老师",
      phone: "13800009999",
      email: "leader@example.com",
      notes: "校队领队"
    });
    const leaderId = created.row.id;
    const firstDocumentId = created.document.id;

    const ownList = await json(await fetch(`${baseUrl}/api/organization/leaders`, withSession(owner.cookie)));
    assert.equal(ownList.response.status, 200);
    assert.deepEqual(ownList.payload.rows.map((row) => row.id), [leaderId]);
    assert.equal(Object.hasOwn(ownList.payload.rows[0].document, "filePath"), false);
    const otherList = await json(await fetch(`${baseUrl}/api/organization/leaders`, withSession(otherOwner.cookie)));
    assert.equal(otherList.response.status, 200);
    assert.deepEqual(otherList.payload.rows, []);

    const missingReplacement = await json(await fetch(`${baseUrl}/api/organization/leaders/${leaderId}`, withSession(owner.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "王老师" })
    })));
    assert.equal(missingReplacement.response.status, 422);
    assert.match(missingReplacement.payload.error, /授权书/);

    const replacement = authorizationForm({ name: "王老师" });
    const updated = await json(await fetch(`${baseUrl}/api/organization/leaders/${leaderId}`, withSession(owner.cookie, {
      method: "PATCH",
      body: replacement
    })));
    assert.equal(updated.response.status, 200, updated.payload.error);
    assert.equal(updated.payload.row.name, "王老师");
    assert.equal(updated.payload.row.reviewStatus, "pending");
    assert.equal(updated.payload.row.submissionVersion, 2);
    assert.notEqual(updated.payload.document.id, firstDocumentId);

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const documents = persisted.organizationLeaderDocuments.filter((row) => row.leaderId === leaderId);
    assert.equal(documents.length, 2);
    for (const document of documents) await fs.access(document.filePath);

    const foreignPatch = await fetch(`${baseUrl}/api/organization/leaders/${leaderId}/enabled`, withSession(otherOwner.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false })
    }));
    assert.equal(foreignPatch.status, 403);

    const reviews = await json(await fetch(`${baseUrl}/api/organization/leaders/${leaderId}/reviews`, withSession(owner.cookie)));
    assert.equal(reviews.response.status, 200);
    assert.deepEqual(reviews.payload.rows.map((row) => row.action), ["submitted", "submitted"]);
    assert.equal((await fetch(`${baseUrl}/api/organization/leaders/${leaderId}/reviews`, withSession(otherOwner.cookie))).status, 403);

    const ownerDownload = await fetch(`${baseUrl}/api/organization/leaders/${leaderId}/authorization/${firstDocumentId}`, withSession(owner.cookie));
    assert.equal(ownerDownload.status, 200);
    assert.deepEqual(Buffer.from(await ownerDownload.arrayBuffer()), authorizationPdf);
    assert.equal((await fetch(`${baseUrl}/api/organization/leaders/${leaderId}/authorization/${firstDocumentId}`, withSession(otherOwner.cookie))).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/organization/leaders/${leaderId}/authorization/${firstDocumentId}`, withSession(ordinary.cookie))).status, 403);
    const adminDownload = await fetch(`${baseUrl}/api/organization/leaders/${leaderId}/authorization/${firstDocumentId}`, withSession(admin.cookie));
    assert.equal(adminDownload.status, 200);
    assert.deepEqual(Buffer.from(await adminDownload.arrayBuffer()), authorizationPdf);
  }, { prefix: "organization-leader-owner-routes-" });
});

test("platform administrators filter, review, and enable leaders globally", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const firstOwner = await loginAs(baseUrl, "13800000011", "123456");
    const secondOwner = await loginAs(baseUrl, "13800000012", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const first = await createLeader(baseUrl, firstOwner, { name: "第一领队", phone: "13800009111" });
    const second = await createLeader(baseUrl, secondOwner, { name: "第二领队", phone: "13800009222" });

    assert.equal((await fetch(`${baseUrl}/api/admin/organization-leaders`, withSession(firstOwner.cookie))).status, 403);
    const pending = await json(await fetch(`${baseUrl}/api/admin/organization-leaders?reviewStatus=pending`, withSession(admin.cookie)));
    assert.equal(pending.response.status, 200);
    assert.deepEqual(new Set(pending.payload.rows.map((row) => row.id)), new Set([first.row.id, second.row.id]));
    const byOrganization = await json(await fetch(`${baseUrl}/api/admin/organization-leaders?organizationId=O1002`, withSession(admin.cookie)));
    assert.deepEqual(byOrganization.payload.rows.map((row) => row.id), [second.row.id]);

    const noReason = await json(await fetch(`${baseUrl}/api/admin/organization-leaders/${first.row.id}/review`, withSession(admin.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "rejected", reason: "" })
    })));
    assert.equal(noReason.response.status, 422);

    const approved = await json(await fetch(`${baseUrl}/api/admin/organization-leaders/${first.row.id}/review`, withSession(admin.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" })
    })));
    assert.equal(approved.response.status, 200, approved.payload.error);
    assert.equal(approved.payload.row.reviewStatus, "approved");

    const disabled = await json(await fetch(`${baseUrl}/api/admin/organization-leaders/${first.row.id}/enabled`, withSession(admin.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false })
    })));
    assert.equal(disabled.response.status, 200, disabled.payload.error);
    assert.equal(disabled.payload.row.enabled, false);

    const filtered = await json(await fetch(`${baseUrl}/api/admin/organization-leaders?reviewStatus=approved&enabled=false`, withSession(admin.cookie)));
    assert.deepEqual(filtered.payload.rows.map((row) => row.id), [first.row.id]);
  }, { prefix: "organization-leader-admin-routes-" });
});

test("leader creation journals its new private file when database persistence and immediate cleanup fail", async () => {
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "organization-leader-create-rollback-"));
  const previousUploadRoot = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = uploadRoot;
  let persisted = ensureDbShape(structuredClone(seedDb));
  const before = structuredClone(persisted);
  let writeAttempts = 0;
  let removeAttempts = 0;
  const store = {
    currentUser: () => persisted.users.find((row) => row.id === "U2001"),
    readDb: async () => structuredClone(persisted),
    writeDb: async (db) => {
      writeAttempts += 1;
      if (writeAttempts === 1) throw new Error("simulated leader database failure");
      persisted = structuredClone(db);
    }
  };
  const server = await listen(testRouter(store, {
    removePrivateFile: async () => {
      removeAttempts += 1;
      throw new Error("simulated private file cleanup failure");
    }
  }));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/organization/leaders`, {
      method: "POST",
      body: authorizationForm({ name: "写失败领队", phone: "13800009333" })
    });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /simulated leader database failure/);
    assert.equal(removeAttempts, 3);
    assert.equal(writeAttempts, 2);
    assert.deepEqual(persisted.organizationLeaders, before.organizationLeaders);
    assert.deepEqual(persisted.organizationLeaderDocuments, before.organizationLeaderDocuments);
    assert.deepEqual(persisted.organizationLeaderReviews, before.organizationLeaderReviews);
    assert.equal(persisted.fileCleanupJournal.length, before.fileCleanupJournal.length + 1);
    const marker = persisted.fileCleanupJournal.at(-1);
    assert.equal(marker.category, "organization-leader-documents");
    assert.equal(marker.attempts, 3);
    await fs.access(marker.filePath);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousUploadRoot === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previousUploadRoot;
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
});

test("failed authorization replacement removes only the new orphan and preserves historical documents", async () => {
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "organization-leader-update-rollback-"));
  const previousUploadRoot = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = uploadRoot;
  const oldPath = path.join(uploadRoot, "organization-leader-documents", "leader-existing", "old.pdf");
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  await fs.writeFile(oldPath, authorizationPdf);
  const persisted = ensureDbShape(structuredClone(seedDb));
  const now = "2026-08-07T08:00:00.000Z";
  persisted.organizationLeaders.push({
    id: "leader-existing", organizationId: "O1001", name: "原领队", phone: "13800009444",
    email: "", notes: "", currentDocumentId: "document-existing", reviewStatus: "approved",
    rejectionReason: "", enabled: true, submissionVersion: 1, reviewedBy: "U9001", reviewedAt: now,
    createdAt: now, updatedAt: now
  });
  persisted.organizationLeaderDocuments.push({
    id: "document-existing", leaderId: "leader-existing", version: 1,
    originalName: "old.pdf", storedName: "old.pdf", filePath: oldPath,
    mimeType: "application/pdf", sizeBytes: authorizationPdf.length, uploadedAt: now, cleanedAt: null
  });
  const before = structuredClone(persisted);
  const store = {
    currentUser: () => persisted.users.find((row) => row.id === "U2001"),
    readDb: async () => structuredClone(persisted),
    writeDb: async () => { throw new Error("simulated replacement database failure"); }
  };
  const server = await listen(testRouter(store));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/organization/leaders/leader-existing`, {
      method: "PATCH",
      body: authorizationForm({ name: "新领队" })
    });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /simulated replacement database failure/);
    assert.deepEqual(persisted, before);
    await fs.access(oldPath);
    const files = (await fs.readdir(uploadRoot, { recursive: true })).filter((entry) => String(entry).endsWith(".pdf"));
    assert.deepEqual(files, [path.join("organization-leader-documents", "leader-existing", "old.pdf")]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousUploadRoot === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previousUploadRoot;
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
});
