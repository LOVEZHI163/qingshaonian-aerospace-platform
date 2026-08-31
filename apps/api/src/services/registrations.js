import { GRADE_GROUPS, groupForGrade } from "../domain/grades.js";
import { isRegistrationOpen } from "../domain/registration-window.js";
import { businessError, projectForHistoricalRegistration, publishedRegistrationEvent, registrationContext } from "./events.js";
import { organizationHistoryFields } from "./organization-account-lifecycle.js";
import { ordinaryRegistrationEligibility, requireOrdinaryRegistrationEligibility, requireOrdinaryUser, requireOrganizationApprovedLeader, requireOrganizationEventParticipation, requireWritableEvent } from "./access-control.js";
import { registrationSubmissionSummary, withRegistrationSubmission } from "./submission-assets.js";
import { decryptStudentId, encryptStudentId, fingerprintStudentId, normalizeStudentId } from "../security/registration-identities.js";
import {
  assertAthleteTypeAvailability,
  participantsForRegistration,
  registrationIdentityFingerprints
} from "./registration-participants.js";

const ATHLETE_FIELDS = ["name", "school", "grade", "phone"];
const RELEASED_REGISTRATION_STATUSES = new Set(["rejected", "cancelled"]);
const IDENTITY_FIELD_KEYS = new Set([
  "studentidnumber",
  "identitynumber",
  "identitycard",
  "identitycardnumber",
  "idcardnumber",
  "idcard",
  "idnumber",
  "nationalidnumber",
  "citizenidnumber"
]);

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, "").toLowerCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

export function athleteKey(athlete) {
  return [
    normalizeText(athlete.name), normalizeText(athlete.school), normalizeText(athlete.grade), normalizePhone(athlete.phone)
  ].join("|");
}

function operationalOrganization(db, organizationId) {
  return db.organizations.find((row) => row.id === organizationId && row.status === "active" && row.reviewStatus === "approved");
}

function requireText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw businessError(422, `${label}不能为空`);
  return text;
}

export function requireStudentIdForNewRegistration(input) {
  try {
    return normalizeStudentId(input?.studentIdNumber);
  } catch {
    throw businessError(400, "身份证号校验失败", "INVALID_STUDENT_ID_NUMBER");
  }
}

function normalizedFieldKey(key) {
  return String(key).replace(/[_-]/g, "").toLowerCase();
}

function findUnexpectedIdentityField(value, path = [], seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = normalizedFieldKey(key);
    const canonicalRootStudentId = path.length === 0 && normalizedKey === "studentidnumber";
    if (!canonicalRootStudentId && (IDENTITY_FIELD_KEYS.has(normalizedKey) || key.includes("身份证"))) {
      return [...path, key].join(".");
    }
    const nested = findUnexpectedIdentityField(nestedValue, [...path, key], seen);
    if (nested) return nested;
  }
  return null;
}

function safeRegistrationAthlete(input, fallback = {}) {
  const unexpectedIdentityField = findUnexpectedIdentityField(input);
  if (unexpectedIdentityField) {
    throw businessError(400, "身份证号字段位置不合法", "INVALID_STUDENT_ID_NUMBER");
  }
  if (!Object.hasOwn(input || {}, "athlete")) return fallback;
  const athlete = input.athlete;
  if (!athlete || typeof athlete !== "object" || Array.isArray(athlete)) return {};
  return Object.fromEntries(ATHLETE_FIELDS.filter((field) => Object.hasOwn(athlete, field)).map((field) => [field, athlete[field]]));
}

export function createRegistrationIdentity(db, registrationId, studentIdNumber, timestamp = new Date().toISOString()) {
  db.registrationIdentities ||= [];
  const row = {
    registrationId,
    ...encryptStudentId(studentIdNumber),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  db.registrationIdentities.push(row);
  return row;
}

export function assertExistingIdentityMatches(db, registrationId, studentIdNumber) {
  const identity = (db.registrationIdentities || []).find((row) => row.registrationId === registrationId);
  if (!identity) return null;
  try {
    const normalized = normalizeStudentId(studentIdNumber);
    const submittedFingerprint = fingerprintStudentId(normalized);
    const decrypted = decryptStudentId(identity);
    const decryptedFingerprint = fingerprintStudentId(decrypted);
    if (identity.idFingerprint === submittedFingerprint && decrypted === normalized && decryptedFingerprint === identity.idFingerprint) {
      return identity;
    }
  } catch {
    // Every storage inconsistency is exposed as one stable business conflict.
  }
  throw businessError(409, "该报名已绑定其他身份证号", "REGISTRATION_IDENTITY_CONFLICT");
}

function canReadRegistrationIdentity(db, registration, actor) {
  if (actor?.type === "admin") return true;
  if (actor?.type === "ordinary") return registration.personalUserId === actor.id;
  if (actor?.type === "organization") {
    const organization = db.organizations.find((row) => row.ownerUserId === actor.id);
    return Boolean(organization && organization.id === registration.organizationId);
  }
  return false;
}

export function attachAuthorizedIdentity(db, registration, actor) {
  const identity = (db.registrationIdentities || []).find((row) => row.registrationId === registration.id);
  const participants = participantsForRegistration(db, registration, actor);
  return {
    ...registration,
    participants,
    participantCount: participants.length,
    studentIdNumber: canReadRegistrationIdentity(db, registration, actor) && identity
      ? decryptStudentId(identity)
      : null
  };
}

export function updateExistingRegistrationIdentity(db, registrationId, input, timestamp = new Date().toISOString()) {
  const identity = (db.registrationIdentities || []).find((row) => row.registrationId === registrationId);
  if (!identity || !Object.hasOwn(input || {}, "studentIdNumber")) return identity || null;
  const studentIdNumber = requireStudentIdForNewRegistration(input);
  Object.assign(identity, encryptStudentId(studentIdNumber), { updatedAt: timestamp });
  return identity;
}

export function activeMembershipOrganizations(db, userId) {
  return db.memberships
    .filter((membership) => membership.userId === userId && membership.role === "member" && membership.status === "active")
    .map((membership) => {
      const organization = operationalOrganization(db, membership.organizationId);
      return organization && { ...organization, membershipRole: membership.role };
    })
    .filter(Boolean);
}

export function registrationContextPayload(db, userId, input = {}, clock = () => new Date()) {
  const eligibility = ordinaryRegistrationEligibility(db, userId);
  const organizations = activeMembershipOrganizations(db, userId);
  const event = publishedRegistrationEvent(db, input.eventId, clock);
  const projects = db.projects
    .filter((project) => project.eventId === event.id && project.enabled)
    .sort((left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id));
  return {
    eligibility,
    organizations,
    defaultOrganizationId: organizations.length === 1 ? organizations[0].id : "",
    event,
    projects,
    grades: GRADE_GROUPS
  };
}

export function findSchools(db, query) {
  const needle = normalizeText(query);
  const values = [
    ...db.organizations
      .filter((organization) => organization.status === "active" && organization.reviewStatus === "approved")
      .map((organization) => organization.name),
    ...db.registrations.map((registration) => registration.athlete?.school)
  ];
  const known = new Set();
  return values.filter((value) => {
    const name = String(value || "").trim();
    const normalized = normalizeText(name);
    if (!normalized || known.has(normalized) || (needle && !normalized.includes(needle))) return false;
    known.add(normalized);
    return true;
  }).slice(0, 20);
}

function validateOrganizationForUser(db, userId) {
  return requireOrdinaryRegistrationEligibility(db, userId, { requireApprovedLeader: false }).organization;
}

function validateProjectForRegistration(db, eventId, projectId, group) {
  const project = db.projects.find((row) => row.id === projectId);
  if (!project || project.eventId !== eventId) throw businessError(422, "赛项不属于报名赛事");
  if (!project.enabled) throw businessError(422, "赛项已停用");
  if (!project.allowedGroups.includes(group)) throw businessError(422, "所选组别不能报名该赛项");
  return project;
}

function assertRegistrationProjectImmutable(row, input) {
  if (Object.hasOwn(input || {}, "projectId") && input.projectId && input.projectId !== row.projectId) {
    throw businessError(409, "报名创建后不能修改赛项；如需更换赛项，请取消后重新报名", "REGISTRATION_PROJECT_IMMUTABLE");
  }
}

function assertRegistrationWindowOpen(db, eventId) {
  const event = db.events.find((row) => row.id === eventId);
  if (!event) throw businessError(422, "赛事不存在");
  const window = isRegistrationOpen(event);
  if (!window.open) throw businessError(409, window.reason, "REGISTRATION_CLOSED");
  return event;
}

export function validateRegistration(input, existingRows, project, eventId, ignoreId = null) {
  const athlete = input.athlete || {};
  const errors = [];
  for (const [value, label] of [[athlete.name, "姓名"], [athlete.school, "学校"], [athlete.grade, "年级"], [athlete.phone, "手机号/家长手机号"], [input.projectId, "赛项"]]) {
    if (!String(value || "").trim()) errors.push(`${label}不能为空`);
  }
  const key = athleteKey(athlete);
  const projectType = project?.type || "individual";
  const activeRows = existingRows.filter((row) => (
    row.id !== ignoreId && row.eventId === eventId && new Set(["pending", "approved"]).has(row.status)
  ));
  const sameAthleteRows = activeRows.filter((row) => row.athleteKey === key);
  return { ok: errors.length === 0, errors, athleteKey: key, projectType, duplicateCount: sameAthleteRows.length };
}

function submittedOrStoredFingerprint(db, registration, input) {
  if (Object.hasOwn(input || {}, "studentIdNumber")) {
    return fingerprintStudentId(requireStudentIdForNewRegistration(input));
  }
  return registrationIdentityFingerprints(db, registration)[0] || null;
}

function assertIndividualTypeAvailability(db, registration, input, project, eventId, ignoreRegistrationId = null) {
  if ((project?.type || "individual") !== "individual") return;
  if (RELEASED_REGISTRATION_STATUSES.has(registration?.status)) return;
  const fingerprint = submittedOrStoredFingerprint(db, registration, input);
  if (!fingerprint) return;
  assertAthleteTypeAvailability(db, {
    eventId,
    projectType: "individual",
    fingerprints: [fingerprint],
    ignoreRegistrationId
  });
}

export function prepareRegistrationCreate(db, input, userId, clock = () => new Date()) {
  const athlete = safeRegistrationAthlete(input);
  requireText(athlete.name, "姓名");
  requireText(athlete.school, "学校");
  requireText(athlete.grade, "年级");
  requireText(athlete.phone, "手机号/家长手机号");
  const group = groupForGrade(athlete.grade);
  if (!group) throw businessError(422, "实际年级不合法");
  const projectId = requireText(input?.projectId, "赛项");
  const { event, project } = registrationContext(db, { ...input, projectId, group }, clock);
  const organization = validateOrganizationForUser(db, userId);
  assertIndividualTypeAvailability(db, { id: null, projectType: project.type }, input, project, event.id);
  const validation = validateRegistration({ ...input, athlete, projectId }, db.registrations, project, event.id);
  if (!validation.ok) throw Object.assign(businessError(422, validation.errors[0]), { validation });
  return { event, project, athlete, group, organization, validation };
}

function duplicateCheckRowsForActor(db, actor) {
  if (actor?.type === "admin") return db.registrations;
  if (actor?.type === "ordinary") {
    return db.registrations.filter((row) => row.personalUserId === actor.id);
  }
  if (actor?.type === "organization") {
    const organization = db.organizations.find((row) => row.ownerUserId === actor.id);
    if (!organization) return [];
    return db.registrations.filter((row) => row.organizationId === organization.id);
  }
  return [];
}

export function registrationDuplicateCheck(db, input, actor, clock = () => new Date()) {
  requireEventId(db, input?.eventId);
  const athlete = input?.athlete || input || {};
  const group = groupForGrade(athlete.grade);
  if (!group) throw businessError(422, "实际年级不合法");
  const projectId = requireText(input?.projectId, "赛项");
  const { event } = registrationContext(db, { ...input, projectId, group }, clock);
  const fingerprint = fingerprintStudentId(requireStudentIdForNewRegistration(input));
  const matches = duplicateCheckRowsForActor(db, actor).filter((row) => (
    row.eventId === event.id
    && row.projectId === projectId
    && registrationIdentityFingerprints(db, row).includes(fingerprint)
  ));
  return {
    duplicate: matches.length > 0,
    duplicateCount: matches.length,
    individualUsed: matches.some((row) => row.projectType === "individual"),
    teamUsed: matches.some((row) => row.projectType === "team")
  };
}

export function prepareAdminRegistrationUpdate(db, row, input) {
  if (Object.hasOwn(input, "eventId") && input.eventId !== row.eventId) {
    throw businessError(422, "不能把历史报名移动到其他赛事");
  }
  assertRegistrationProjectImmutable(row, input);
  if (!db.events.some((event) => event.id === row.eventId)) throw businessError(422, "赛事不存在");
  const athlete = safeRegistrationAthlete(input, row.athlete);
  requireText(athlete.name, "姓名");
  requireText(athlete.school, "学校");
  requireText(athlete.grade, "年级");
  requireText(athlete.phone, "手机号/家长手机号");
  const group = groupForGrade(athlete.grade);
  if (!group) throw businessError(422, "实际年级不合法");
  const projectId = input.projectId || row.projectId;
  const project = projectForHistoricalRegistration(db, row, projectId, group);
  const organizationId = Object.hasOwn(input, "organizationId") ? input.organizationId || null : row.organizationId;
  let organization = null;
  if (organizationId) {
    organization = operationalOrganization(db, organizationId);
    if (!organization) throw businessError(422, "组织不存在、未审核或已停用");
  }
  if (row.source === "member_registration") {
    requireMemberIdentity(db, organizationId, row.personalUserId, athlete);
  }
  const next = { ...row, athlete, group, projectId, organizationId, instructor: input.instructor ?? row.instructor };
  assertIndividualTypeAvailability(db, row, input, project, row.eventId, row.id);
  const validation = validateRegistration(next, db.registrations, project, row.eventId, row.id);
  if (!validation.ok) throw Object.assign(businessError(422, validation.errors[0]), { validation });
  return { athlete, group, project, organizationId, organization, instructor: next.instructor || "", validation };
}

export function prepareOrdinaryRegistrationUpdate(db, row, input, userId) {
  if (row.personalUserId !== userId) throw businessError(403, "无权修改该报名");
  assertRegistrationProjectImmutable(row, input);
  assertRegistrationWindowOpen(db, row.eventId);
  const athlete = safeRegistrationAthlete(input, row.athlete);
  requireText(athlete.name, "姓名");
  requireText(athlete.school, "学校");
  requireText(athlete.grade, "年级");
  requireText(athlete.phone, "手机号/家长手机号");
  const group = groupForGrade(athlete.grade);
  if (!group) throw businessError(422, "实际年级不合法");
  const projectId = input.projectId || row.projectId;
  const project = validateProjectForRegistration(db, row.eventId, projectId, group);
  const organization = validateOrganizationForUser(db, userId);
  const organizationId = organization.id;
  if (row.source === "member_registration") {
    requireMemberIdentity(db, organizationId, row.personalUserId, athlete);
  }
  const next = { ...row, athlete, group, projectId, organizationId, instructor: input.instructor ?? row.instructor };
  assertIndividualTypeAvailability(db, row, input, project, row.eventId, row.id);
  const validation = validateRegistration(next, db.registrations, project, row.eventId, row.id);
  if (!validation.ok) throw Object.assign(businessError(422, validation.errors[0]), { validation });
  return { athlete, group, project, organizationId, organization, source: "member_registration", instructor: next.instructor || "", validation };
}

export function updateRegistrationStatus(db, row, input, user) {
  const status = String(input?.status || "");
  if (user.type === "admin" && status === "approved") {
    const submission = registrationSubmissionSummary(db, row);
    if (submission?.required && !submission.complete) {
      throw businessError(422, "必传作品材料不完整、已清理或文件缺失，不能直接通过报名", "SUBMISSION_ASSETS_INCOMPLETE");
    }
  }
  if (!new Set(["approved", "rejected", "cancelled", "pending"]).has(status)) throw businessError(422, "状态不合法");
  if (user.type !== "admin") {
    if (row.personalUserId !== user.id) throw businessError(403, "无权修改该报名");
    if (status !== "cancelled") throw businessError(403, "普通用户只能取消自己的报名");
    assertRegistrationWindowOpen(db, row.eventId);
  }
  if (new Set(["pending", "approved"]).has(status)) {
    assertAthleteTypeAvailability(db, {
      eventId: row.eventId,
      projectType: row.projectType || "individual",
      fingerprints: registrationIdentityFingerprints(db, row),
      ignoreRegistrationId: row.id
    });
  }
  row.status = status;
  row.rejectReason = status === "rejected" ? String(input?.rejectReason || "信息需补充") : "";
  return row;
}

export function filterAdminRegistrations(db, query = {}) {
  const q = normalizeText(query.q);
  const athleteName = normalizeText(query.athleteName);
  let rows = db.registrations.filter((row) => {
    if (query.eventId && row.eventId !== query.eventId) return false;
    if (query.status && row.status !== query.status) return false;
    if (query.group && row.group !== query.group) return false;
    if (query.projectId && row.projectId !== query.projectId) return false;
    if (query.organizationId && row.organizationId !== query.organizationId) return false;
    if (athleteName && !normalizeText(row.athlete?.name).includes(athleteName)) return false;
    if (!q) return true;
    return [row.id, row.athlete?.name, row.athlete?.school, row.athlete?.phone, row.organization, row.projectName, row.instructor]
      .some((value) => normalizeText(value).includes(q));
  });
  return rows.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || right.id.localeCompare(left.id));
}

export function listAdminRegistrations(db, query, clock = () => new Date()) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requestedSize = Number.parseInt(query.pageSize, 10);
  const pageSize = Math.min(100, Math.max(10, requestedSize || 25));
  let rows = filterAdminRegistrations(db, query);
  const total = rows.length;
  rows = rows.slice((page - 1) * pageSize, page * pageSize).map((row) => attachAuthorizedIdentity(db, {
    ...withRegistrationSubmission(db, row),
    ...organizationHistoryFields(row),
    grade: row.athlete?.grade || ""
  }, { type: "admin" }));
  return { rows, total, page, pageSize, refreshedAt: clock().toISOString() };
}

export function listOrganizationRegistrations(db, organizationId, query = {}, clock = () => new Date()) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requestedSize = Number.parseInt(query.pageSize, 10);
  const pageSize = Math.min(100, Math.max(10, requestedSize || 25));
  const q = normalizeText(query.q);
  const owned = db.registrations.filter((row) => row.organizationId === organizationId);
  const filtered = owned.filter((row) => {
    if (query.eventId && row.eventId !== query.eventId) return false;
    if (query.projectId && row.projectId !== query.projectId) return false;
    if (query.status && row.status !== query.status) return false;
    if (!q) return true;
    return [row.id, row.athlete?.name, row.athlete?.phone, row.projectName]
      .some((value) => normalizeText(value).includes(q));
  }).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || b.id.localeCompare(a.id));
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize).map((row) => {
    const event = db.events.find((item) => item.id === row.eventId);
    return attachAuthorizedIdentity(db, {
      ...withRegistrationSubmission(db, row),
      eventName: event?.name || row.eventId,
      eventStatus: event?.status || "",
      archivedAt: event?.archivedAt || null
    }, { type: "organization", id: db.organizations.find((item) => item.id === organizationId)?.ownerUserId });
  });
  const events = [...new Map(owned.map((row) => {
    const event = db.events.find((item) => item.id === row.eventId);
    return [row.eventId, { id: row.eventId, name: event?.name || row.eventId }];
  })).values()];
  const projects = [...new Map(owned.map((row) => [row.projectId, { id: row.projectId, name: row.projectName || row.projectId }])).values()];
  return { rows, total: filtered.length, page, pageSize, refreshedAt: clock().toISOString(), filterOptions: { events, projects } };
}

export function findRegistrationIdentity(db, eventId, projectId, fingerprint) {
  const matchingRows = db.registrations.filter((row) => (
    row.eventId === eventId && row.projectId === projectId
    && registrationIdentityFingerprints(db, row).includes(fingerprint)
  ));
  for (const row of matchingRows) {
    const participantIds = new Set((db.registrationParticipants || [])
      .filter((participant) => participant.registrationId === row.id)
      .map((participant) => participant.id));
    const identityRows = (db.registrationParticipantIdentities || [])
      .filter((identity) => participantIds.has(identity.participantId));
    if (identityRows.length === 0 && (row.projectType || "individual") === "individual") {
      const legacyIdentity = (db.registrationIdentities || [])
        .find((identity) => identity.registrationId === row.id);
      if (legacyIdentity) identityRows.push(legacyIdentity);
    }
    try {
      if (identityRows.some((identity) => (
        fingerprintStudentId(decryptStudentId(identity)) !== identity.idFingerprint
      ))) {
        throw new Error("identity fingerprint mismatch");
      }
    } catch {
      throw businessError(409, "报名身份证信息校验失败", "REGISTRATION_IDENTITY_CONFLICT");
    }
  }
  return matchingRows[0] || null;
}

export function requireEventId(db, value) {
  const eventId = String(value || "").trim();
  if (!eventId) throw businessError(422, "请选择赛事", "EVENT_ID_REQUIRED");
  const event = db.events.find((row) => row.id === eventId);
  if (!event) throw businessError(404, "赛事不存在", "EVENT_NOT_AVAILABLE");
  return event;
}

function requireOperationalOrganization(db, organizationId) {
  const organization = db.organizations.find((row) => row.id === organizationId);
  if (!organization) throw businessError(404, "组织不存在", "ORGANIZATION_NOT_FOUND");
  if (organization.status !== "active") {
    throw businessError(403, "组织已停用", "ORGANIZATION_DISABLED");
  }
  if (organization.reviewStatus === "pending") {
    throw businessError(403, "组织资质正在审核中", "ORGANIZATION_REVIEW_PENDING");
  }
  if (organization.reviewStatus === "rejected") {
    throw businessError(403, "组织资质审核未通过", "ORGANIZATION_REJECTED");
  }
  return organization;
}

function requireOpenRegistrationEvent(db, eventId, clock) {
  const event = requireWritableEvent(db, eventId, clock);
  const window = isRegistrationOpen(event, clock());
  if (!window.open) throw businessError(409, window.reason, "REGISTRATION_CLOSED");
  return event;
}

function requireActiveOrganizationMember(db, organizationId, memberUserId) {
  const userId = String(memberUserId || "").trim();
  if (!userId) {
    throw businessError(422, "请选择组织成员", "MEMBER_USER_ID_REQUIRED");
  }
  const membership = db.memberships.find((row) => (
    row.userId === userId
    && row.organizationId === organizationId
    && row.role === "member"
    && row.status === "active"
  ));
  const user = membership && db.users.find((row) => (
    row.id === userId && row.type === "ordinary" && row.status === "active"
  ));
  if (!user) {
    throw businessError(403, "所选用户不是本组织的有效普通成员", "ACTIVE_ORGANIZATION_MEMBER_REQUIRED");
  }
  return user;
}

function requireMemberIdentity(db, organizationId, memberUserId, athlete) {
  const member = requireActiveOrganizationMember(db, organizationId, memberUserId);
  if (normalizeText(athlete?.name) !== normalizeText(member.name) || normalizePhone(athlete?.phone) !== normalizePhone(member.phone)) {
    throw businessError(422, "参赛者姓名和手机号必须与所选组织成员一致", "MEMBER_IDENTITY_MISMATCH");
  }
  return member;
}

function validateCreateForEvent(db, input, event, actor, channel) {
  const athlete = safeRegistrationAthlete(input);
  requireText(athlete.name, "姓名");
  requireText(athlete.school, "学校");
  requireText(athlete.grade, "年级");
  requireText(athlete.phone, "手机号/家长手机号");
  const group = groupForGrade(athlete.grade);
  if (!group) throw businessError(422, "实际年级不合法");
  const projectId = requireText(input?.projectId, "赛项");
  const project = validateProjectForRegistration(db, event.id, projectId, group);
  let organization = null;
  let registrationSource = "member_registration";
  let personalUserId = actor.id;
  if (channel === "personal") {
    requireOrdinaryUser(actor);
    organization = requireOrdinaryRegistrationEligibility(db, actor.id, { requireApprovedLeader: false }).organization;
  } else if (channel === "organization") {
    const scope = requireOrganizationEventParticipation(db, actor, event.id, { writable: true });
    organization = requireOperationalOrganization(db, scope.organization.id);
    registrationSource = String(input?.registrationSource || "");
    if (!new Set(["member_registration", "organization_proxy"]).has(registrationSource)) {
      throw businessError(422, "报名来源不合法", "REGISTRATION_SOURCE_INVALID");
    }
    if (registrationSource === "member_registration") {
      const member = requireMemberIdentity(db, organization.id, input?.memberUserId, athlete);
      personalUserId = member.id;
    } else {
      personalUserId = null;
    }
  } else {
    throw businessError(422, "报名渠道不合法");
  }
  return { athlete, group, project, organization, registrationSource, personalUserId, key: athleteKey(athlete) };
}

export function createOrMergeRegistration(db, input, actor, channel, {
  makeId,
  now = () => new Date().toISOString(),
  clock = () => new Date()
} = {}) {
  const event = requireOpenRegistrationEvent(db, requireEventId(db, input?.eventId).id, clock);
  const prepared = validateCreateForEvent(db, input, event, actor, channel);
  const studentIdNumber = requireStudentIdForNewRegistration(input);
  const fingerprint = fingerprintStudentId(studentIdNumber);
  const existing = findRegistrationIdentity(db, event.id, prepared.project.id, fingerprint);
  const personalUserId = prepared.personalUserId;
  const organizationId = prepared.organization?.id || null;

  if (!existing) {
    // POST routes execute under the store mutation lock; this check therefore
    // revalidates the current leader state immediately before the new row is made.
    requireOrganizationApprovedLeader(db, organizationId);
    assertAthleteTypeAvailability(db, {
      eventId: event.id,
      projectType: prepared.project.type,
      fingerprints: [fingerprint],
      ignoreRegistrationId: null
    });
    const timestamp = now();
    const row = {
      id: makeId("R"), eventId: event.id, source: prepared.registrationSource, createdByUserId: actor.id,
      personalUserId, organizationId, createdVia: channel, organization: prepared.organization?.name || "",
      athlete: prepared.athlete, athleteKey: prepared.key, group: prepared.group,
      projectId: prepared.project.id, projectName: prepared.project.name, projectType: prepared.project.type,
      instructor: String(input?.instructor || "").trim(), status: "pending", rejectReason: "",
      createdAt: timestamp, updatedAt: timestamp
    };
    db.registrations.unshift(row);
    createRegistrationIdentity(db, row.id, studentIdNumber, timestamp);
    return { row, created: true, merged: false };
  }

  if (existing.organizationDeleted === true) {
    throw businessError(409, "相同赛事、赛项和参赛者的历史报名所属组织已删除，不能重新认领", "REGISTRATION_IDENTITY_CONFLICT");
  }

  if (
    existing.source !== prepared.registrationSource
    || (existing.personalUserId || null) !== (personalUserId || null)
    || (existing.organizationId || null) !== (organizationId || null)
  ) {
    throw businessError(409, "相同赛事、赛项和参赛者的报名已存在且归属不同", "REGISTRATION_IDENTITY_CONFLICT");
  }
  assertExistingIdentityMatches(db, existing.id, studentIdNumber);
  assertAthleteTypeAvailability(db, {
    eventId: event.id,
    projectType: prepared.project.type,
    fingerprints: [fingerprint],
    ignoreRegistrationId: existing.id
  });
  return { row: existing, created: false, merged: false };
}
