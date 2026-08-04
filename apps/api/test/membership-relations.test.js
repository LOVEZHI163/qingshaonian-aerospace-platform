import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

function jsonOptions(method, body, cookie) {
  return withSession(cookie, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function registerAndLoginOrdinary(baseUrl, input) {
  const response = await fetch(`${baseUrl}/api/auth/register/ordinary`, jsonOptions("POST", input));
  assert.equal(response.status, 201);
  return loginAs(baseUrl, input.phone, input.password);
}

async function responseJson(response) {
  const body = await response.json();
  assert.ok(body && typeof body === "object");
  return body;
}

const LEGACY_INVITATION_FIELDS = [
  "createdAt", "direction", "id", "invitedName", "invitedPhone", "note",
  "organizationId", "role", "status", "updatedAt", "userId"
];

test("organization invitation requires personal acceptance and repeated invitation is idempotent and audited", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const ordinary = await registerAndLoginOrdinary(baseUrl, {
      name: "受邀用户", phone: "13700000021", password: "Member21"
    });

    assert.equal((await fetch(
      `${baseUrl}/api/organization/member-candidate?phone=137-0000-0021`,
      withSession(owner.cookie)
    )).status, 422);
    const candidate = await fetch(
      `${baseUrl}/api/organization/member-candidate?phone=13700000021`,
      withSession(owner.cookie)
    );
    assert.equal(candidate.status, 200);
    assert.deepEqual((await responseJson(candidate)).user, {
      id: ordinary.user.id, name: "受邀用户", phone: "13700000021"
    });

    const invitation = await fetch(`${baseUrl}/api/organization/invitations`, jsonOptions(
      "POST", { phone: "13700000021", userId: "U1001", organizationId: "O1002" }, owner.cookie
    ));
    assert.equal(invitation.status, 201);
    const relation = (await responseJson(invitation)).row;
    assert.equal(relation.status, "pending");
    assert.equal(relation.direction, "organization_invite");
    assert.equal(relation.userId, ordinary.user.id);
    assert.equal(relation.organizationId, "O1001");
    assert.equal("invitedPhone" in relation, false);

    const repeated = await fetch(`${baseUrl}/api/organization/invitations`, jsonOptions(
      "POST", { phone: "13700000021" }, owner.cookie
    ));
    assert.equal(repeated.status, 200);
    assert.equal((await responseJson(repeated)).row.id, relation.id);

    const beforeAccept = await fetch(`${baseUrl}/api/me/organizations`, withSession(ordinary.cookie));
    assert.deepEqual((await responseJson(beforeAccept)).rows, []);
    const relationsBefore = await responseJson(await fetch(
      `${baseUrl}/api/me/organization-relations`, withSession(ordinary.cookie)
    ));
    assert.deepEqual(relationsBefore.invitations.map((row) => row.id), [relation.id]);
    assert.deepEqual(relationsBefore.active, []);

    const accepted = await fetch(
      `${baseUrl}/api/me/organization-relations/${relation.id}`,
      jsonOptions("PATCH", { action: "accept", userId: "U1001" }, ordinary.cookie)
    );
    assert.equal(accepted.status, 200);
    assert.equal((await responseJson(accepted)).row.status, "active");
    const afterAccept = await fetch(`${baseUrl}/api/me/organizations`, withSession(ordinary.cookie));
    assert.equal((await responseJson(afterAccept)).rows[0].id, "O1001");

    const stored = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const audits = stored.auditLogs.filter((row) => row.targetId === relation.id);
    assert.deepEqual(audits.map((row) => row.actorUserId).sort(), [owner.user.id, owner.user.id, ordinary.user.id].sort());
    assert.equal(audits.every((row) => row.targetType === "membership"), true);
  }, { prefix: "membership-invite-" });
});

test("ordinary request is approved by its owner and compatibility URLs use the same transition rules", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const otherOwner = await loginAs(baseUrl, "13800000012", "123456");
    const ordinary = await registerAndLoginOrdinary(baseUrl, {
      name: "申请用户", phone: "13700000022", password: "Member22"
    });

    const search = await fetch(`${baseUrl}/api/organizations/search?q=WZ-SYXX`, withSession(ordinary.cookie));
    assert.equal(search.status, 200);
    assert.deepEqual((await responseJson(search)).rows.map((row) => row.id), ["O1001"]);

    const request = await fetch(`${baseUrl}/api/me/organization-requests`, jsonOptions(
      "POST", { organizationId: "O1001", note: "申请加入", role: "manager", userId: "U1001" }, ordinary.cookie
    ));
    assert.equal(request.status, 201);
    const relation = (await responseJson(request)).row;
    assert.equal(relation.role, "member");
    assert.equal(relation.direction, "user_request");

    const repeated = await fetch(`${baseUrl}/api/organizations/request`, jsonOptions(
      "POST", { organizationId: "O1001", note: "不会覆盖" }, ordinary.cookie
    ));
    assert.equal(repeated.status, 200);
    assert.equal((await responseJson(repeated)).row.id, relation.id);

    const owned = await responseJson(await fetch(
      `${baseUrl}/api/organization/memberships`, withSession(owner.cookie)
    ));
    assert.equal(owned.rows.some((row) => row.id === relation.id && row.user.id === ordinary.user.id), true);
    assert.equal(owned.summary.pending >= 1, true);
    assert.equal((await fetch(
      `${baseUrl}/api/organizations/O1001/members`, withSession(otherOwner.cookie)
    )).status, 403);

    const foreignApproval = await fetch(
      `${baseUrl}/api/organization/memberships/${relation.id}`,
      jsonOptions("PATCH", { action: "approve" }, otherOwner.cookie)
    );
    assert.equal(foreignApproval.status, 403);
    const approved = await fetch(
      `${baseUrl}/api/memberships/${relation.id}`,
      jsonOptions("PATCH", { status: "active", role: "manager" }, owner.cookie)
    );
    assert.equal(approved.status, 200);
    assert.equal((await responseJson(approved)).row.role, "member");

    const relations = await responseJson(await fetch(
      `${baseUrl}/api/me/organization-relations`, withSession(ordinary.cookie)
    ));
    assert.deepEqual(relations.active.map((row) => row.id), [relation.id]);
  }, { prefix: "membership-request-" });
});

test("owner approval audits every other pending relation it automatically rejects", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const otherOwner = await loginAs(baseUrl, "13800000012", "123456");
    const ordinary = await registerAndLoginOrdinary(baseUrl, {
      name: "审批审计用户", phone: "13700000026", password: "Member26"
    });

    const invitationResponse = await fetch(`${baseUrl}/api/organization/invitations`, jsonOptions(
      "POST", { phone: "13700000026" }, otherOwner.cookie
    ));
    assert.equal(invitationResponse.status, 201);
    const invitation = (await responseJson(invitationResponse)).row;
    const requestResponse = await fetch(`${baseUrl}/api/me/organization-requests`, jsonOptions(
      "POST", { organizationId: "O1001" }, ordinary.cookie
    ));
    assert.equal(requestResponse.status, 201);
    const request = (await responseJson(requestResponse)).row;

    const approval = await fetch(
      `${baseUrl}/api/organization/memberships/${request.id}`,
      jsonOptions("PATCH", { action: "approve" }, owner.cookie)
    );
    assert.equal(approval.status, 200);
    assert.deepEqual((await responseJson(approval)).cancelled, [{
      id: invitation.id, organizationId: "O1002"
    }]);

    const stored = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const automaticAudits = stored.auditLogs.filter((row) => row.action === "membership.auto-reject");
    assert.deepEqual(automaticAudits.map((row) => ({
      actorUserId: row.actorUserId,
      targetType: row.targetType,
      targetId: row.targetId,
      action: row.action
    })), [{
      actorUserId: owner.user.id,
      targetType: "membership",
      targetId: invitation.id,
      action: "membership.auto-reject"
    }]);
    assert.equal(automaticAudits[0].summary.includes("13700000026"), false);
    assert.equal(automaticAudits[0].summary.includes("审批审计用户"), false);
  }, { prefix: "membership-owner-auto-audit-" });
});

test("legacy membership GET preserves its rows-only envelope and explicit invitation fields", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const ordinary = await registerAndLoginOrdinary(baseUrl, {
      name: "旧查询用户", phone: "13700000027", password: "Member27"
    });
    const invitationResponse = await fetch(`${baseUrl}/api/organization/invitations`, jsonOptions(
      "POST", { phone: "13700000027", note: "旧查询兼容" }, owner.cookie
    ));
    assert.equal(invitationResponse.status, 201);
    const invitation = (await responseJson(invitationResponse)).row;

    const legacyResponse = await fetch(
      `${baseUrl}/api/organizations/O1001/members`, withSession(owner.cookie)
    );
    assert.equal(legacyResponse.status, 200);
    const payload = await responseJson(legacyResponse);
    assert.deepEqual(Object.keys(payload), ["rows"]);
    const row = payload.rows.find((item) => item.id === invitation.id);
    assert.deepEqual(Object.keys(row).sort(), [...LEGACY_INVITATION_FIELDS].sort());
    assert.equal(row.userId, ordinary.user.id);
    assert.equal(row.invitedPhone, "13700000027");
    assert.equal(row.invitedName, "旧查询用户");
    assert.equal(row.organizationId, "O1001");
    assert.equal(row.status, "pending");
    assert.equal(row.direction, "organization_invite");
    assert.equal(row.note, "旧查询兼容");
    assert.equal("user" in row, false);
  }, { prefix: "membership-legacy-get-" });
});

test("legacy membership PATCH preserves its row-only envelope and explicit invitation fields", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const ordinary = await registerAndLoginOrdinary(baseUrl, {
      name: "旧更新用户", phone: "13700000028", password: "Member28"
    });
    const invitationResponse = await fetch(`${baseUrl}/api/organization/invitations`, jsonOptions(
      "POST", { phone: "13700000028", note: "旧更新兼容" }, owner.cookie
    ));
    assert.equal(invitationResponse.status, 201);
    const invitation = (await responseJson(invitationResponse)).row;

    const legacyResponse = await fetch(
      `${baseUrl}/api/memberships/${invitation.id}`,
      jsonOptions("PATCH", { status: "rejected", role: "manager" }, owner.cookie)
    );
    assert.equal(legacyResponse.status, 200);
    const payload = await responseJson(legacyResponse);
    assert.deepEqual(Object.keys(payload), ["row"]);
    assert.deepEqual(Object.keys(payload.row).sort(), [...LEGACY_INVITATION_FIELDS].sort());
    assert.equal(payload.row.userId, ordinary.user.id);
    assert.equal(payload.row.invitedPhone, "13700000028");
    assert.equal(payload.row.invitedName, "旧更新用户");
    assert.equal(payload.row.organizationId, "O1001");
    assert.equal(payload.row.status, "rejected");
    assert.equal(payload.row.direction, "organization_invite");
    assert.equal(payload.row.note, "旧更新兼容");
    assert.equal("organization" in payload, false);
    assert.equal("cancelled" in payload, false);
    assert.equal("changed" in payload, false);
  }, { prefix: "membership-legacy-patch-" });
});

test("both sides can reject or end only the transitions assigned to them", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const ordinary = await registerAndLoginOrdinary(baseUrl, {
      name: "状态用户", phone: "13700000023", password: "Member23"
    });

    const requestRelation = async () => {
      const response = await fetch(`${baseUrl}/api/me/organization-requests`, jsonOptions(
        "POST", { organizationId: "O1001" }, ordinary.cookie
      ));
      assert.equal(response.status, 201);
      return (await responseJson(response)).row;
    };
    const inviteRelation = async () => {
      const response = await fetch(`${baseUrl}/api/organization/invitations`, jsonOptions(
        "POST", { phone: "13700000023" }, owner.cookie
      ));
      assert.equal(response.status, 201);
      return (await responseJson(response)).row;
    };
    const personalAction = (id, action) => fetch(
      `${baseUrl}/api/me/organization-relations/${id}`,
      jsonOptions("PATCH", { action }, ordinary.cookie)
    );
    const ownerAction = (id, action) => fetch(
      `${baseUrl}/api/organization/memberships/${id}`,
      jsonOptions("PATCH", { action }, owner.cookie)
    );

    let relation = await requestRelation();
    assert.equal((await personalAction(relation.id, "withdraw")).status, 200);
    relation = await inviteRelation();
    assert.equal((await ownerAction(relation.id, "cancel")).status, 200);
    relation = await inviteRelation();
    assert.equal((await personalAction(relation.id, "reject")).status, 200);
    relation = await requestRelation();
    assert.equal((await ownerAction(relation.id, "reject")).status, 200);
    relation = await inviteRelation();
    assert.equal((await personalAction(relation.id, "accept")).status, 200);
    assert.equal((await personalAction(relation.id, "leave")).status, 200);
    relation = await inviteRelation();
    assert.equal((await personalAction(relation.id, "accept")).status, 200);
    assert.equal((await ownerAction(relation.id, "remove")).status, 200);

    assert.equal((await personalAction(relation.id, "remove")).status, 422);
    assert.equal((await ownerAction(relation.id, "leave")).status, 422);
  }, { prefix: "membership-actions-" });
});

test("accepting one organization rejects and audits other pending relations while a second activation conflicts", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const otherOwner = await loginAs(baseUrl, "13800000012", "123456");
    const ordinary = await registerAndLoginOrdinary(baseUrl, {
      name: "单组织用户", phone: "13700000024", password: "Member24"
    });
    const stranger = await registerAndLoginOrdinary(baseUrl, {
      name: "其他用户", phone: "13700000025", password: "Member25"
    });

    const firstResponse = await fetch(`${baseUrl}/api/organization/invitations`, jsonOptions(
      "POST", { phone: "13700000024" }, owner.cookie
    ));
    assert.equal(firstResponse.status, 201);
    const first = await responseJson(firstResponse);
    const secondResponse = await fetch(`${baseUrl}/api/organization/invitations`, jsonOptions(
      "POST", { phone: "13700000024" }, otherOwner.cookie
    ));
    assert.equal(secondResponse.status, 201);
    const second = await responseJson(secondResponse);
    assert.equal((await fetch(
      `${baseUrl}/api/me/organization-relations/${first.row.id}`,
      jsonOptions("PATCH", { action: "accept" }, stranger.cookie)
    )).status, 403);
    assert.equal((await fetch(
      `${baseUrl}/api/organization/memberships/${first.row.id}`,
      jsonOptions("PATCH", { action: "cancel" }, otherOwner.cookie)
    )).status, 403);

    const accepted = await fetch(
      `${baseUrl}/api/me/organization-relations/${first.row.id}`,
      jsonOptions("PATCH", { action: "accept" }, ordinary.cookie)
    );
    assert.equal(accepted.status, 200);
    assert.deepEqual((await responseJson(accepted)).cancelled, [{ id: second.row.id, organizationId: "O1002" }]);

    const renewedResponse = await fetch(`${baseUrl}/api/organization/invitations`, jsonOptions(
      "POST", { phone: "13700000024" }, otherOwner.cookie
    ));
    assert.equal(renewedResponse.status, 201);
    const renewed = await responseJson(renewedResponse);
    const conflict = await fetch(
      `${baseUrl}/api/me/organization-relations/${renewed.row.id}`,
      jsonOptions("PATCH", { action: "accept" }, ordinary.cookie)
    );
    assert.equal(conflict.status, 409);
    assert.equal((await responseJson(conflict)).code, "MEMBERSHIP_ACTIVE_CONFLICT");

    const stored = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const automaticAudits = stored.auditLogs.filter((row) => row.action === "membership.auto-reject");
    assert.deepEqual(automaticAudits.map((row) => ({
      actorUserId: row.actorUserId,
      targetType: row.targetType,
      targetId: row.targetId,
      action: row.action
    })), [{
      actorUserId: ordinary.user.id,
      targetType: "membership",
      targetId: second.row.id,
      action: "membership.auto-reject"
    }]);
    assert.equal(automaticAudits[0].summary.includes("13700000024"), false);
    assert.equal(automaticAudits[0].summary.includes("单组织用户"), false);
  }, { prefix: "membership-conflict-" });
});

test("leaving membership preserves historical registrations, results and certificates", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const before = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const registration = before.registrations.find((row) => row.personalUserId === ordinary.user.id);
    assert.ok(registration);
    const historical = {
      registration: structuredClone(registration),
      certificates: structuredClone(before.certificates.filter((row) => row.registrationId === registration.id))
    };

    const leave = await fetch(
      `${baseUrl}/api/me/organization-relations/M1002`,
      jsonOptions("PATCH", { action: "leave" }, ordinary.cookie)
    );
    assert.equal(leave.status, 200);
    const after = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.deepEqual(after.registrations.find((row) => row.id === registration.id), historical.registration);
    assert.deepEqual(after.certificates.filter((row) => row.registrationId === registration.id), historical.certificates);
    assert.equal(after.memberships.find((row) => row.id === "M1002").status, "removed");
  }, { prefix: "membership-history-" });
});
