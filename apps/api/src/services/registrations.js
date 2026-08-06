import { GRADE_GROUPS, groupForGrade } from "../domain/grades.js";
import { isRegistrationOpen } from "../domain/registration-window.js";
import { businessError, projectForHistoricalRegistration, publishedRegistrationEvent, registrationContext } from "./events.js";
import { organizationHistoryFields } from "./organization-account-lifecycle.js";
import { ordinaryRegistrationEligibility, requireOrdinaryRegistrationEligibility, requireOrdinaryUser, requireOrganizationEventParticipation, requireWritableEvent } from "./access-control.js";
import { registrationSubmissionSummary, withRegistrationSubmission } from "./submission-assets.js";

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
  return requireOrdinaryRegistrationEligibility(db, userId).organization;
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
  const activeRows = existingRows.filter((row) => row.id !== ignoreId && row.eventId === eventId);
  const sameAthleteRows = activeRows.filter((row) => row.athleteKey === key);
  if (sameAthleteRows.some((row) => row.projectId === input.projectId)) {
    errors.push("该运动员已报名该赛项");
  }
  return { ok: errors.length === 0, errors, athleteKey: key, projectType, duplicateCount: sameAthleteRows.length };
}

export function prepareRegistrationCreate(db, input, userId, clock = () => new Date()) {
  const athlete = input?.athlete || {};
  requireText(athlete.name, "姓名");
  requireText(athlete.school, "学校");
  requireText(athlete.grade, "年级");
  requireText(athlete.phone, "手机号/家长手机号");
  const group = groupForGrade(athlete.grade);
  if (!group) throw businessError(422, "实际年级不合法");
  const projectId = requireText(input?.projectId, "赛项");
  const { event, project } = registrationContext(db, { ...input, projectId, group }, clock);
  const organization = validateOrganizationForUser(db, userId);
  const validation = validateRegistration({ ...input, athlete, projectId }, db.registrations, project, event.id);
  if (!validation.ok) throw Object.assign(businessError(422, validation.errors[0]), { validation });
  return { event, project, athlete, group, organization, validation };
}

export function registrationDuplicateCheck(db, input, clock = () => new Date()) {
  requireEventId(db, input?.eventId);
  const athlete = input?.athlete || input || {};
  const group = groupForGrade(athlete.grade);
  if (!group) throw businessError(422, "实际年级不合法");
  const projectId = requireText(input?.projectId, "赛项");
  const { event } = registrationContext(db, { ...input, projectId, group }, clock);
  const key = athleteKey(athlete);
  const matches = db.registrations.filter((row) => (
    row.eventId === event.id && row.projectId === projectId && row.athleteKey === key
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
  const athlete = input.athlete || row.athlete;
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
  const next = { ...row, athlete, group, projectId, organizationId, instructor: input.instructor ?? row.instructor };
  const validation = validateRegistration(next, db.registrations, project, row.eventId, row.id);
  if (!validation.ok) throw Object.assign(businessError(422, validation.errors[0]), { validation });
  return { athlete, group, project, organizationId, organization, instructor: next.instructor || "", validation };
}

export function prepareOrdinaryRegistrationUpdate(db, row, input, userId) {
  if (row.personalUserId !== userId) throw businessError(403, "无权修改该报名");
  assertRegistrationProjectImmutable(row, input);
  assertRegistrationWindowOpen(db, row.eventId);
  const athlete = input.athlete || row.athlete;
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
  const next = { ...row, athlete, group, projectId, organizationId, instructor: input.instructor ?? row.instructor };
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
  rows = rows.slice((page - 1) * pageSize, page * pageSize).map((row) => ({
    ...withRegistrationSubmission(db, row),
    ...organizationHistoryFields(row),
    grade: row.athlete?.grade || ""
  }));
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
    return {
      ...withRegistrationSubmission(db, row),
      eventName: event?.name || row.eventId,
      eventStatus: event?.status || "",
      archivedAt: event?.archivedAt || null
    };
  });
  const events = [...new Map(owned.map((row) => {
    const event = db.events.find((item) => item.id === row.eventId);
    return [row.eventId, { id: row.eventId, name: event?.name || row.eventId }];
  })).values()];
  const projects = [...new Map(owned.map((row) => [row.projectId, { id: row.projectId, name: row.projectName || row.projectId }])).values()];
  return { rows, total: filtered.length, page, pageSize, refreshedAt: clock().toISOString(), filterOptions: { events, projects } };
}

export function findRegistrationIdentity(db, eventId, projectId, key) {
  return db.registrations.find((row) => (
    row.eventId === eventId
    && row.projectId === projectId
    && row.athleteKey === key
  )) || null;
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

function validateCreateForEvent(db, input, event, actor, channel) {
  const athlete = input?.athlete || {};
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
    organization = requireOrdinaryRegistrationEligibility(db, actor.id).organization;
  } else if (channel === "organization") {
    const scope = requireOrganizationEventParticipation(db, actor, event.id, { writable: true });
    organization = requireOperationalOrganization(db, scope.organization.id);
    registrationSource = String(input?.registrationSource || "");
    if (!new Set(["member_registration", "organization_proxy"]).has(registrationSource)) {
      throw businessError(422, "报名来源不合法", "REGISTRATION_SOURCE_INVALID");
    }
    if (registrationSource === "member_registration") {
      const member = requireActiveOrganizationMember(db, organization.id, input?.memberUserId);
      if (normalizeText(athlete.name) !== normalizeText(member.name) || normalizePhone(athlete.phone) !== normalizePhone(member.phone)) {
        throw businessError(422, "参赛者姓名和手机号必须与所选组织成员一致", "MEMBER_IDENTITY_MISMATCH");
      }
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
  const existing = findRegistrationIdentity(db, event.id, prepared.project.id, prepared.key);
  const personalUserId = prepared.personalUserId;
  const organizationId = prepared.organization?.id || null;
  const timestamp = now();

  if (!existing) {
    const row = {
      id: makeId("R"), eventId: event.id, source: prepared.registrationSource, createdByUserId: actor.id,
      personalUserId, organizationId, createdVia: channel, organization: prepared.organization?.name || "",
      athlete: prepared.athlete, athleteKey: prepared.key, group: prepared.group,
      projectId: prepared.project.id, projectName: prepared.project.name, projectType: prepared.project.type,
      instructor: String(input?.instructor || "").trim(), status: "pending", rejectReason: "",
      createdAt: timestamp, updatedAt: timestamp
    };
    db.registrations.unshift(row);
    return { row, created: true, merged: false };
  }

  if (
    existing.source !== prepared.registrationSource
    || (existing.personalUserId || null) !== (personalUserId || null)
    || (existing.organizationId || null) !== (organizationId || null)
  ) {
    throw businessError(409, "相同赛事、赛项和参赛者的报名已存在且归属不同", "REGISTRATION_IDENTITY_CONFLICT");
  }
  return { row: existing, created: false, merged: false };
}
