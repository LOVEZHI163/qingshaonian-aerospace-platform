import { GRADE_GROUPS, groupForGrade } from "../domain/grades.js";
import { isRegistrationOpen } from "../domain/registration-window.js";
import { businessError, currentPublishedEvent, projectForHistoricalRegistration } from "./events.js";

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
    .filter((membership) => membership.userId === userId && membership.status === "active")
    .map((membership) => {
      const organization = operationalOrganization(db, membership.organizationId);
      return organization && { ...organization, membershipRole: membership.role };
    })
    .filter(Boolean);
}

export function registrationContextPayload(db, userId) {
  const organizations = activeMembershipOrganizations(db, userId);
  const event = currentPublishedEvent(db);
  const projects = db.projects
    .filter((project) => project.eventId === event.id && project.enabled)
    .sort((left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id));
  return {
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

function validateOrganizationForUser(db, userId, organizationId) {
  if (!organizationId) return null;
  const organization = db.organizations.find((row) => row.id === organizationId);
  if (!organization) throw businessError(404, "组织不存在");
  if (organization.status !== "active" || organization.reviewStatus !== "approved") {
    throw businessError(403, "组织尚未通过审核或已停用");
  }
  const membership = db.memberships.find((row) => row.userId === userId && row.organizationId === organizationId && row.status === "active");
  if (!membership) throw businessError(403, "无权使用该组织报名");
  return organization;
}

function validateProjectForCurrentEvent(db, event, projectId, group) {
  const project = db.projects.find((row) => row.id === projectId);
  if (!project || project.eventId !== event.id) throw businessError(422, "赛项不属于当前赛事");
  if (!project.enabled) throw businessError(422, "赛项已停用");
  if (!project.allowedGroups.includes(group)) throw businessError(422, "所选组别不能报名该赛项");
  return project;
}

function validateProjectForRegistration(db, eventId, projectId, group) {
  const project = db.projects.find((row) => row.id === projectId);
  if (!project || project.eventId !== eventId) throw businessError(422, "赛项不属于报名赛事");
  if (!project.enabled) throw businessError(422, "赛项已停用");
  if (!project.allowedGroups.includes(group)) throw businessError(422, "所选组别不能报名该赛项");
  return project;
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
  const activeRows = existingRows.filter((row) => row.id !== ignoreId && row.eventId === eventId && row.status !== "cancelled");
  const sameAthleteRows = activeRows.filter((row) => row.athleteKey === key);
  if (sameAthleteRows.some((row) => row.projectType === projectType)) {
    errors.push(projectType === "individual" ? "该运动员已报名一个个人赛" : "该运动员已报名一个团体赛");
  }
  return { ok: errors.length === 0, errors, athleteKey: key, projectType, duplicateCount: sameAthleteRows.length };
}

export function prepareRegistrationCreate(db, input, userId) {
  const event = currentPublishedEvent(db);
  const window = isRegistrationOpen(event);
  if (!window.open) throw businessError(409, window.reason, "REGISTRATION_CLOSED");
  const athlete = input?.athlete || {};
  requireText(athlete.name, "姓名");
  requireText(athlete.school, "学校");
  requireText(athlete.grade, "年级");
  requireText(athlete.phone, "手机号/家长手机号");
  const group = groupForGrade(athlete.grade);
  if (!group) throw businessError(422, "实际年级不合法");
  const projectId = requireText(input?.projectId, "赛项");
  const project = validateProjectForCurrentEvent(db, event, projectId, group);
  const organization = validateOrganizationForUser(db, userId, input?.organizationId);
  const validation = validateRegistration({ ...input, athlete, projectId }, db.registrations, project, event.id);
  if (!validation.ok) throw Object.assign(businessError(422, validation.errors[0]), { validation });
  return { event, project, athlete, group, organization, validation };
}

export function registrationDuplicateCheck(db, input) {
  const event = currentPublishedEvent(db);
  const window = isRegistrationOpen(event);
  if (!window.open) throw businessError(409, window.reason, "REGISTRATION_CLOSED");
  const athlete = input?.athlete || input || {};
  const group = groupForGrade(athlete.grade);
  if (!group) throw businessError(422, "实际年级不合法");
  validateProjectForCurrentEvent(db, event, requireText(input?.projectId, "赛项"), group);
  const key = athleteKey(athlete);
  const matches = db.registrations.filter((row) => row.eventId === event.id && row.athleteKey === key && row.status !== "cancelled");
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
  if (row.userId !== userId) throw businessError(403, "无权修改该报名");
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
  const organizationId = Object.hasOwn(input, "organizationId") ? input.organizationId || null : row.organizationId;
  const organization = validateOrganizationForUser(db, userId, organizationId);
  const next = { ...row, athlete, group, projectId, organizationId, instructor: input.instructor ?? row.instructor };
  const validation = validateRegistration(next, db.registrations, project, row.eventId, row.id);
  if (!validation.ok) throw Object.assign(businessError(422, validation.errors[0]), { validation });
  return { athlete, group, project, organizationId, organization, instructor: next.instructor || "", validation };
}

export function updateRegistrationStatus(db, row, input, user) {
  const status = String(input?.status || "");
  if (!new Set(["approved", "rejected", "cancelled", "pending"]).has(status)) throw businessError(422, "状态不合法");
  if (user.type !== "admin") {
    if (row.userId !== user.id) throw businessError(403, "无权修改该报名");
    if (status !== "cancelled") throw businessError(403, "普通用户只能取消自己的报名");
    assertRegistrationWindowOpen(db, row.eventId);
  }
  row.status = status;
  row.rejectReason = status === "rejected" ? String(input?.rejectReason || "信息需补充") : "";
  return row;
}

export function filterAdminRegistrations(db, query = {}) {
  const q = normalizeText(query.q);
  let rows = db.registrations.filter((row) => {
    if (query.eventId && row.eventId !== query.eventId) return false;
    if (query.status && row.status !== query.status) return false;
    if (query.group && row.group !== query.group) return false;
    if (query.projectId && row.projectId !== query.projectId) return false;
    if (query.organizationId && row.organizationId !== query.organizationId) return false;
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
    ...row,
    grade: row.athlete?.grade || ""
  }));
  return { rows, total, page, pageSize, refreshedAt: clock().toISOString() };
}
