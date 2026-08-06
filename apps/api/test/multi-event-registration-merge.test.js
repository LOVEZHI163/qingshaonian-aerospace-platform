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
    users: [
      { id: "U1", type: "ordinary", name: "Member One", phone: "13800000001", status: "active" },
      { id: "U2", type: "ordinary", name: "Foreign Member", phone: "13800000002", status: "active" },
      { id: "U3", type: "ordinary", name: "Pending Member", phone: "13800000003", status: "active" },
      { id: "U4", type: "ordinary", name: "Disabled Member", phone: "13800000004", status: "disabled" }
    ],
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

test("member_registration binds the selected active local member and ignores forged ownership fields", () => {
  const db = fixture();
  const result = createOrMergeRegistration(db, input({
    registrationSource: "member_registration",
    memberUserId: "U1",
    organizationId: "O2",
    personalUserId: "U2",
    source: "personal"
  }), owner, "organization", context);

  assert.equal(result.row.source, "member_registration");
  assert.equal(result.row.personalUserId, "U1");
  assert.equal(result.row.organizationId, "O1");
  assert.equal(result.row.createdVia, "organization");
});

test("organization_proxy never accepts a client supplied personal user or source", () => {
  const db = fixture();
  const result = createOrMergeRegistration(db, input({
    registrationSource: "organization_proxy",
    organizationId: "O2",
    personalUserId: "U1",
    source: "member_registration"
  }), owner, "organization", context);

  assert.equal(result.row.source, "organization_proxy");
  assert.equal(result.row.personalUserId, null);
  assert.equal(result.row.organizationId, "O1");
  assert.equal(result.row.createdVia, "organization");
});

test("member_registration requires an active ordinary member of the owner organization", () => {
  for (const [memberUserId, expectedStatus] of [[undefined, 422], ["U2", 403], ["U3", 403], ["U4", 403]]) {
    const db = fixture();
    if (memberUserId === "U2") db.memberships.push({ userId: "U2", organizationId: "O2", status: "active", role: "member" });
    if (memberUserId === "U3") db.memberships.push({ userId: "U3", organizationId: "O1", status: "pending", role: "member" });
    if (memberUserId === "U4") db.memberships.push({ userId: "U4", organizationId: "O1", status: "active", role: "member" });
    assert.throws(
      () => createOrMergeRegistration(db, input({ registrationSource: "member_registration", memberUserId }), owner, "organization", context),
      (error) => error.status === expectedStatus
    );
  }
});

test("personal first and organization second merge into one registration", () => {
  const db = fixture();
  const first = createOrMergeRegistration(db, input(), actor, "personal", context);
  const second = createOrMergeRegistration(db, input(), owner, "organization", context);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.merged, false);
  assert.equal(db.registrations.length, 1);
  assert.equal(second.row.personalUserId, actor.id);
  assert.equal(second.row.organizationId, "O1");
  assert.equal(second.row.createdByUserId, actor.id);
  assert.equal(second.row.createdVia, "personal");
});

test("organization first and personal second preserve results and certificates", () => {
  const db = fixture();
  const first = createOrMergeRegistration(db, input(), owner, "organization", context);
  first.row.organization = "Stale organization";
  first.row.source = "legacy_organization";
  first.row.status = "approved";
  first.row.awardName = "一等奖";
  first.row.certificates = ["C1", "C2"];

  const second = createOrMergeRegistration(db, input(), actor, "personal", context);
  assert.equal(second.merged, true);
  assert.equal(second.row.personalUserId, actor.id);
  assert.equal(second.row.organizationId, "O1");
  assert.equal(second.row.organization, "组织一");
  assert.equal(second.row.source, "member_registration");
  assert.equal(second.row.status, "approved");
  assert.equal(second.row.awardName, "一等奖");
  assert.deepEqual(second.row.certificates, ["C1", "C2"]);
});

test("same owner retry is idempotent while other owners conflict", () => {
  const db = fixture();
  createOrMergeRegistration(db, input(), actor, "personal", context);
  assert.equal(createOrMergeRegistration(db, input(), actor, "personal", context).merged, false);
  db.memberships.push({ userId: otherActor.id, organizationId: "O1", status: "active", role: "member" });
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

test("personal association requires active membership but not organization event participation", () => {
  const db = fixture();
  db.organizationEventParticipations = [];
  const result = createOrMergeRegistration(db, input({ organizationId: "O2" }), actor, "personal", context);
  assert.equal(result.row.organizationId, "O1");
});

test("event-scoped personal registration does not wait for the organization owner to join", async () => {
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
    assert.equal(beforeJoin.status, 201);

    const organizationBeforeJoin = await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/registrations`, withSession(organization.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }));
    assert.equal(organizationBeforeJoin.status, 403);

    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(organization.cookie, { method: "POST" }))).status, 201);
    const created = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(personal.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }));
    assert.equal(created.status, 200);
    const merged = await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/registrations`, withSession(organization.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }));
    assert.equal(merged.status, 200);
    assert.equal((await merged.json()).row.personalUserId, personal.user.id);
  });
});

test("personal edits ignore caller-supplied organization substitutions", async () => {
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
    const create = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(personal.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input({ eventId: "wz-aerospace-2026", projectId: "paper-plane-gate", organizationId: "O1002" }))
    }));
    const row = (await create.json()).row;
    assert.equal(row.organizationId, "O1001");
    for (const organizationId of ["O1002", null]) {
      const response = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations/${row.id}`, withSession(personal.cookie, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId })
      }));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).row.organizationId, "O1001");
    }
  });
});

test("profile and legacy admin endpoints cannot bypass event-scoped registration access", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const ordinaryProfile = await fetch(`${baseUrl}/api/me/U1001`, withSession(ordinary.cookie));
    assert.equal(ordinaryProfile.status, 200);
    assert.equal("registrations" in await ordinaryProfile.json(), false);
    const adminProfile = await fetch(`${baseUrl}/api/me/U1001`, withSession(admin.cookie));
    assert.equal(adminProfile.status, 200);
    const profile = await adminProfile.json();
    assert.equal(profile.registrations.some((row) => row.eventId === "wz-aerospace-2026"), true);
    assert.equal(profile.registrations.every((row) => !Object.hasOwn(row, "internalOnly") && !Object.hasOwn(row, "createdByUserId")), true);
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
    assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/registrations/R20260627001`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}"
    }))).status, 409);
    assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/registrations/R20260627001/result`, withSession(admin.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
    }))).status, 409);
    assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/registrations/R20260627001/status`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved" })
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

test("duplicate checks use the exact event, project, and athlete identity", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationMode: "force_open" })
    }));
    const exact = await fetch(`${baseUrl}/api/registrations/check`, withSession(ordinary.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "wz-aerospace-2026", projectId: "paper-plane-gate", athlete: { name: "陈宇航", school: "温州市实验小学", grade: "五年级", phone: "13800000001" } })
    }));
    assert.equal((await exact.json()).duplicate, true);
    const differentProject = await fetch(`${baseUrl}/api/registrations/check`, withSession(ordinary.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "wz-aerospace-2026", projectId: "rocket-duration", athlete: { name: "陈宇航", school: "温州市实验小学", grade: "五年级", phone: "13800000001" } })
    }));
    assert.equal((await differentProject.json()).duplicate, false);
  });
});
