import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";
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

    const reviewOrganization = await fetch(`${baseUrl}/api/admin/organizations/O1002/review`, jsonRequest("PATCH", {
      status: "rejected",
      reason: "资质信息需要更新"
    }, admin.cookie));
    assert.equal(reviewOrganization.status, 200);

    const reviewRegistration = await fetch(`${baseUrl}/api/registrations/R20260627001/status`, jsonRequest("PATCH", {
      status: "approved"
    }, admin.cookie));
    assert.equal(reviewRegistration.status, 200);

    const closeEvent = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, jsonRequest("PATCH", {
      registrationMode: "force_closed"
    }, admin.cookie));
    assert.equal(closeEvent.status, 200);

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

    assert.equal((await fetch(`${baseUrl}/api/admin/audit-logs`, withSession(ordinary.cookie))).status, 403);
    const logs = await payload(await fetch(`${baseUrl}/api/admin/audit-logs?page=1&pageSize=20`, withSession(admin.cookie)));
    assert.deepEqual({ total: logs.total, page: logs.page, pageSize: logs.pageSize }, { total: 4, page: 1, pageSize: 20 });
    assert.deepEqual(new Set(logs.rows.map((row) => row.action)), new Set([
      "organization.review",
      "registration.review",
      "event.registration-mode",
      "certificate.publish"
    ]));
    assert.equal(logs.rows.every((row) => row.actorUserId === "U9001" && row.actorName === "赛事管理员"), true);
    const serialized = JSON.stringify(logs.rows);
    assert.doesNotMatch(serialized, /admin123|1380000000\d|C:\\private|aerogp\.sid/i);
  }, { prefix: "audit-dashboard-operations-" });
});
