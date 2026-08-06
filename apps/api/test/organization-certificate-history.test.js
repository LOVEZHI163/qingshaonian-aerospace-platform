import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function payload(response) {
  const body = await response.json();
  assert.ok(body && typeof body === "object");
  return body;
}

test("organization certificate history reads only its published archived-event registrations", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.events[0].status = "archived";
    db.events[0].archivedAt = "2026-07-30T00:00:00.000Z";
    db.organizationEventParticipations.push({
      organizationId: "O1001", eventId: db.events[0].id, joinedAt: "2026-07-01T00:00:00.000Z"
    });
    db.certificates.push(
      { id: "C-PUBLISHED", registrationId: "R20260627001", slot: 1, title: "published", status: "published", fileName: "p.png", storedName: "p.png", filePath: "/safe/p.png", cleanedAt: "" },
      { id: "C-DRAFT", registrationId: "R20260627001", slot: 2, title: "draft", status: "draft", fileName: "d.png", storedName: "d.png", filePath: "/safe/d.png", cleanedAt: "" },
      { id: "C-OTHER", registrationId: "R20260627002", slot: 1, title: "other", status: "published", fileName: "o.png", storedName: "o.png", filePath: "/safe/o.png", cleanedAt: "" }
    );
    await fs.writeFile(dbPath, JSON.stringify(db));

    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const otherOwner = await loginAs(baseUrl, "13800000012", "123456");
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const eventId = "wz-aerospace-2026";

    const organization = await fetch(`${baseUrl}/api/organization/events/${eventId}/certificates`, withSession(owner.cookie));
    assert.equal(organization.status, 200);
    assert.deepEqual((await payload(organization)).rows.map((row) => row.id), ["C-PUBLISHED"]);

    const foreign = await fetch(`${baseUrl}/api/organization/events/${eventId}/certificates`, withSession(otherOwner.cookie));
    assert.equal(foreign.status, 403);

    const personal = await fetch(`${baseUrl}/api/me/events/${eventId}/certificates`, withSession(ordinary.cookie));
    assert.equal(personal.status, 200);
    assert.deepEqual((await payload(personal)).rows.map((row) => row.id), ["C-PUBLISHED"]);

    const adminRows = await fetch(`${baseUrl}/api/admin/events/${eventId}/certificates`, withSession(admin.cookie));
    assert.equal(adminRows.status, 200);
    assert.deepEqual((await payload(adminRows)).rows.map((row) => row.id).sort(), ["C-DRAFT", "C-OTHER", "C-PUBLISHED"]);
  }, { prefix: "organization-certificate-history-" });
});

test("organization certificate history lists every published certificate owned by the logged-in organization", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const current = db.events[0];
    db.events.push({
      ...current,
      id: "E-ARCHIVED",
      name: "往届航空赛",
      status: "archived",
      isCurrent: false,
      archivedAt: "2025-12-31T00:00:00.000Z"
    });
    db.registrations.push(
      {
        ...db.registrations[0],
        id: "R-FORMER-MEMBER",
        eventId: "E-ARCHIVED",
        organizationId: "O1001",
        personalUserId: "U-FORMER",
        athlete: { name: "往届成员", school: "温州市实验小学", grade: "高三", phone: "13800009991" },
        projectName: "往届项目"
      },
      {
        ...db.registrations[0],
        id: "R-UNBOUND",
        eventId: "E-ARCHIVED",
        organizationId: null,
        personalUserId: "U-FORMER",
        athlete: { name: "个人选手", school: "温州市实验小学", grade: "高三", phone: "13800009991" },
        projectName: "个人项目"
      }
    );
    db.memberships.push({
      id: "M-FORMER", userId: "U-FORMER", organizationId: "O1001", role: "member",
      status: "removed", direction: "organization_invite", createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-12-31T00:00:00.000Z"
    });
    db.certificates.push(
      { id: "C-OWN-CURRENT", registrationId: "R20260627001", slot: 1, title: "本届一等奖", status: "published", fileName: "current.png", storedName: "current.png", filePath: "/safe/current.png", cleanedAt: "", publishedAt: "2026-01-01T00:00:00.000Z" },
      { id: "C-OWN-HISTORY", registrationId: "R-FORMER-MEMBER", slot: 1, title: "往届一等奖", status: "published", fileName: "history.pdf", storedName: "history.pdf", filePath: "/safe/history.pdf", cleanedAt: "", publishedAt: "2025-12-31T00:00:00.000Z" },
      { id: "C-OWN-DRAFT", registrationId: "R-FORMER-MEMBER", slot: 2, title: "未发布", status: "draft", fileName: "draft.png", storedName: "draft.png", filePath: "/safe/draft.png", cleanedAt: "" },
      { id: "C-FOREIGN", registrationId: "R20260627002", slot: 1, title: "外部证书", status: "published", fileName: "foreign.png", storedName: "foreign.png", filePath: "/safe/foreign.png", cleanedAt: "" },
      { id: "C-UNBOUND", registrationId: "R-UNBOUND", slot: 1, title: "个人证书", status: "published", fileName: "personal.png", storedName: "personal.png", filePath: "/safe/personal.png", cleanedAt: "" }
    );
    await fs.writeFile(dbPath, JSON.stringify(db));

    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const response = await fetch(`${baseUrl}/api/organization/certificates?organizationId=O1002`, withSession(owner.cookie));
    assert.equal(response.status, 200);
    const rows = (await payload(response)).rows;
    assert.deepEqual(rows.map((row) => row.id).sort(), ["C-OWN-CURRENT", "C-OWN-HISTORY"]);
    assert.deepEqual(rows.map(({ eventId, eventName }) => ({ eventId, eventName })).sort((a, b) => a.eventId.localeCompare(b.eventId)), [
      { eventId: "E-ARCHIVED", eventName: "往届航空赛" },
      { eventId: "wz-aerospace-2026", eventName: "2026年温州市青少年航空航天创新比赛" }
    ]);
    for (const row of rows) {
      assert.equal(row.previewUrl, `/api/certificates/${row.id}/file`);
      assert.equal(row.downloadUrl, `/api/certificates/${row.id}/file?download=1`);
    }
    assert.equal((await fetch(`${baseUrl}/api/organization/certificates`, withSession(ordinary.cookie))).status, 403);
  }, { prefix: "organization-all-certificate-history-" });
});

test("retains published certificate history after the platform administrator deletes the organization", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const organizationName = db.organizations.find((row) => row.id === "O1001").name;
    db.certificates.push({
      id: "C-DELETED-ORGANIZATION", registrationId: "R20260627001", slot: 1,
      title: "历史一等奖", status: "published", fileName: "history.png", storedName: "history.png",
      filePath: "/safe/history.png", cleanedAt: "", source: "manual", importBatchId: null,
      awardName: "一等奖", rank: "1", score: "98", uploadedAt: "2026-08-05T00:00:00.000Z",
      publishedAt: "2026-08-05T00:00:00.000Z"
    });
    await fs.writeFile(dbPath, JSON.stringify(db), "utf8");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");

    assert.equal((await fetch(`${baseUrl}/api/admin/organizations/O1001`, withSession(admin.cookie, { method: "DELETE" }))).status, 200);
    const response = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/certificates`, withSession(admin.cookie));
    assert.equal(response.status, 200);
    const certificate = (await response.json()).rows.find((row) => row.id === "C-DELETED-ORGANIZATION");
    assert.ok(certificate);
    assert.equal(certificate.registration.organizationId, null);
    assert.equal(certificate.registration.organizationSnapshot, organizationName);
    assert.match(certificate.organization, /原组织已删除/);
  }, { prefix: "organization-deleted-certificate-history-" });
});
