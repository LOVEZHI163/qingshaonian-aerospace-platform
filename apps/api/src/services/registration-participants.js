import { groupForGrade } from "../domain/grades.js";
import {
  createParticipantIdentity,
  decryptStudentId,
  fingerprintStudentId,
  normalizeStudentId
} from "../security/registration-identities.js";
import { businessError } from "./events.js";

const ACTIVE_REGISTRATION_STATUSES = new Set(["pending", "approved"]);
const RELEASED_REGISTRATION_STATUSES = new Set(["rejected", "cancelled"]);

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function normalizedStudentId(value, index) {
  if (!String(value || "").trim()) {
    throw businessError(422, `第 ${index + 1} 名队员身份证号不能为空`);
  }
  try {
    return normalizeStudentId(value);
  } catch {
    throw businessError(422, `第 ${index + 1} 名队员身份证号不合法`, "INVALID_STUDENT_ID_NUMBER");
  }
}

export function normalizeParticipantInput(row, index) {
  const participant = {
    name: String(row?.name || "").trim(),
    school: String(row?.school || "").trim(),
    grade: String(row?.grade || "").trim(),
    phone: normalizePhone(row?.phone),
    studentIdNumber: normalizedStudentId(row?.studentIdNumber, index)
  };
  for (const [field, label] of [["name", "姓名"], ["school", "学校"], ["grade", "年级"], ["phone", "手机号"], ["studentIdNumber", "身份证号"]]) {
    if (!participant[field]) throw businessError(422, `第 ${index + 1} 名队员${label}不能为空`);
  }
  if (!/^1\d{10}$/.test(participant.phone)) throw businessError(422, `第 ${index + 1} 名队员手机号不合法`);
  return participant;
}

export function registrationIdentityFingerprints(db, registration) {
  const participantIds = new Set((db.registrationParticipants || [])
    .filter((row) => row.registrationId === registration.id)
    .map((row) => row.id));
  const participantFingerprints = (db.registrationParticipantIdentities || [])
    .filter((row) => participantIds.has(row.participantId))
    .map((row) => row.idFingerprint)
    .filter(Boolean);
  if (participantFingerprints.length > 0) return participantFingerprints;
  if ((registration.projectType || "individual") !== "individual") return [];
  const legacyIdentity = (db.registrationIdentities || [])
    .find((row) => row.registrationId === registration.id);
  return legacyIdentity?.idFingerprint ? [legacyIdentity.idFingerprint] : [];
}

export function assertAthleteTypeAvailability(db, {
  eventId,
  projectType,
  fingerprints,
  ignoreRegistrationId = null
}) {
  const incoming = (fingerprints || []).filter(Boolean);
  if (new Set(incoming).size !== incoming.length) {
    throw businessError(422, "同一队伍中不能重复添加同一名队员", "DUPLICATE_TEAM_PARTICIPANT");
  }
  const occupied = new Set((db.registrations || [])
    .filter((row) => (
      row.id !== ignoreRegistrationId
      && row.eventId === eventId
      && (row.projectType || "individual") === projectType
      && ACTIVE_REGISTRATION_STATUSES.has(row.status)
    ))
    .flatMap((row) => registrationIdentityFingerprints(db, row)));
  if (!incoming.some((fingerprint) => occupied.has(fingerprint))) return;
  const label = projectType === "team" ? "团队赛" : "个人赛";
  throw businessError(409, `每名选手每届最多报名一个${label}`, "ATHLETE_PROJECT_TYPE_LIMIT");
}

function canReadParticipantIdentity(db, registration, actor) {
  if (actor?.type === "admin") return true;
  if (actor?.type !== "organization") return false;
  return db.organizations?.some((row) => (
    row.id === registration.organizationId && row.ownerUserId === actor.id
  )) || false;
}

function participantDto(row, studentIdNumber) {
  return {
    id: row?.id || null,
    displayOrder: Number(row?.displayOrder) || 1,
    name: String(row?.name || "").trim(),
    school: String(row?.school || "").trim(),
    grade: String(row?.grade || "").trim(),
    phone: normalizePhone(row?.phone),
    studentIdNumber
  };
}

export function participantsForRegistration(db, registration, actor) {
  const authorized = canReadParticipantIdentity(db, registration, actor);
  const stored = (db.registrationParticipants || [])
    .filter((row) => row.registrationId === registration.id)
    .sort((left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id));
  if (stored.length > 0) {
    const identities = new Map((db.registrationParticipantIdentities || [])
      .map((row) => [row.participantId, row]));
    return stored.map((row) => {
      const identity = identities.get(row.id);
      return participantDto(row, authorized && identity ? decryptStudentId(identity) : null);
    });
  }
  const identity = (db.registrationIdentities || [])
    .find((row) => row.registrationId === registration.id);
  return [participantDto(registration.athlete || {}, authorized && identity ? decryptStudentId(identity) : null)];
}

function preparedTimestamp(context) {
  if (typeof context?.timestamp === "function") return context.timestamp();
  if (context?.timestamp) return context.timestamp;
  if (typeof context?.now === "function") {
    const value = context.now();
    return value instanceof Date ? value.toISOString() : value;
  }
  return new Date().toISOString();
}

export function prepareTeamRoster(db, input, context = {}) {
  const project = context.project;
  if (!project || project.type !== "team") throw businessError(422, "赛项不是团队赛");
  const rows = Array.isArray(input?.participants) ? input.participants : [];
  const minimum = project.teamMinMembers ?? 1;
  const maximum = project.teamMaxMembers ?? 8;
  if (rows.length < minimum) throw businessError(422, `团队赛至少 ${minimum} 人`);
  if (rows.length > maximum) throw businessError(422, `团队赛最多 ${maximum} 人`);

  const normalized = rows.map(normalizeParticipantInput);
  const groups = normalized.map((row, index) => {
    const group = groupForGrade(row.grade);
    if (!group) throw businessError(422, `第 ${index + 1} 名队员实际年级不合法`);
    if (!project.allowedGroups?.includes(group)) throw businessError(422, `第 ${index + 1} 名队员组别不适用于该赛项`);
    return group;
  });
  if (new Set(groups).size !== 1) throw businessError(422, "团队队员必须属于同一组别");

  const fingerprints = normalized.map((row) => fingerprintStudentId(row.studentIdNumber));
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw businessError(422, "同一队伍中不能重复添加同一名队员", "DUPLICATE_TEAM_PARTICIPANT");
  }
  if (!context.skipAvailability && !RELEASED_REGISTRATION_STATUSES.has(context.registrationStatus)) {
    assertAthleteTypeAvailability(db, {
      eventId: context.eventId || project.eventId,
      projectType: project.type,
      fingerprints,
      ignoreRegistrationId: context.ignoreRegistrationId || null
    });
  }

  const timestamp = preparedTimestamp(context);
  const participants = normalized.map((row, index) => {
    const existingId = context.existingParticipantIdsByFingerprint instanceof Map
      ? String(context.existingParticipantIdsByFingerprint.get(fingerprints[index]) || "").trim()
      : String(rows[index]?.id || "").trim();
    const id = existingId || context.makeId?.("RP");
    if (!id) throw new Error("prepareTeamRoster requires context.makeId for new participants");
    return {
      id,
      displayOrder: index + 1,
      name: row.name,
      school: row.school,
      grade: row.grade,
      phone: row.phone,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  });
  const identities = participants.map((row, index) => (
    createParticipantIdentity(row.id, normalized[index].studentIdNumber, timestamp)
  ));
  return { participants, identities, fingerprints, group: groups[0] };
}
