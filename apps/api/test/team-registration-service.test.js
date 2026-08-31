import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  assertAthleteTypeAvailability,
  participantsForRegistration,
  prepareTeamRoster
} from "../src/services/registration-participants.js";
import { encryptStudentId, fingerprintStudentId } from "../src/security/registration-identities.js";
import {
  createOrMergeRegistration,
  prepareAdminRegistrationUpdate,
  prepareOrdinaryRegistrationUpdate,
  registrationDuplicateCheck,
  updateExistingRegistrationIdentity,
  updateRegistrationStatus
} from "../src/services/registrations.js";

const firstId = "11010519491231002X";
const secondId = "110105194912310038";
const testKey = Buffer.alloc(32, 23).toString("base64");
const previousKey = process.env.REGISTRATION_ID_ENCRYPTION_KEY;

after(() => {
  if (previousKey === undefined) delete process.env.REGISTRATION_ID_ENCRYPTION_KEY;
  else process.env.REGISTRATION_ID_ENCRYPTION_KEY = previousKey;
});

function participant(overrides = {}) {
  return {
    name: " 队员甲 ",
    school: " 航空学校 ",
    grade: "五年级",
    phone: "138-0000-0001",
    studentIdNumber: firstId,
    ...overrides
  };
}

function project(overrides = {}) {
  return {
    id: "P-TEAM",
    eventId: "E1",
    type: "team",
    allowedGroups: ["小学高段"],
    teamMinMembers: 1,
    teamMaxMembers: 8,
    ...overrides
  };
}

function preparedContext(overrides = {}) {
  let sequence = 0;
  return {
    eventId: "E1",
    project: project(),
    makeId: () => `RP-${++sequence}`,
    timestamp: "2026-08-31T00:00:00.000Z",
    ignoreRegistrationId: null,
    ...overrides
  };
}

function identityDb({ type = "team", status = "pending", participantIdentity = true } = {}) {
  const registration = {
    id: "R-EXISTING",
    eventId: "E1",
    projectType: type,
    status,
    athlete: { name: "历史队员", school: "历史学校", grade: "五年级", phone: "13800000009" }
  };
  const encrypted = encryptStudentId(firstId);
  return {
    registrations: [registration],
    organizations: [],
    registrationParticipants: participantIdentity
      ? [{ id: "RP-EXISTING", registrationId: registration.id, displayOrder: 1, ...registration.athlete }]
      : [],
    registrationParticipantIdentities: participantIdentity
      ? [{ participantId: "RP-EXISTING", ...encrypted }]
      : [],
    registrationIdentities: participantIdentity
      ? []
      : [{ registrationId: registration.id, ...encrypted }]
  };
}

test("team roster normalizes participants and prepares encrypted identities without mutating storage", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const db = identityDb({ status: "cancelled" });
  const before = structuredClone(db);

  const prepared = prepareTeamRoster(db, {
    participants: [participant(), participant({ name: "队员乙", phone: "139 0000 0002", studentIdNumber: secondId })]
  }, preparedContext());

  assert.equal(prepared.group, "小学高段");
  assert.deepEqual(prepared.participants.map(({ id, displayOrder, name, school, grade, phone }) => (
    { id, displayOrder, name, school, grade, phone }
  )), [
    { id: "RP-1", displayOrder: 1, name: "队员甲", school: "航空学校", grade: "五年级", phone: "13800000001" },
    { id: "RP-2", displayOrder: 2, name: "队员乙", school: "航空学校", grade: "五年级", phone: "13900000002" }
  ]);
  assert.deepEqual(prepared.identities.map((row) => row.participantId), ["RP-1", "RP-2"]);
  assert.deepEqual(prepared.identities.map((row) => row.idFingerprint), [
    fingerprintStudentId(firstId), fingerprintStudentId(secondId)
  ]);
  assert.equal(JSON.stringify(prepared).includes(firstId), false);
  assert.equal(JSON.stringify(prepared).includes(secondId), false);
  assert.deepEqual(db, before);
});

test("team roster rejects a ninth participant at the trusted project maximum", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const ninePeople = Array.from({ length: 9 }, (_, index) => participant({ name: `队员${index + 1}` }));

  assert.throws(
    () => prepareTeamRoster(identityDb({ status: "cancelled" }), { participants: ninePeople }, preparedContext()),
    /最多 8 人/
  );
});

test("team roster rejects duplicate identities before adding any row", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const db = { registrations: [], registrationParticipants: [], registrationParticipantIdentities: [], registrationIdentities: [] };

  assert.throws(
    () => prepareTeamRoster(db, {
      participants: [participant(), participant({ name: "队员乙", phone: "13900000002" })]
    }, preparedContext()),
    /同一队伍.*重复/
  );
  assert.deepEqual(db.registrationParticipants, []);
  assert.deepEqual(db.registrationParticipantIdentities, []);
});

test("每届最多 allows one individual plus one team but rejects a second active registration of the same type", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const fingerprint = fingerprintStudentId(firstId);
  const dbWithOneIndividual = identityDb({ type: "individual", participantIdentity: false });
  const dbWithOneTeam = identityDb({ type: "team" });

  assert.doesNotThrow(() => assertAthleteTypeAvailability(dbWithOneIndividual, {
    eventId: "E1", projectType: "team", fingerprints: [fingerprint], ignoreRegistrationId: null
  }));
  assert.throws(() => assertAthleteTypeAvailability(dbWithOneTeam, {
    eventId: "E1", projectType: "team", fingerprints: [fingerprint], ignoreRegistrationId: null
  }), /最多报名一个团队赛/);
  assert.throws(() => assertAthleteTypeAvailability(dbWithOneIndividual, {
    eventId: "E1", projectType: "individual", fingerprints: [fingerprint], ignoreRegistrationId: null
  }), /最多报名一个个人赛/);
});

test("每届最多 ignores edited registrations and releases rejected or cancelled slots", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const fingerprint = fingerprintStudentId(firstId);
  const active = identityDb();

  assert.doesNotThrow(() => assertAthleteTypeAvailability(active, {
    eventId: "E1", projectType: "team", fingerprints: [fingerprint], ignoreRegistrationId: "R-EXISTING"
  }));
  for (const status of ["rejected", "cancelled"]) {
    assert.doesNotThrow(() => assertAthleteTypeAvailability(identityDb({ status }), {
      eventId: "E1", projectType: "team", fingerprints: [fingerprint], ignoreRegistrationId: null
    }));
  }
});

test("team roster projection decrypts identities only for admin and the owning organization", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const db = identityDb();
  db.organizations = [{ id: "O1", ownerUserId: "OWNER1" }, { id: "O2", ownerUserId: "OWNER2" }];
  db.registrations[0].organizationId = "O1";

  const admin = participantsForRegistration(db, db.registrations[0], { id: "ADMIN", type: "admin" });
  const owner = participantsForRegistration(db, db.registrations[0], { id: "OWNER1", type: "organization" });
  const outsider = participantsForRegistration(db, db.registrations[0], { id: "OWNER2", type: "organization" });
  const ordinary = participantsForRegistration(db, db.registrations[0], { id: "U1", type: "ordinary" });

  assert.equal(admin[0].studentIdNumber, firstId);
  assert.equal(owner[0].studentIdNumber, firstId);
  assert.equal(outsider[0].studentIdNumber, null);
  assert.equal(ordinary[0].studentIdNumber, null);
  assert.equal(JSON.stringify(outsider).includes(firstId), false);
  assert.equal(JSON.stringify(ordinary).includes(firstId), false);
});

test("team roster projection builds one normalized compatibility participant for historical rows", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const db = identityDb({ type: "individual", participantIdentity: false });
  db.registrations[0].personalUserId = "U1";

  assert.deepEqual(participantsForRegistration(db, db.registrations[0], { id: "ADMIN", type: "admin" }), [{
    id: null,
    displayOrder: 1,
    name: "历史队员",
    school: "历史学校",
    grade: "五年级",
    phone: "13800000009",
    studentIdNumber: firstId
  }]);
  assert.equal(participantsForRegistration(db, db.registrations[0], { id: "U1", type: "ordinary" })[0].studentIdNumber, null);
});

function individualRegistrationDb() {
  return {
    users: [{ id: "U1", type: "ordinary", name: "队员甲", phone: "13800000001", status: "active" }],
    events: [{
      id: "E1", status: "published", archivedAt: null, registrationMode: "force_open",
      registrationStartAt: "2026-01-01T00:00:00.000Z", registrationEndAt: "2026-12-31T00:00:00.000Z"
    }],
    projects: [
      { id: "P1", eventId: "E1", name: "个人赛一", type: "individual", enabled: true, allowedGroups: ["小学高段"] },
      { id: "P2", eventId: "E1", name: "个人赛二", type: "individual", enabled: true, allowedGroups: ["小学高段"] }
    ],
    organizations: [{ id: "O1", ownerUserId: "OWNER1", name: "航空学校", status: "active", reviewStatus: "approved" }],
    memberships: [{ userId: "U1", organizationId: "O1", status: "active", role: "member" }],
    organizationLeaders: [{ id: "OL1", organizationId: "O1", reviewStatus: "approved", enabled: true }],
    organizationEventParticipations: [{ organizationId: "O1", eventId: "E1" }],
    registrations: [],
    registrationIdentities: [],
    registrationParticipants: [],
    registrationParticipantIdentities: [],
    registrationSubmissionAssets: [],
    certificates: []
  };
}

test("每届最多 is enforced by individual registration creation and released by cancellation", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const db = individualRegistrationDb();
  const actor = { id: "U1", type: "ordinary" };
  let sequence = 0;
  const context = {
    makeId: () => `R-${++sequence}`,
    now: () => "2026-08-31T00:00:00.000Z",
    clock: () => new Date("2026-08-31T00:00:00.000Z")
  };
  const body = (projectId, name) => ({
    eventId: "E1",
    projectId,
    studentIdNumber: firstId,
    athlete: { name, school: "航空学校", grade: "五年级", phone: "13800000001" }
  });

  const first = createOrMergeRegistration(db, body("P1", "队员甲"), actor, "personal", context).row;
  assert.throws(
    () => createOrMergeRegistration(db, body("P2", "队员甲别名"), actor, "personal", context),
    /最多报名一个个人赛/
  );
  assert.equal(db.registrations.length, 1);

  updateRegistrationStatus(db, first, { status: "cancelled" }, actor);
  assert.equal(createOrMergeRegistration(db, body("P2", "队员甲别名"), actor, "personal", context).created, true);
  assert.equal(db.registrations.length, 2);
});

test("每届最多 is rechecked before a released registration is reactivated", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const db = individualRegistrationDb();
  const firstEncrypted = encryptStudentId(firstId);
  const first = {
    id: "R1", eventId: "E1", projectType: "individual", status: "cancelled", personalUserId: "U1"
  };
  const second = {
    id: "R2", eventId: "E1", projectType: "individual", status: "approved", personalUserId: "U1"
  };
  db.registrations.push(first, second);
  db.registrationIdentities.push(
    { registrationId: first.id, ...firstEncrypted },
    { registrationId: second.id, ...encryptStudentId(firstId) }
  );

  assert.throws(
    () => updateRegistrationStatus(db, first, { status: "pending" }, { id: "ADMIN", type: "admin" }),
    /最多报名一个个人赛/
  );
  assert.equal(first.status, "cancelled");
});

test("exact-project retries resolve identity fingerprints instead of athlete metadata", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const db = individualRegistrationDb();
  const actor = { id: "U1", type: "ordinary" };
  let sequence = 0;
  const context = {
    makeId: () => `R-FINGERPRINT-${++sequence}`,
    now: () => "2026-08-31T01:00:00.000Z",
    clock: () => new Date("2026-08-31T01:00:00.000Z")
  };
  const input = (studentIdNumber, athlete) => ({ eventId: "E1", projectId: "P1", studentIdNumber, athlete });
  const originalAthlete = { name: "同名队员", school: "同一学校", grade: "五年级", phone: "13800000001" };

  const first = createOrMergeRegistration(db, input(firstId, originalAthlete), actor, "personal", context);
  const sameMetadataDifferentIdentity = createOrMergeRegistration(db, input(secondId, originalAthlete), actor, "personal", context);
  const sameIdentityChangedMetadata = createOrMergeRegistration(db, input(firstId, {
    name: "更正后姓名", school: "更正后学校", grade: "五年级", phone: "13900000009"
  }), actor, "personal", context);

  assert.equal(first.created, true);
  assert.equal(sameMetadataDifferentIdentity.created, true);
  assert.notEqual(sameMetadataDifferentIdentity.row.id, first.row.id);
  assert.equal(sameIdentityChangedMetadata.created, false);
  assert.equal(sameIdentityChangedMetadata.row.id, first.row.id);
  assert.equal(db.registrations.length, 2);
});

test("duplicate checks use identity fingerprints instead of athlete metadata", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const db = individualRegistrationDb();
  const actor = { id: "U1", type: "ordinary" };
  const context = {
    makeId: () => "R-DUPLICATE-FINGERPRINT",
    now: () => "2026-08-31T02:00:00.000Z",
    clock: () => new Date("2026-08-31T02:00:00.000Z")
  };
  const originalAthlete = { name: "重复检查队员", school: "航空学校", grade: "五年级", phone: "13800000001" };
  createOrMergeRegistration(db, {
    eventId: "E1", projectId: "P1", studentIdNumber: firstId, athlete: originalAthlete
  }, actor, "personal", context);

  const sameMetadataDifferentIdentity = registrationDuplicateCheck(db, {
    eventId: "E1", projectId: "P1", studentIdNumber: secondId, athlete: originalAthlete
  }, actor, context.clock);
  const sameIdentityChangedMetadata = registrationDuplicateCheck(db, {
    eventId: "E1", projectId: "P1", studentIdNumber: firstId,
    athlete: { name: "更正姓名", school: "新学校", grade: "五年级", phone: "13900000008" }
  }, actor, context.clock);

  assert.equal(sameMetadataDifferentIdentity.duplicate, false);
  assert.equal(sameMetadataDifferentIdentity.duplicateCount, 0);
  assert.equal(sameIdentityChangedMetadata.duplicate, true);
  assert.equal(sameIdentityChangedMetadata.duplicateCount, 1);
});

test("duplicate checks reveal only registrations owned by the authenticated actor", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const db = individualRegistrationDb();
  db.organizations.push({
    id: "O2", ownerUserId: "OWNER2", name: "其他学校", status: "active", reviewStatus: "approved"
  });
  const base = {
    eventId: "E1",
    projectId: "P1",
    projectType: "individual",
    status: "pending",
    athlete: { name: "同一身份证", school: "航空学校", grade: "五年级", phone: "13800000001" }
  };
  db.registrations.push(
    { ...base, id: "R-PERSONAL", personalUserId: "U1", organizationId: "O1" },
    { ...base, id: "R-FOREIGN-PROXY", personalUserId: null, organizationId: "O2" },
    { ...base, id: "R-UNOWNED-PROXY", personalUserId: null, organizationId: null }
  );
  db.registrationIdentities.push(
    { registrationId: "R-PERSONAL", ...encryptStudentId(firstId) },
    { registrationId: "R-FOREIGN-PROXY", ...encryptStudentId(secondId) },
    { registrationId: "R-UNOWNED-PROXY", ...encryptStudentId(secondId) }
  );
  const request = (studentIdNumber) => ({
    eventId: "E1",
    projectId: "P1",
    studentIdNumber,
    athlete: { name: "任意展示名", school: "任意学校", grade: "五年级", phone: "13900000009" }
  });
  const clock = () => new Date("2026-08-31T02:00:00.000Z");

  const ordinaryOwn = registrationDuplicateCheck(db, request(firstId), { id: "U1", type: "ordinary" }, clock);
  const ordinaryForeign = registrationDuplicateCheck(db, request(secondId), { id: "U1", type: "ordinary" }, clock);
  const firstOwnerOwn = registrationDuplicateCheck(db, request(firstId), { id: "OWNER1", type: "organization" }, clock);
  const firstOwnerForeign = registrationDuplicateCheck(db, request(secondId), { id: "OWNER1", type: "organization" }, clock);
  const secondOwnerOwn = registrationDuplicateCheck(db, request(secondId), { id: "OWNER2", type: "organization" }, clock);
  const adminForeign = registrationDuplicateCheck(db, request(secondId), { id: "ADMIN", type: "admin" }, clock);

  assert.deepEqual(ordinaryOwn, { duplicate: true, duplicateCount: 1, individualUsed: true, teamUsed: false });
  assert.deepEqual(ordinaryForeign, { duplicate: false, duplicateCount: 0, individualUsed: false, teamUsed: false });
  assert.deepEqual(firstOwnerOwn, { duplicate: true, duplicateCount: 1, individualUsed: true, teamUsed: false });
  assert.deepEqual(firstOwnerForeign, { duplicate: false, duplicateCount: 0, individualUsed: false, teamUsed: false });
  assert.deepEqual(secondOwnerOwn, { duplicate: true, duplicateCount: 1, individualUsed: true, teamUsed: false });
  assert.deepEqual(adminForeign, { duplicate: true, duplicateCount: 2, individualUsed: true, teamUsed: false });
  assert.deepEqual(Object.keys(adminForeign).sort(), ["duplicate", "duplicateCount", "individualUsed", "teamUsed"]);
});

test("unrelated corrupt identities do not block exact-project creation", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const db = individualRegistrationDb();
  const corrupt = encryptStudentId(secondId);
  corrupt.authTag = "corrupt";
  db.registrations.push({
    id: "R-CORRUPT-UNRELATED", eventId: "E1", projectId: "P1", projectType: "individual",
    status: "pending", personalUserId: "U2", organizationId: "O1"
  });
  db.registrationIdentities.push({ registrationId: "R-CORRUPT-UNRELATED", ...corrupt });

  const result = createOrMergeRegistration(db, {
    eventId: "E1", projectId: "P1", studentIdNumber: firstId,
    athlete: { name: "新队员", school: "航空学校", grade: "五年级", phone: "13800000001" }
  }, { id: "U1", type: "ordinary" }, "personal", {
    makeId: () => "R-NEW-AFTER-CORRUPT",
    now: () => "2026-08-31T03:00:00.000Z",
    clock: () => new Date("2026-08-31T03:00:00.000Z")
  });

  assert.equal(result.created, true);
  assert.equal(result.row.id, "R-NEW-AFTER-CORRUPT");
});

test("corrupt matching identity candidates still fail closed", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const db = individualRegistrationDb();
  const corrupt = encryptStudentId(firstId);
  corrupt.authTag = "corrupt";
  db.registrations.push({
    id: "R-CORRUPT-MATCH", eventId: "E1", projectId: "P1", projectType: "individual",
    status: "pending", personalUserId: "U1", organizationId: "O1"
  });
  db.registrationIdentities.push({ registrationId: "R-CORRUPT-MATCH", ...corrupt });
  const before = structuredClone(db);

  assert.throws(() => createOrMergeRegistration(db, {
    eventId: "E1", projectId: "P1", studentIdNumber: firstId,
    athlete: { name: "同一队员", school: "航空学校", grade: "五年级", phone: "13800000001" }
  }, { id: "U1", type: "ordinary" }, "personal", {
    makeId: () => "R-MUST-NOT-CREATE",
    now: () => "2026-08-31T03:00:00.000Z",
    clock: () => new Date("2026-08-31T03:00:00.000Z")
  }), (error) => error.status === 409 && error.code === "REGISTRATION_IDENTITY_CONFLICT");
  assert.deepEqual(db, before);
});

function releasedIndividualEditDb(status) {
  const db = individualRegistrationDb();
  const released = {
    id: "R-RELEASED",
    eventId: "E1",
    source: "member_registration",
    personalUserId: "U1",
    organizationId: "O1",
    athlete: { name: "队员甲", school: "航空学校", grade: "五年级", phone: "13800000001" },
    athleteKey: "legacy-summary-only",
    group: "小学高段",
    projectId: "P1",
    projectName: "个人赛一",
    projectType: "individual",
    instructor: "",
    status
  };
  const active = {
    ...released,
    id: "R-ACTIVE",
    personalUserId: "U2",
    athlete: { name: "其他队员", school: "其他学校", grade: "五年级", phone: "13900000002" },
    projectId: "P2",
    projectName: "个人赛二",
    status: "approved"
  };
  db.registrations.push(released, active);
  db.registrationIdentities.push(
    { registrationId: released.id, ...encryptStudentId(firstId) },
    { registrationId: active.id, ...encryptStudentId(secondId) }
  );
  return { db, released };
}

test("released individual rows allow conflicting identity edits but reject later restoration", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;

  const cancelled = releasedIndividualEditDb("cancelled");
  assert.doesNotThrow(() => prepareOrdinaryRegistrationUpdate(
    cancelled.db,
    cancelled.released,
    { studentIdNumber: secondId },
    "U1"
  ));
  updateExistingRegistrationIdentity(cancelled.db, cancelled.released.id, { studentIdNumber: secondId });
  assert.throws(
    () => updateRegistrationStatus(cancelled.db, cancelled.released, { status: "pending" }, { id: "ADMIN", type: "admin" }),
    /最多报名一个个人赛/
  );
  assert.equal(cancelled.released.status, "cancelled");

  const rejected = releasedIndividualEditDb("rejected");
  assert.doesNotThrow(() => prepareAdminRegistrationUpdate(
    rejected.db,
    rejected.released,
    { studentIdNumber: secondId }
  ));
});

test("released team roster edits skip occupancy only with explicit status context", () => {
  process.env.REGISTRATION_ID_ENCRYPTION_KEY = testKey;
  const db = identityDb({ type: "team", status: "approved" });
  const context = preparedContext({
    ignoreRegistrationId: "R-RELEASED-TEAM",
    registrationStatus: "cancelled"
  });

  assert.doesNotThrow(() => prepareTeamRoster(db, { participants: [participant()] }, context));
  assert.throws(() => assertAthleteTypeAvailability(db, {
    eventId: "E1",
    projectType: "team",
    fingerprints: [fingerprintStudentId(firstId)],
    ignoreRegistrationId: "R-RELEASED-TEAM"
  }), /最多报名一个团队赛/);
  assert.throws(() => prepareTeamRoster(db, {
    participants: [participant(), participant()]
  }, context), /同一队伍中不能重复添加同一名队员/);
});
