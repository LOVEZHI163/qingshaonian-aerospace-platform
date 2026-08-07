import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import ExcelJS from "exceljs";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const validId = "11010519491231002X";

async function loadWorkbook(response) {
  assert.equal(response.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  return workbook;
}

function rowNumberForRegistration(sheet, registrationId) {
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    if (sheet.getCell(`A${rowNumber}`).value === registrationId) return rowNumber;
  }
  return null;
}

async function setOrganization(dbPath, organizationId, changes) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  Object.assign(db.organizations.find((row) => row.id === organizationId), changes);
  await fs.writeFile(dbPath, JSON.stringify(db));
}

async function addUnavailableEvents(dbPath) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const published = db.events.find((row) => row.id === "wz-aerospace-2026");
  db.events.push(
    { ...published, id: "draft-event", status: "draft", isCurrent: false, registrationMode: "force_closed" },
    { ...published, id: "archived-event", status: "archived", isCurrent: false, archivedAt: "2026-07-01T00:00:00.000Z" }
  );
  await fs.writeFile(dbPath, JSON.stringify(db));
}

test("ordinary users see every published non-archived event and active organization availability", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await addUnavailableEvents(dbPath);
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const response = await fetch(`${baseUrl}/api/me/events`, withSession(ordinary.cookie));

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.rows[0].event.id, "wz-aerospace-2026");
    assert.equal(payload.rows[0].event.status, "published");
    assert.equal(payload.rows[0].event.archivedAt, null);
    assert.ok(["not_started", "open", "closed"].includes(payload.rows[0].registrationState));
    assert.equal(payload.rows[0].registrationCount, 1);
    assert.equal(payload.rows[0].organizations.length, 1);
    assert.equal(payload.rows[0].organizations[0].organization.id, "O1001");
    assert.equal(payload.rows[0].organizations[0].organizationJoined, false);
  }, { prefix: "account-events-ordinary-" });
});

test("approved organization joins once, becomes joined, and records one audit entry", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const first = await fetch(
      `${baseUrl}/api/organization/events/wz-aerospace-2026/join`,
      withSession(owner.cookie, { method: "POST" })
    );
    assert.equal(first.status, 201);
    const firstPayload = await first.json();
    assert.deepEqual(firstPayload.row, {
      organizationId: "O1001",
      eventId: "wz-aerospace-2026",
      joinedByUserId: "U2001",
      joinedAt: firstPayload.row.joinedAt
    });

    const second = await fetch(
      `${baseUrl}/api/organization/events/wz-aerospace-2026/join`,
      withSession(owner.cookie, { method: "POST" })
    );
    assert.equal(second.status, 200);
    assert.deepEqual((await second.json()).row, firstPayload.row);

    const eventCenter = await fetch(`${baseUrl}/api/me/events`, withSession(owner.cookie));
    const centerPayload = await eventCenter.json();
    assert.equal(centerPayload.rows[0].participationState, "joined");
    assert.equal(centerPayload.rows[0].summary.registrationCount, 1);
    assert.equal(centerPayload.rows[0].summary.pendingRegistrationCount, 1);
    assert.equal(centerPayload.rows[0].summary.certificateCount, 0);

    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.deepEqual(db.organizationEventParticipations, [firstPayload.row]);
    assert.equal(db.auditLogs.filter((row) => row.action === "organization.event.join").length, 1);
    assert.equal(db.auditLogs.find((row) => row.action === "organization.event.join").targetId, "wz-aerospace-2026");
  }, { prefix: "account-events-join-" });
});

test("approved organization can join an open draft event without a separate publication step", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await addUnavailableEvents(dbPath);
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.events.find((row) => row.id === "draft-event").registrationMode = "force_open";
    await fs.writeFile(dbPath, JSON.stringify(db));
    const owner = await loginAs(baseUrl, "13800000011", "123456");

    const response = await fetch(
      `${baseUrl}/api/organization/events/draft-event/join`,
      withSession(owner.cookie, { method: "POST" })
    );

    assert.equal(response.status, 201);
    assert.equal((await response.json()).row.eventId, "draft-event");
  }, { prefix: "account-events-open-draft-" });
});

test("an organization workspace and export are scoped to its joined event", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.users.push(
      { id: "U-PENDING", type: "ordinary", status: "active", name: "Pending", phone: "13800000101", password: "unused" },
      { id: "U-DISABLED", type: "ordinary", status: "disabled", name: "Disabled", phone: "13800000102", password: "unused" },
      { id: "U-ORG", type: "organization", status: "active", name: "Owner Type", phone: "13800000103", password: "unused" }
    );
    db.memberships.push(
      { id: "M-PENDING", userId: "U-PENDING", organizationId: "O1001", role: "member", status: "pending" },
      { id: "M-DISABLED", userId: "U-DISABLED", organizationId: "O1001", role: "member", status: "active" },
      { id: "M-ORG", userId: "U-ORG", organizationId: "O1001", role: "member", status: "active" },
      { id: "M-FOREIGN", userId: "U-PENDING", organizationId: "O1002", role: "member", status: "active" }
    );
    await fs.writeFile(dbPath, JSON.stringify(db));
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    assert.equal((await fetch(
      `${baseUrl}/api/organization/events/wz-aerospace-2026/join`,
      withSession(owner.cookie, { method: "POST" })
    )).status, 201);

    const workspace = await fetch(
      `${baseUrl}/api/organization/events/wz-aerospace-2026/workspace`,
      withSession(owner.cookie)
    );
    assert.equal(workspace.status, 200);
    const payload = await workspace.json();
    assert.equal(payload.event.id, "wz-aerospace-2026");
    assert.deepEqual(payload.organization, { id: "O1001", name: "温州市实验小学" });
    assert.equal(payload.summary.registrationCount, payload.registrations.length);
    assert.equal(payload.registrations.every((row) => row.organizationId === "O1001"), true);
    assert.deepEqual(payload.members, [{ id: "U1001", name: "陈宇航家长", phone: "13800000001" }]);

    const exported = await fetch(
      `${baseUrl}/api/organization/events/wz-aerospace-2026/export`,
      withSession(owner.cookie)
    );
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get("cache-control"), "private, no-store");
    assert.match(exported.headers.get("content-type") || "", /spreadsheetml/);
  }, { prefix: "account-events-workspace-" });
});

test("legacy organization export decorates identities for only the session organization", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const personal = await loginAs(baseUrl, "13800000001", "123456");
    const organization = await loginAs(baseUrl, "13800000011", "123456");
    const otherOrganization = await loginAs(baseUrl, "13800000012", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(admin.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationMode: "force_open" })
    }))).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(organization.cookie, { method: "POST" }))).status, 201);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(otherOrganization.cookie, { method: "POST" }))).status, 201);
    const created = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(personal.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "rotor-race",
        athlete: { name: "Legacy Export Identity", school: "Export School", grade: "五年级", phone: "13600008102" },
        studentIdNumber: validId
      })
    }));
    assert.equal(created.status, 201);
    const createdRegistrationId = (await created.json()).row.id;

    const workbook = await loadWorkbook(await fetch(
      `${baseUrl}/api/organization/events/wz-aerospace-2026/export?organizationId=O1002`,
      withSession(organization.cookie)
    ));
    const sheet = workbook.getWorksheet("报名名单");
    const createdRow = rowNumberForRegistration(sheet, createdRegistrationId);
    const legacyRow = rowNumberForRegistration(sheet, "R20260627001");
    assert.notEqual(createdRow, null);
    assert.notEqual(legacyRow, null);
    assert.equal(sheet.getCell("I1").value, "学生身份证号");
    assert.equal(sheet.getCell(`I${createdRow}`).text, validId);
    assert.equal(sheet.getCell(`I${legacyRow}`).text, "");
    assert.equal(rowNumberForRegistration(sheet, "R20260627002"), null);
  }, { prefix: "account-events-legacy-export-" });
});

test("join rejects unapproved and disabled organizations, ordinary users, drafts, and archived events", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await addUnavailableEvents(dbPath);

    await setOrganization(dbPath, "O1001", { reviewStatus: "pending" });
    const unapproved = await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(owner.cookie, { method: "POST" }));
    assert.equal(unapproved.status, 403);
    assert.equal((await unapproved.json()).code, "ORGANIZATION_REVIEW_PENDING");

    await setOrganization(dbPath, "O1001", { reviewStatus: "approved", status: "disabled" });
    const disabled = await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(owner.cookie, { method: "POST" }));
    assert.equal(disabled.status, 403);
    assert.equal((await disabled.json()).code, "ORGANIZATION_DISABLED");

    const ordinaryAttempt = await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(ordinary.cookie, { method: "POST" }));
    assert.equal(ordinaryAttempt.status, 403);
    assert.equal((await ordinaryAttempt.json()).code, "ORGANIZATION_OWNER_REQUIRED");

    await setOrganization(dbPath, "O1001", { status: "active" });
    for (const eventId of ["draft-event", "archived-event"]) {
      const unavailable = await fetch(`${baseUrl}/api/organization/events/${eventId}/join`, withSession(owner.cookie, { method: "POST" }));
      assert.equal(unavailable.status, 404);
      assert.equal((await unavailable.json()).code, "EVENT_NOT_AVAILABLE");
    }
  }, { prefix: "account-events-rejection-" });
});
