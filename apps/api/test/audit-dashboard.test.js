import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";
import { createFileStore } from "../src/data/file-store.js";
import { createMutationAsyncRoute } from "../src/data/mutation-lock.js";
import { createEventsRouter } from "../src/routes/events.js";
import { recordAudit } from "../src/services/audit.js";

function jsonRequest(method, body, cookie) {
  return withSession(cookie, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function payload(response) {
  const body = await response.json();
  assert.equal(response.ok, true, body.error || `request failed with ${response.status}`);
  return body;
}

test("audit dashboard sanitizes sensitive values before persisting summaries", () => {
  const db = { auditLogs: [] };
  const row = recordAudit(db, {
    actor: { id: "U1", name: "管理员" },
    action: "test.sanitize",
    targetType: "test",
    targetId: "T1",
    summary: "手机号 13800000001 文件 C:\\private\\award.png password=admin123 session=abc /var/uploads/cert.png",
    createdAt: "2026-07-18T08:00:00.000Z"
  });

  assert.match(row.summary, /138\*{4}0001/);
  assert.doesNotMatch(row.summary, /13800000001|admin123|session=abc|C:\\private|\/var\/uploads/);
  assert.equal(db.auditLogs[0], row);
});

test("audit dashboard redacts quoted JSON secrets, cookies, relative paths and sensitive actor names", () => {
  const db = { auditLogs: [] };
  const summarySecrets = ["admin123", "abc-session", "COOKIESECRET", "uploads/certificates/a.png"];
  const actorSecrets = ["ACTORSECRET", "uploads/actors/me.png"];
  const summary = `payload={"password":"${summarySecrets[0]}","session":"${summarySecrets[1]}"} Cookie: aerogp.sid=${summarySecrets[2]} file=${summarySecrets[3]}`;
  const actorName = `Normal Admin token="${actorSecrets[0]}" ${actorSecrets[1]}`;
  for (const secret of summarySecrets) assert.equal(summary.includes(secret), true, `summary fixture must contain ${secret}`);
  for (const secret of actorSecrets) assert.equal(actorName.includes(secret), true, `actor fixture must contain ${secret}`);

  const row = recordAudit(db, {
    actor: { id: "U-SENSITIVE", name: actorName },
    action: "event.publish",
    targetType: "event",
    targetId: "E-SAFE",
    summary,
    createdAt: "2026-07-18T08:00:00.000Z"
  });

  const persisted = JSON.stringify(db.auditLogs);
  for (const secret of [...summarySecrets, ...actorSecrets]) assert.doesNotMatch(persisted, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(row.actorName, /^Normal Admin/);
  assert.equal(row.action, "event.publish");
  assert.equal(row.targetType, "event");
  assert.equal(row.targetId, "E-SAFE");
});

test("audit dashboard returns event counts, registration window, recent imports and recent logs", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.certificateImportBatches.push({
      id: "B-DASHBOARD",
      eventId: "wz-aerospace-2026",
      createdBy: "U9001",
      originalName: "获奖证书.xlsx",
      status: "committed",
      previewJson: [],
      validCount: 2,
      errorCount: 0,
      replaceCount: 0,
      createdAt: "2026-07-18T08:00:00.000Z",
      committedAt: "2026-07-18T08:01:00.000Z"
    });
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");

    const response = await fetch(`${baseUrl}/api/admin/dashboard?eventId=wz-aerospace-2026`, withSession(admin.cookie));
    const body = await payload(response);
    assert.equal(body.event.id, "wz-aerospace-2026");
    assert.deepEqual(body.counts, {
      registrations: 2,
      pendingRegistrations: 1,
      pendingOrganizations: 0,
      draftCertificates: 0
    });
    assert.equal(typeof body.registrationWindow.open, "boolean");
    assert.deepEqual(body.recentImports.map((row) => row.id), ["B-DASHBOARD"]);
    assert.deepEqual(body.recentAuditLogs, []);

    const missing = await fetch(`${baseUrl}/api/admin/dashboard?eventId=missing`, withSession(admin.cookie));
    assert.equal(missing.status, 404);
  }, { prefix: "audit-dashboard-overview-" });
});

test("audit dashboard records organization, registration, event and certificate operations without secrets", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const apiActorSecrets = ["API-ACTOR-SECRET", "uploads/actors/api.png"];
    const unsafeActorName = `赛事管理员 token="${apiActorSecrets[0]}" ${apiActorSecrets[1]}`;
    for (const secret of apiActorSecrets) assert.equal(unsafeActorName.includes(secret), true);
    const actorDb = JSON.parse(await fs.readFile(dbPath, "utf8"));
    actorDb.users.find((row) => row.id === "U9001").name = unsafeActorName;
    await fs.writeFile(dbPath, JSON.stringify(actorDb, null, 2), "utf8");

    const reviewOrganization = await fetch(`${baseUrl}/api/admin/organizations/O1002/review`, jsonRequest("PATCH", {
      status: "rejected",
      reason: "资质信息需要更新"
    }, admin.cookie));
    assert.equal(reviewOrganization.status, 200);

    const disableOrganization = await fetch(`${baseUrl}/api/admin/organizations/O1002/status`, jsonRequest("PATCH", {
      status: "disabled"
    }, admin.cookie));
    assert.equal(disableOrganization.status, 200);
    assert.equal((await disableOrganization.json()).organization.status, "disabled");

    const reviewRegistration = await fetch(`${baseUrl}/api/registrations/R20260627001/status`, jsonRequest("PATCH", {
      status: "approved"
    }, admin.cookie));
    assert.equal(reviewRegistration.status, 200);

    const closeEvent = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, jsonRequest("PATCH", {
      registrationMode: "force_closed"
    }, admin.cookie));
    assert.equal(closeEvent.status, 200);

    const publishEvent = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/current`, jsonRequest("POST", {}, admin.cookie));
    assert.equal(publishEvent.status, 200);
    assert.equal((await publishEvent.json()).row.status, "published");

    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.certificates.push({
      id: "C-AUDIT",
      registrationId: "R20260627002",
      slot: 1,
      title: "一等奖",
      userId: "U2001",
      organizationId: "O1002",
      fileName: "award.png",
      storedName: "award.png",
      filePath: "C:/private/uploads/certificates/award.png",
      awardName: "一等奖",
      rank: "1",
      score: "98",
      status: "draft",
      source: "manual",
      importBatchId: null,
      uploadedAt: "2026-07-18T08:00:00.000Z",
      publishedAt: "",
      cleanedAt: ""
    });
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");

    const publish = await fetch(`${baseUrl}/api/admin/certificates/bulk-status`, jsonRequest("POST", {
      ids: ["C-AUDIT"],
      status: "published"
    }, admin.cookie));
    assert.equal(publish.status, 200);

    const withdraw = await fetch(`${baseUrl}/api/admin/certificates/bulk-status`, jsonRequest("POST", {
      ids: ["C-AUDIT"],
      status: "draft"
    }, admin.cookie));
    assert.equal(withdraw.status, 200);
    assert.equal((await withdraw.json()).rows[0].status, "draft");

    const remove = await fetch(`${baseUrl}/api/admin/certificates/C-AUDIT`, withSession(admin.cookie, { method: "DELETE" }));
    assert.equal(remove.status, 204);

    const archiveEvent = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/archive`, jsonRequest("POST", {}, admin.cookie));
    assert.equal(archiveEvent.status, 200);
    assert.equal((await archiveEvent.json()).row.status, "archived");

    assert.equal((await fetch(`${baseUrl}/api/admin/audit-logs`, withSession(ordinary.cookie))).status, 403);
    const logs = await payload(await fetch(`${baseUrl}/api/admin/audit-logs?page=1&pageSize=20`, withSession(admin.cookie)));
    assert.deepEqual({ total: logs.total, page: logs.page, pageSize: logs.pageSize }, { total: 9, page: 1, pageSize: 20 });
    assert.deepEqual(new Set(logs.rows.map((row) => row.action)), new Set([
      "organization.review",
      "organization.status",
      "registration.review",
      "event.registration-mode",
      "event.publish",
      "event.archive",
      "certificate.publish",
      "certificate.withdraw",
      "certificate.delete"
    ]));
    assert.equal(logs.rows.find((row) => row.action === "organization.status")?.targetId, "O1002");
    assert.equal(logs.rows.find((row) => row.action === "event.publish")?.targetId, "wz-aerospace-2026");
    assert.equal(logs.rows.find((row) => row.action === "event.archive")?.targetId, "wz-aerospace-2026");
    assert.equal(logs.rows.find((row) => row.action === "certificate.withdraw")?.targetId, "C-AUDIT");
    assert.equal(logs.rows.find((row) => row.action === "certificate.delete")?.targetId, "C-AUDIT");
    assert.equal(logs.rows.every((row) => row.actorUserId === "U9001" && row.actorName.startsWith("赛事管理员")), true);
    const serialized = JSON.stringify(logs.rows);
    for (const secret of apiActorSecrets) assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }, { prefix: "audit-dashboard-operations-" });
});

test("audit dashboard persists neither event publication nor its audit row when storage fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-write-failure-"));
  const durableStore = createFileStore(path.join(tempDir, "db.json"));
  const initial = {
    events: [{
      id: "E-FAIL",
      name: "Failure fixture",
      status: "draft",
      isCurrent: false,
      archivedAt: null,
      updatedAt: "2026-07-18T00:00:00.000Z"
    }],
    auditLogs: []
  };
  await durableStore.writeDb(initial);
  const failingStore = {
    readDb: () => durableStore.readDb(),
    writeDb: async () => { throw new Error("simulated persistence failure"); },
    withMutationLock: (handler) => durableStore.withMutationLock(handler)
  };
  const app = express();
  app.use(express.json());
  const authenticateAdmin = (req, _res, next) => {
    req.user = { id: "U-ADMIN", name: "Safe Admin", type: "admin" };
    next();
  };
  app.use("/api", createEventsRouter({
    store: failingStore,
    requireAdmin: authenticateAdmin,
    requirePasswordReady: (_req, _res, next) => next(),
    asyncRoute: createMutationAsyncRoute(failingStore),
    makeId: (prefix) => `${prefix}-FAIL`,
    clock: () => new Date("2026-07-18T09:00:00.000Z")
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  let server;

  try {
    server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/events/E-FAIL/current`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 500);
    const persisted = await durableStore.readDb();
    assert.equal(persisted.events[0].status, "draft");
    assert.equal(persisted.events[0].isCurrent, false);
    assert.deepEqual(persisted.auditLogs, []);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await durableStore.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
