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

test("personal edits cannot transfer or clear an already merged organization owner", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const personal = await loginAs(baseUrl, "13800000001", "123456");
    const ownerOne = await loginAs(baseUrl, "13800000011", "123456");
    const ownerTwo = await loginAs(baseUrl, "13800000012", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationMode: "force_open" })
    }));
    await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(ownerOne.cookie, { method: "POST" }));
    await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(ownerTwo.cookie, { method: "POST" }));
    const db = JSON.parse(await (await import("node:fs/promises")).readFile(dbPath, "utf8"));
    db.memberships.push({ id: "M-O2", userId: personal.user.id, organizationId: "O1002", role: "member", status: "active" });
    await (await import("node:fs/promises")).writeFile(dbPath, JSON.stringify(db), "utf8");
    const create = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(personal.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input({ eventId: "wz-aerospace-2026", projectId: "paper-plane-gate", organizationId: "O1001" }))
    }));
    const row = (await create.json()).row;
    for (const organizationId of ["O1002", null]) {
      const response = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations/${row.id}`, withSession(personal.cookie, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId })
      }));
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "REGISTRATION_OWNED_BY_OTHER_ORGANIZATION");
    }
  });
});

test("profile and legacy admin endpoints cannot bypass event-scoped registration access", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    for (const cookie of [ordinary.cookie, admin.cookie]) {
      const profile = await fetch(`${baseUrl}/api/me/U1001`, withSession(cookie));
      assert.equal(profile.status, cookie === ordinary.cookie ? 200 : 200);
      assert.equal("registrations" in await profile.json(), false);
    }
    assert.equal((await fetch(`${baseUrl}/api/admin/registrations`, withSession(admin.cookie))).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/admin/registrations/R20260627001`, withSession(admin.cookie, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" }))).status, 404);
  });
});

test("archived force-open events reject personal edits and legacy administrator result writes", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationMode: "force_open" })
    }));
    await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/archive`, withSession(admin.cookie, { method: "POST" }));
    assert.equal((await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations/R20260627001`, withSession(ordinary.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}"
    }))).status, 409);
    assert.equal((await fetch(`${baseUrl}/api/admin/registrations/R20260627001/result`, withSession(admin.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
    }))).status, 404);
  });
});

test("concurrent personal submissions persist one identity and return create plus idempotent merge", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const personal = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationMode: "force_open" })
    }));
    const request = () => fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(personal.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input({ eventId: "wz-aerospace-2026", projectId: "paper-plane-gate" }))
    }));
    const responses = await Promise.all([request(), request()]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
    const rows = await (await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(personal.cookie))).json();
    assert.equal(rows.rows.filter((row) => row.projectId === "paper-plane-gate" && row.athlete.name === "张三").length, 1);
  });
});
