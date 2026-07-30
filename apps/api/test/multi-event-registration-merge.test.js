import assert from "node:assert/strict";
import test from "node:test";

import { createOrMergeRegistration } from "../src/services/registrations.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const timestamp = "2026-07-30T08:00:00.000Z";
const actor = { id: "U1", type: "ordinary", name: "个人用户" };
const owner = { id: "OWNER1", type: "organization", name: "组织负责人" };
const otherActor = { id: "U2", type: "ordinary", name: "另一用户" };
const otherOwner = { id: "OWNER2", type: "organization", name: "另一负责人" };

function fixture() {
  return {
    events: [{ id: "E1", status: "published", archivedAt: null, isCurrent: true, registrationMode: "force_open", registrationStartAt: "2026-01-01T00:00:00.000Z", registrationEndAt: "2026-12-31T00:00:00.000Z" }],
    projects: [{ id: "P1", eventId: "E1", name: "纸飞机", type: "individual", enabled: true, allowedGroups: ["小学高段"] }],
    organizations: [
      { id: "O1", ownerUserId: "OWNER1", name: "组织一", status: "active", reviewStatus: "approved" },
      { id: "O2", ownerUserId: "OWNER2", name: "组织二", status: "active", reviewStatus: "approved" }
    ],
    memberships: [{ userId: "U1", organizationId: "O1", status: "active", role: "member" }],
    organizationEventParticipations: [
      { organizationId: "O1", eventId: "E1" },
      { organizationId: "O2", eventId: "E1" }
    ],
    registrations: [],
    auditLogs: []
  };
}

function input(overrides = {}) {
  return {
    eventId: "E1",
    projectId: "P1",
    athlete: { name: "张三", school: "实验小学", grade: "五年级", phone: "13800000001" },
    ...overrides
  };
}

const context = {
  makeId: () => "R1",
  now: () => timestamp,
  clock: () => new Date(timestamp)
};

test("personal first and organization second merge into one registration", () => {
  const db = fixture();
  const first = createOrMergeRegistration(db, input(), actor, "personal", context);
  const second = createOrMergeRegistration(db, input(), owner, "organization", context);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.merged, true);
  assert.equal(db.registrations.length, 1);
  assert.equal(second.row.personalUserId, actor.id);
  assert.equal(second.row.organizationId, "O1");
  assert.equal(second.row.createdByUserId, actor.id);
  assert.equal(second.row.createdVia, "personal");
});

test("organization first and personal second preserve results and certificates", () => {
  const db = fixture();
  const first = createOrMergeRegistration(db, input(), owner, "organization", context);
  first.row.status = "approved";
  first.row.awardName = "一等奖";
  first.row.certificates = ["C1", "C2"];

  const second = createOrMergeRegistration(db, input(), actor, "personal", context);
  assert.equal(second.merged, true);
  assert.equal(second.row.personalUserId, actor.id);
  assert.equal(second.row.status, "approved");
  assert.equal(second.row.awardName, "一等奖");
  assert.deepEqual(second.row.certificates, ["C1", "C2"]);
});

test("same owner retry is idempotent while other owners conflict", () => {
  const db = fixture();
  createOrMergeRegistration(db, input(), actor, "personal", context);
  assert.equal(createOrMergeRegistration(db, input(), actor, "personal", context).merged, false);
  assert.throws(
    () => createOrMergeRegistration(db, input(), otherActor, "personal", context),
    (error) => error.code === "REGISTRATION_OWNED_BY_OTHER_USER"
  );
  createOrMergeRegistration(db, input(), owner, "organization", context);
  assert.throws(
    () => createOrMergeRegistration(db, input(), otherOwner, "organization", context),
    (error) => error.code === "REGISTRATION_OWNED_BY_OTHER_ORGANIZATION"
  );
});

test("personal association requires active membership and joined organization event", () => {
  const db = fixture();
  db.organizationEventParticipations = [];
  assert.throws(
    () => createOrMergeRegistration(db, input({ organizationId: "O1" }), actor, "personal", context),
    (error) => error.code === "ORGANIZATION_NOT_JOINED"
  );
});

test("event-scoped personal and organization endpoints merge only after the organization joins", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const personal = await loginAs(baseUrl, "13800000001", "123456");
    const organization = await loginAs(baseUrl, "13800000011", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationMode: "force_open" })
    }));
    const body = input({ eventId: "wz-aerospace-2026", projectId: "paper-plane-gate", organizationId: "O1001" });
    const beforeJoin = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(personal.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }));
    assert.equal(beforeJoin.status, 403);

    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(organization.cookie, { method: "POST" }))).status, 201);
    const created = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(personal.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }));
    assert.equal(created.status, 201);
    const merged = await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/registrations`, withSession(organization.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }));
    assert.equal(merged.status, 200);
    assert.equal((await merged.json()).row.personalUserId, personal.user.id);
  });
});
