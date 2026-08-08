import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function mutateDb(dbPath, mutate) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  mutate(db);
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
}

async function seedOrganizationHistory(dbPath) {
  await mutateDb(dbPath, (db) => {
    db.events = [
      { ...db.events[0], id: "E1", name: "第一届航空赛", isCurrent: true },
      { ...db.events[0], id: "E2", name: "第二届航空赛", isCurrent: false, status: "archived", archivedAt: "2026-08-01T00:00:00.000Z" }
    ];
    db.organizations = [
      { ...db.organizations.find((row) => row.id === "O1001"), id: "O1001", ownerUserId: "U2001" },
      { ...db.organizations.find((row) => row.id === "O1002"), id: "O2002", ownerUserId: "U-FOREIGN" }
    ];
    db.users.push({ ...db.users.find((row) => row.id === "U1001"), id: "U-MEMBER", phone: "13800001002" });
    Object.assign(db.memberships.find((row) => row.id === "M1002"), { userId: "U-MEMBER", organizationId: "O1001", status: "active" });
    db.registrations = [
      { id: "R-OWN-ORG", eventId: "E1", organizationId: "O1001", personalUserId: null, athlete: { name: "组织代报名", school: "本组织", grade: "三年级", phone: "13800001001" }, projectId: "P1", projectName: "纸飞机", status: "pending" },
      { id: "R-OWN-MEMBER", eventId: "E2", organizationId: "O1001", personalUserId: "U-MEMBER", athlete: { name: "退出成员", school: "本组织", grade: "初二", phone: "13800001002" }, projectId: "P2", projectName: "无人机", status: "approved", awardName: "一等奖" },
      { id: "R-FOREIGN", eventId: "E1", organizationId: "O2002", personalUserId: "U-FOREIGN", athlete: { name: "其他组织成员", school: "其他组织", grade: "五年级", phone: "13800001003" }, projectId: "P1", projectName: "纸飞机", status: "pending" },
      { id: "R-PERSONAL", eventId: "E1", organizationId: null, personalUserId: "U-MEMBER", athlete: { name: "无组织个人报名", school: "本组织", grade: "三年级", phone: "13800001002" }, projectId: "P1", projectName: "纸飞机", status: "pending" }
    ];
    db.projects = [
      { ...db.projects[0], id: "P1", eventId: "E1", name: "纸飞机", submissionMode: "none" },
      { ...db.projects[0], id: "P2", eventId: "E2", name: "无人机", submissionMode: "none" }
    ];
  });
}

test("organization registration history is based on stored organization ownership after a member is removed", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await seedOrganizationHistory(dbPath);
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");

    const response = await fetch(`${baseUrl}/api/organization/registrations?organizationId=O2002`, withSession(owner.cookie));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.rows.map((row) => row.id), ["R-OWN-ORG", "R-OWN-MEMBER"]);
    assert.equal(payload.rows.every((row) => row.organizationId === "O1001"), true);
    assert.deepEqual(payload.rows.map((row) => ({
      id: row.id, eventStatus: row.eventStatus, archivedAt: row.archivedAt, event: row.event
    })), [
      { id: "R-OWN-ORG", eventStatus: "published", archivedAt: null, event: undefined },
      { id: "R-OWN-MEMBER", eventStatus: "archived", archivedAt: "2026-08-01T00:00:00.000Z", event: undefined }
    ]);
    assert.deepEqual(payload.filterOptions.events.map((event) => event.id).sort(), ["E1", "E2"]);
    assert.deepEqual(payload.filterOptions.projects.map((project) => project.id).sort(), ["P1", "P2"]);

    await mutateDb(dbPath, (db) => {
      db.memberships.find((row) => row.id === "M1002").status = "removed";
    });
    const afterRemoval = await fetch(`${baseUrl}/api/organization/registrations`, withSession(owner.cookie));
    assert.equal(afterRemoval.status, 200);
    assert.deepEqual((await afterRemoval.json()).rows.map((row) => row.id), ["R-OWN-ORG", "R-OWN-MEMBER"]);

    assert.equal((await fetch(`${baseUrl}/api/organization/registrations`, withSession(ordinary.cookie))).status, 403);
  }, { prefix: "organization-registration-history-ownership-" });
});

test("organization registration history filters stored organization rows and paginates", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await seedOrganizationHistory(dbPath);
    const owner = await loginAs(baseUrl, "13800000011", "123456");

    const filtered = await fetch(`${baseUrl}/api/organization/registrations?eventId=E2&status=approved&q=${encodeURIComponent("退出成员")}&page=1&pageSize=10`, withSession(owner.cookie));
    assert.equal(filtered.status, 200);
    const payload = await filtered.json();
    assert.equal(payload.total, 1);
    assert.equal(payload.page, 1);
    assert.equal(payload.pageSize, 10);
    assert.deepEqual(payload.rows.map((row) => row.id), ["R-OWN-MEMBER"]);
    assert.equal(payload.rows[0].eventName, "第二届航空赛");

    const outOfRange = await fetch(`${baseUrl}/api/organization/registrations?page=2&pageSize=10`, withSession(owner.cookie));
    assert.equal(outOfRange.status, 200);
    const outOfRangePayload = await outOfRange.json();
    assert.equal(outOfRangePayload.total, 2);
    assert.equal(outOfRangePayload.page, 2);
    assert.deepEqual(outOfRangePayload.rows, []);
  }, { prefix: "organization-registration-history-filter-" });
});

test("retains organization history after the platform administrator deletes its account", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.registrations.find((row) => row.id === "R20260627001").awardName = "一等奖";
    await fs.writeFile(dbPath, JSON.stringify(db), "utf8");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");

    const removed = await fetch(`${baseUrl}/api/admin/organizations/O1001`, withSession(admin.cookie, { method: "DELETE" }));
    assert.equal(removed.status, 200);

    const history = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/registrations`, withSession(admin.cookie));
    assert.equal(history.status, 200);
    const registration = (await history.json()).rows.find((row) => row.id === "R20260627001");
    assert.ok(registration);
    assert.equal(registration.organizationId, null);
    assert.equal(registration.organizationSnapshot, db.organizations.find((row) => row.id === "O1001").name);
    assert.match(registration.organization, /原组织已删除/);
    assert.equal(registration.awardName, "一等奖");
  }, { prefix: "organization-deleted-registration-history-" });
});
