import assert from "node:assert/strict";
import test from "node:test";

import {
  actAsOrganizationOwner,
  actAsPersonalUser,
  findInvitationCandidate,
  inviteMembership,
  listOwnedMemberships,
  listPersonalRelations,
  requestMembership,
  searchOperationalOrganizations
} from "../src/services/memberships.js";

const fixedNow = "2026-08-04T00:00:00.000Z";
const now = () => fixedNow;
let sequence = 0;
const makeId = (prefix) => `${prefix}-TEST-${++sequence}`;
const MEMBERSHIP_FIELDS = [
  "id", "userId", "organizationId", "role", "status", "direction", "note", "createdAt", "updatedAt"
];

function assertMembershipDto(row, extraFields = []) {
  assert.deepEqual(Object.keys(row).sort(), [...MEMBERSHIP_FIELDS, ...extraFields].sort());
  assert.equal("invitedPhone" in row, false);
  assert.equal("invitedName" in row, false);
  assert.equal("internalOnly" in row, false);
}

function fixture() {
  return {
    users: [
      { id: "U1", name: "普通用户", phone: "13700000001", type: "ordinary", status: "active" },
      { id: "UO1", name: "组织负责人一", phone: "13700000011", type: "organization", status: "active" },
      { id: "UO2", name: "组织负责人二", phone: "13700000012", type: "organization", status: "active" }
    ],
    organizations: [
      { id: "O1", name: "组织一", code: "ORG-001", ownerUserId: "UO1", status: "active", reviewStatus: "approved", contactName: "负责人一", contactPhone: "13700000011" },
      { id: "O2", name: "组织二", code: "ORG-002", ownerUserId: "UO2", status: "active", reviewStatus: "approved", contactName: "负责人二", contactPhone: "13700000012" }
    ],
    memberships: [],
    registrations: [],
    certificates: []
  };
}

test("ordinary request and owner invitation create pending member relations", () => {
  const db = fixture();
  const request = requestMembership(db, db.users[0], { organizationId: "O1", note: "申请加入" }, makeId, now);
  const invitation = inviteMembership(db, db.users[2], { phone: "13700000001" }, makeId, now);
  assert.equal(request.row.direction, "user_request");
  assert.equal(invitation.row.direction, "organization_invite");
  assert.equal(request.row.status, "pending");
  assert.equal(invitation.row.status, "pending");
  assert.equal(request.row.role, "member");
  assert.deepEqual(request.cancelled, []);
  assert.equal(request.changed, true);
});

test("creation rejects a user who already has an active relation in another organization", () => {
  const db = fixture();
  db.memberships.push({ id: "M-ACTIVE", userId: "U1", organizationId: "O1", role: "member", status: "active", direction: "user_request", note: "", createdAt: now(), updatedAt: now() });
  assert.throws(() => requestMembership(db, db.users[0], { organizationId: "O2" }, makeId, now), { code: "MEMBERSHIP_ACTIVE_CONFLICT" });
  assert.throws(() => inviteMembership(db, db.users[2], { phone: "13700000001" }, makeId, now), { code: "MEMBERSHIP_ACTIVE_CONFLICT" });
  assert.equal(db.memberships.filter((row) => row.status === "pending").length, 0);
});

test("disabled organization relations remain visible and can be left or withdrawn", () => {
  const db = fixture();
  db.organizations[0].status = "disabled";
  db.memberships.push(
    { id: "M-ACTIVE", userId: "U1", organizationId: "O1", role: "member", status: "active", direction: "user_request", note: "", createdAt: now(), updatedAt: now() },
    { id: "M-PENDING", userId: "U1", organizationId: "O2", role: "member", status: "pending", direction: "user_request", note: "", createdAt: now(), updatedAt: now() }
  );
  assert.equal(listPersonalRelations(db, db.users[0]).active[0].id, "M-ACTIVE");
  assert.equal(actAsPersonalUser(db, db.users[0], "M-ACTIVE", "leave", now).row.status, "removed");
  assert.equal(actAsPersonalUser(db, db.users[0], "M-PENDING", "withdraw", now).row.status, "rejected");
});

test("membership creation only accepts operational organizations and active ordinary candidates", () => {
  const db = fixture();
  db.organizations[0].reviewStatus = "pending";
  assert.throws(
    () => requestMembership(db, db.users[0], { organizationId: "O1" }, makeId, now),
    (error) => error.status === 403
  );

  db.organizations[0].reviewStatus = "approved";
  db.users[0].status = "disabled";
  assert.throws(
    () => inviteMembership(db, db.users[1], { phone: "13700000001" }, makeId, now),
    (error) => error.status === 404
  );
});

test("invitation lookup requires an exact eleven digit phone number", () => {
  const db = fixture();
  assert.throws(() => findInvitationCandidate(db, db.users[1], "1370000000"), (error) => error.status === 422);
  assert.deepEqual(findInvitationCandidate(db, db.users[1], "137-0000-0001"), {
    id: "U1", name: "普通用户", phone: "13700000001"
  });
});

test("a prior terminal relation is reused while pending and active relations remain unchanged", () => {
  const db = fixture();
  db.memberships.push({
    id: "M-OLD", userId: "U1", organizationId: "O1", role: "member", status: "rejected",
    direction: "organization_invite", note: "旧备注", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z"
  });

  const reused = requestMembership(db, db.users[0], { organizationId: "O1", note: "新申请" }, makeId, now);
  assert.equal(reused.row.id, "M-OLD");
  assert.equal(reused.row.status, "pending");
  assert.equal(reused.row.direction, "user_request");
  assert.equal(reused.row.createdAt, "2026-07-01T00:00:00.000Z");

  const repeated = requestMembership(db, db.users[0], { organizationId: "O1", note: "不会覆盖" }, makeId, now);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.row.note, "新申请");
});

test("accepting one invitation activates it and rejects every other pending relation", () => {
  const db = fixture();
  db.memberships = [
    { id: "M1", userId: "U1", organizationId: "O1", role: "member", status: "pending", direction: "organization_invite", note: "", createdAt: now(), updatedAt: now() },
    { id: "M2", userId: "U1", organizationId: "O2", role: "member", status: "pending", direction: "organization_invite", note: "", createdAt: now(), updatedAt: now() }
  ];
  const result = actAsPersonalUser(db, db.users[0], "M1", "accept", now);
  assert.equal(result.row.status, "active");
  assert.deepEqual(result.cancelled, [{ id: "M2", organizationId: "O2" }]);
  assert.equal(db.memberships.find((row) => row.id === "M2").status, "rejected");
});

test("leaving an organization preserves registrations and certificates", () => {
  const db = fixture();
  db.memberships = [{ id: "M1", userId: "U1", organizationId: "O1", role: "member", status: "active", direction: "user_request", note: "", createdAt: now(), updatedAt: now() }];
  db.registrations = [{ id: "R1", personalUserId: "U1", organizationId: "O1", eventId: "E1" }];
  db.certificates = [{ id: "C1", registrationId: "R1", status: "published" }];
  const before = structuredClone({ registrations: db.registrations, certificates: db.certificates });
  actAsPersonalUser(db, db.users[0], "M1", "leave", now);
  assert.deepEqual({ registrations: db.registrations, certificates: db.certificates }, before);
  assert.equal(db.memberships[0].status, "removed");
});

test("personal actions enforce their direction, source state and relationship owner", () => {
  const db = fixture();
  db.memberships = [
    { id: "M1", userId: "U1", organizationId: "O1", role: "member", status: "pending", direction: "user_request", note: "", createdAt: now(), updatedAt: now() },
    { id: "M2", userId: "U1", organizationId: "O2", role: "member", status: "pending", direction: "organization_invite", note: "", createdAt: now(), updatedAt: now() }
  ];
  assert.throws(() => actAsPersonalUser(db, db.users[0], "M1", "accept", now), (error) => error.status === 409);
  assert.equal(actAsPersonalUser(db, db.users[0], "M1", "withdraw", now).row.status, "rejected");
  assert.equal(actAsPersonalUser(db, db.users[0], "M2", "reject", now).row.status, "rejected");
  assert.throws(() => actAsPersonalUser(db, db.users[1], "M2", "reject", now), (error) => error.status === 403);
});

test("organization owner actions use ownerUserId and enforce their transition table", () => {
  const db = fixture();
  db.memberships = [
    { id: "M1", userId: "U1", organizationId: "O1", role: "member", status: "pending", direction: "user_request", note: "", createdAt: now(), updatedAt: now() },
    { id: "M2", userId: "U1", organizationId: "O2", role: "member", status: "pending", direction: "organization_invite", note: "", createdAt: now(), updatedAt: now() },
    { id: "M3", userId: "U1", organizationId: "O1", role: "member", status: "pending", direction: "organization_invite", note: "", createdAt: now(), updatedAt: now() },
    { id: "M4", userId: "U1", organizationId: "O1", role: "member", status: "pending", direction: "user_request", note: "", createdAt: now(), updatedAt: now() }
  ];
  assert.throws(() => actAsOrganizationOwner(db, db.users[1], "M3", "approve", now), (error) => error.status === 409);
  const cancellation = actAsOrganizationOwner(db, db.users[1], "M3", "cancel", now);
  assert.equal(cancellation.row.status, "rejected");
  const rejection = actAsOrganizationOwner(db, db.users[1], "M4", "reject", now);
  assert.equal(rejection.row.status, "rejected");
  const approved = actAsOrganizationOwner(db, db.users[1], "M1", "approve", now);
  assert.equal(approved.row.status, "active");
  assert.deepEqual(approved.cancelled, [{ id: "M2", organizationId: "O2" }]);
  assert.throws(() => actAsOrganizationOwner(db, db.users[2], "M1", "remove", now), (error) => error.status === 403);
  assert.equal(actAsOrganizationOwner(db, db.users[1], "M1", "remove", now).row.status, "removed");
});

test("activation refuses a user who is already active in another organization", () => {
  const db = fixture();
  db.memberships = [
    { id: "M1", userId: "U1", organizationId: "O1", role: "member", status: "pending", direction: "user_request", note: "", createdAt: now(), updatedAt: now() },
    { id: "M2", userId: "U1", organizationId: "O2", role: "member", status: "active", direction: "organization_invite", note: "", createdAt: now(), updatedAt: now() }
  ];
  assert.throws(
    () => actAsOrganizationOwner(db, db.users[1], "M1", "approve", now),
    (error) => error.status === 409 && /已加入其他组织/.test(error.message)
  );
  assert.equal(db.memberships.find((row) => row.id === "M1").status, "pending");
});

test("personal and owned membership lists expose only operational organization relations", () => {
  const db = fixture();
  db.memberships = [
    { id: "M1", userId: "U1", organizationId: "O1", role: "member", status: "active", direction: "user_request", note: "", createdAt: now(), updatedAt: now() },
    { id: "M2", userId: "U1", organizationId: "O2", role: "member", status: "pending", direction: "organization_invite", note: "", createdAt: now(), updatedAt: now() }
  ];
  const relations = listPersonalRelations(db, db.users[0]);
  assert.deepEqual(relations.active.map((row) => row.id), ["M1"]);
  assert.deepEqual(relations.invitations.map((row) => row.id), ["M2"]);
  assert.deepEqual(relations.requests, []);
  assert.equal(relations.active[0].organization.name, "组织一");

  const owned = listOwnedMemberships(db, db.users[1]);
  assert.equal(owned.organization.id, "O1");
  assert.deepEqual(owned.summary, { total: 1, pending: 0, active: 1 });
  assert.equal(owned.rows[0].user.name, "普通用户");
});

test("operational organization search matches names and codes", () => {
  const db = fixture();
  db.organizations[1].status = "disabled";
  assert.deepEqual(searchOperationalOrganizations(db, "ORG-001").map((row) => row.id), ["O1"]);
  assert.deepEqual(searchOperationalOrganizations(db, "组织").map((row) => row.id), ["O1"]);
});

test("membership mutations whitelist every public membership row", () => {
  const creationDb = fixture();
  assertMembershipDto(requestMembership(creationDb, creationDb.users[0], { organizationId: "O1" }, makeId, now).row);
  assertMembershipDto(inviteMembership(creationDb, creationDb.users[2], { phone: "13700000001" }, makeId, now).row);

  const personalDb = fixture();
  personalDb.memberships = [{
    id: "M1", userId: "U1", organizationId: "O1", role: "member", status: "pending", direction: "organization_invite", note: "",
    createdAt: now(), updatedAt: now(), invitedPhone: "13700000001", invitedName: "普通用户", internalOnly: "secret"
  }];
  assertMembershipDto(actAsPersonalUser(personalDb, personalDb.users[0], "M1", "accept", now).row);

  const ownerDb = fixture();
  ownerDb.memberships = [{
    id: "M1", userId: "U1", organizationId: "O1", role: "member", status: "pending", direction: "user_request", note: "",
    createdAt: now(), updatedAt: now(), invitedPhone: "13700000001", invitedName: "普通用户", internalOnly: "secret"
  }];
  assertMembershipDto(actAsOrganizationOwner(ownerDb, ownerDb.users[1], "M1", "approve", now).row);
});

test("membership list DTOs whitelist membership, user and organization fields", () => {
  const db = fixture();
  db.organizations[0].internalOnly = "secret";
  db.users[0].internalOnly = "secret";
  db.memberships = [{
    id: "M1", userId: "U1", organizationId: "O1", role: "member", status: "active", direction: "user_request", note: "",
    createdAt: now(), updatedAt: now(), invitedPhone: "13700000001", invitedName: "普通用户", internalOnly: "secret"
  }];

  const relation = listPersonalRelations(db, db.users[0]).active[0];
  assertMembershipDto(relation, ["organization"]);
  assert.deepEqual(relation.organization, {
    id: "O1", name: "组织一", code: "ORG-001", contactName: "负责人一", contactPhone: "13700000011"
  });

  const owned = listOwnedMemberships(db, db.users[1]);
  assertMembershipDto(owned.rows[0], ["user"]);
  assert.deepEqual(owned.rows[0].user, { id: "U1", name: "普通用户", phone: "13700000001" });

  assert.deepEqual(Object.keys(searchOperationalOrganizations(db, "")[0]).sort(), [
    "id", "name", "code", "contactName", "contactPhone"
  ].sort());
});
