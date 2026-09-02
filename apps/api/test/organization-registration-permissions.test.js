import assert from "node:assert/strict";
import test from "node:test";

import { ordinaryRegistrationEligibility } from "../src/services/access-control.js";
import {
  createOrMergeRegistration,
  listOrganizationRegistrations,
  prepareOrdinaryRegistrationUpdate
} from "../src/services/registrations.js";

const previousEncryptionKey = process.env.REGISTRATION_ID_ENCRYPTION_KEY;
process.env.REGISTRATION_ID_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
test.after(() => {
  if (previousEncryptionKey === undefined) delete process.env.REGISTRATION_ID_ENCRYPTION_KEY;
  else process.env.REGISTRATION_ID_ENCRYPTION_KEY = previousEncryptionKey;
});

const eventId = "E1";
const projectId = "P1";
const validStudentId = "11010519491231002X";
const otherValidStudentId = "110105194912310038";
const thirdValidStudentId = "110105201401011231";
const fixedNow = "2026-08-07T08:00:00.000Z";
const actor = { id: "U1", type: "ordinary" };
const owner = { id: "UO1", type: "organization", mustChangePassword: false };

function fixture(leaders = []) {
  return {
    users: [
      { ...actor, name: "张同学", phone: "13800000001", status: "active" },
      { ...owner, name: "组织负责人", phone: "13800000011", status: "active" }
    ],
    organizations: [{
      id: "O1", name: "实验小学", ownerUserId: owner.id,
      status: "active", reviewStatus: "approved"
    }],
    memberships: [{ id: "M1", userId: actor.id, organizationId: "O1", role: "member", status: "active" }],
    organizationLeaders: leaders.map((leader, index) => ({
      id: `OL${index + 1}`, organizationId: "O1", reviewStatus: "pending", enabled: true, ...leader
    })),
    organizationLeaderDocuments: [],
    organizationLeaderReviews: [],
    organizationEventParticipations: [{ organizationId: "O1", eventId }],
    events: [{
      id: eventId, name: "测试赛事", status: "published", registrationMode: "force_open",
      registrationStartAt: "2026-08-01T00:00:00.000Z", registrationEndAt: "2026-08-31T00:00:00.000Z"
    }],
    projects: [{
      id: projectId, eventId, name: "纸飞机", type: "individual", enabled: true,
      allowedGroups: ["小学高段"], submissionMode: "none"
    }, {
      id: "P-TEAM", eventId, name: "接力赛", type: "team", enabled: true,
      allowedGroups: ["小学高段"], submissionMode: "none", teamMinMembers: 1, teamMaxMembers: 8
    }],
    registrations: [],
    registrationIdentities: [],
    registrationParticipants: [],
    registrationParticipantIdentities: [],
    registrationSubmissionAssets: [],
    certificates: []
  };
}

function registrationInput(overrides = {}) {
  return {
    eventId,
    projectId,
    studentIdNumber: validStudentId,
    athlete: { name: "张同学", school: "实验小学", grade: "五年级", phone: "13800000001" },
    ...overrides
  };
}

function create(db, channel = "personal", input = registrationInput()) {
  return createOrMergeRegistration(db, input, channel === "personal" ? actor : owner, channel, {
    makeId: () => "R-new",
    now: () => fixedNow,
    clock: () => new Date(fixedNow)
  });
}

test("ordinary eligibility requires at least one approved and enabled leader", () => {
  for (const leaders of [
    [],
    [{ reviewStatus: "pending", enabled: true }],
    [{ reviewStatus: "rejected", enabled: true }],
    [{ reviewStatus: "approved", enabled: false }]
  ]) {
    const eligibility = ordinaryRegistrationEligibility(fixture(leaders), actor.id);
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.code, "ORGANIZATION_LEADER_REQUIRED");
    assert.equal(eligibility.organization.id, "O1");
  }

  const eligibility = ordinaryRegistrationEligibility(
    fixture([{ reviewStatus: "approved", enabled: true }]),
    actor.id
  );
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.code, "OK");
});

test("personal and organization channels reject only genuinely new rows without an approved leader", () => {
  for (const channel of ["personal", "organization"]) {
    const db = fixture();
    const input = channel === "organization"
      ? registrationInput({ registrationSource: "organization_proxy" })
      : registrationInput();
    assert.throws(
      () => create(db, channel, input),
      (error) => error.status === 403 && error.code === "ORGANIZATION_LEADER_REQUIRED"
    );
    assert.deepEqual(db.registrations, []);
    assert.deepEqual(db.registrationIdentities, []);
  }
});

test("another approved leader keeps registration available while one leader returns to review", () => {
  const db = fixture([
    { reviewStatus: "pending", enabled: true },
    { reviewStatus: "approved", enabled: true }
  ]);

  assert.equal(create(db).created, true);
  assert.equal(db.registrations.length, 1);
  assert.equal(db.registrationIdentities.length, 1);
});

test("leader loss blocks later creates but not an existing retry, read, or ordinary patch", () => {
  const db = fixture([{ reviewStatus: "approved", enabled: true }]);
  const existing = create(db).row;
  db.organizationLeaders[0].enabled = false;

  const retry = create(db);
  assert.equal(retry.created, false);
  assert.equal(retry.row.id, existing.id);

  const listed = listOrganizationRegistrations(db, "O1");
  assert.deepEqual(listed.rows.map((row) => row.id), [existing.id]);

  const prepared = prepareOrdinaryRegistrationUpdate(db, existing, { instructor: "仍可修改" }, actor.id);
  assert.equal(prepared.organizationId, "O1");

  assert.throws(
    () => create(db, "personal", registrationInput({
      projectId,
      studentIdNumber: otherValidStudentId,
      athlete: { ...registrationInput().athlete, name: "李同学", phone: "13800000002" }
    })),
    (error) => error.status === 403 && error.code === "ORGANIZATION_LEADER_REQUIRED"
  );
  assert.equal(db.registrations.length, 1);
});

test("team organization proxy is the only channel that creates one persisted roster", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  const teamPayload = {
    eventId,
    projectId: "P-TEAM",
    registrationSource: "organization_proxy",
    instructor: "林老师",
    participants: [
      { name: "队员甲", school: "实验小学", grade: "五年级", phone: "13800000001", studentIdNumber: validStudentId },
      { name: "队员乙", school: "实验小学", grade: "五年级", phone: "13800000002", studentIdNumber: otherValidStudentId }
    ]
  };
  const context = (() => {
    let sequence = 0;
    return {
      makeId: (prefix) => `${prefix}-${++sequence}`,
      now: () => fixedNow,
      clock: () => new Date(fixedNow)
    };
  })();

  for (const [channel, input] of [
    ["personal", teamPayload],
    ["organization", { ...teamPayload, registrationSource: "member_registration", memberUserId: actor.id }]
  ]) {
    const db = fixture([{ reviewStatus: "approved", enabled: true }]);
    assert.throws(
      () => createOrMergeRegistration(db, input, channel === "personal" ? actor : owner, channel, context),
      (error) => error.status === 422 && error.code === "TEAM_ORGANIZATION_PROXY_REQUIRED"
    );
    assert.deepEqual(db.registrations, []);
    assert.deepEqual(db.registrationParticipants, []);
    assert.deepEqual(db.registrationParticipantIdentities, []);
  }

  const db = fixture([{ reviewStatus: "approved", enabled: true }]);
  const created = createOrMergeRegistration(db, teamPayload, owner, "organization", context);
  assert.equal(created.created, true);
  assert.equal(created.row.teamCode, "O1-P-TEAM-01");
  assert.equal(created.row.athlete.name, "队员甲");
  assert.equal(created.row.personalUserId, null);
  assert.deepEqual(db.registrationParticipants.map((row) => [row.registrationId, row.name]), [
    [created.row.id, "队员甲"], [created.row.id, "队员乙"]
  ]);
  assert.equal(db.registrationParticipantIdentities.length, 2);
  assert.equal(JSON.stringify(db).includes(thirdValidStudentId), false);
});
