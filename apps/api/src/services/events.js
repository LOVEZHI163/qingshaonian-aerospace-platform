import { isRegistrationOpen } from "../domain/registration-window.js";
import { APPROVED_GROUP_NAMES, REGISTRATION_MODES } from "../data/seed.js";
import { selectHomeEvents } from "./public-site.js";

const EVENT_EDITABLE_FIELDS = [
  "name",
  "theme",
  "dateLabel",
  "venue",
  "contact",
  "registrationStartAt",
  "registrationEndAt",
  "registrationMode"
];
const EVENT_SYSTEM_FIELDS = ["id", "status", "isCurrent", "archivedAt", "createdAt", "updatedAt"];
const PROJECT_EDITABLE_FIELDS = [
  "name",
  "type",
  "category",
  "enabled",
  "instructorRequired",
  "displayOrder",
  "allowedGroups",
  "submissionMode",
  "teamMinMembers",
  "teamMaxMembers"
];
const SUBMISSION_MODES = new Set(["none", "image_video"]);
const STRICT_ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

export function businessError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function assertObjectInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw businessError(422, "请求内容必须是 JSON 对象");
  }
}

function requireNonEmpty(value, label) {
  if (!String(value ?? "").trim()) throw businessError(422, `${label}不能为空`);
  return String(value).trim();
}

function normalizeIso(value, label) {
  const match = typeof value === "string" ? value.match(STRICT_ISO_8601) : null;
  if (!match) {
    throw businessError(422, `${label}必须是严格 ISO 8601 时间`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0", , , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw businessError(422, `${label}必须是严格 ISO 8601 时间`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw businessError(422, `${label}必须是严格 ISO 8601 时间`);
  return new Date(timestamp).toISOString();
}

function normalizeEventFields(input, current = {}) {
  assertObjectInput(input);
  const next = { ...current };
  for (const field of EVENT_EDITABLE_FIELDS) {
    if (Object.hasOwn(input, field)) next[field] = input[field];
  }
  next.name = requireNonEmpty(next.name, "赛事名称");
  next.theme = requireNonEmpty(next.theme, "赛事主题");
  next.dateLabel = requireNonEmpty(next.dateLabel, "比赛日期");
  next.venue = requireNonEmpty(next.venue, "比赛地点");
  next.contact = requireNonEmpty(next.contact, "联系方式");
  next.registrationStartAt = normalizeIso(next.registrationStartAt, "报名开始时间");
  next.registrationEndAt = normalizeIso(next.registrationEndAt, "报名截止时间");
  if (Date.parse(next.registrationStartAt) >= Date.parse(next.registrationEndAt)) {
    throw businessError(422, "报名开始时间必须早于报名截止时间");
  }
  if (!REGISTRATION_MODES.includes(next.registrationMode)) {
    throw businessError(422, "报名控制模式不合法");
  }
  return next;
}

function assertNoEventSystemFields(input) {
  assertObjectInput(input);
  const field = EVENT_SYSTEM_FIELDS.find((name) => Object.hasOwn(input, name));
  if (field) throw businessError(422, `不能设置系统字段 ${field}`);
}

function normalizeAllowedGroups(value) {
  if (!Array.isArray(value)) throw businessError(422, "适用组别必须是数组");
  const groups = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (groups.length === 0 || !groups.every((group) => APPROVED_GROUP_NAMES.includes(group))) {
    throw businessError(422, "适用组别必须是四个固定组别的非空子集");
  }
  return groups;
}

function submissionMode(value = "none") {
  if (!SUBMISSION_MODES.has(value)) {
    throw businessError(422, "作品提交类型不合法");
  }
  return value;
}

function normalizeTeamMemberBounds(next) {
  if (next.type !== "team") return { teamMinMembers: 1, teamMaxMembers: 1 };
  const min = Number(next.teamMinMembers ?? 1);
  const max = Number(next.teamMaxMembers ?? 8);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || min > 8 || max < 1 || max > 8) {
    throw businessError(422, "团队人数必须是 1 至 8 的整数");
  }
  if (min > max) throw businessError(422, "团队最少人数不能大于最多人数");
  return { teamMinMembers: min, teamMaxMembers: max };
}

function normalizeProjectFields(input, current = {}) {
  assertObjectInput(input);
  const next = { ...current };
  for (const field of PROJECT_EDITABLE_FIELDS) {
    if (Object.hasOwn(input, field)) next[field] = input[field];
  }
  next.name = requireNonEmpty(next.name, "赛项名称");
  next.category = requireNonEmpty(next.category, "赛项类别");
  if (!["individual", "team"].includes(next.type)) throw businessError(422, "赛项类型不合法");
  if (typeof next.enabled !== "boolean") throw businessError(422, "启用状态必须是布尔值");
  if (typeof next.instructorRequired !== "boolean") throw businessError(422, "指导老师要求必须是布尔值");
  if (!Number.isInteger(next.displayOrder) || next.displayOrder < 0) {
    throw businessError(422, "显示顺序必须是非负整数");
  }
  next.allowedGroups = normalizeAllowedGroups(next.allowedGroups);
  next.submissionMode = submissionMode(next.submissionMode);
  Object.assign(next, normalizeTeamMemberBounds(next));
  return next;
}

function syncProjectGroups(db, project) {
  db.projectGroups = db.projectGroups.filter((row) => row.projectId !== project.id);
  db.projectGroups.push(...project.allowedGroups.map((groupName) => ({ projectId: project.id, groupName })));
}

function assertEventWritable(event) {
  if (event.status === "archived" || event.archivedAt) {
    throw businessError(409, "归档赛事不可修改");
  }
}

function ensureDefaultPublicProfile(db, event, updatedAt) {
  db.eventPublicProfiles ||= [];
  if (db.eventPublicProfiles.some((row) => row.eventId === event.id)) return;
  const base = String(event.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event";
  let slug = base;
  let suffix = 2;
  while (db.eventPublicProfiles.some((row) => row.slug === slug)) slug = `${base}-${suffix++}`;
  db.eventPublicProfiles.push({
    eventId: event.id, slug, slogan: "", summary: "", isVisible: false,
    displayOrder: 0, heroMediaId: null, version: 1, updatedAt
  });
}

export function createEvent(db, input, { makeId, clock }) {
  assertNoEventSystemFields(input);
  const fields = normalizeEventFields(input);
  const timestamp = clock().toISOString();
  const event = {
    id: makeId("E"),
    ...fields,
    status: "draft",
    isCurrent: false,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  db.events.push(event);
  ensureDefaultPublicProfile(db, event, timestamp);
  return event;
}

export function updateEvent(db, eventId, input, { clock }) {
  const event = db.events.find((row) => row.id === eventId);
  if (!event) throw businessError(404, "赛事不存在");
  assertEventWritable(event);
  const fields = normalizeEventFields(input, event);
  Object.assign(event, fields, { updatedAt: clock().toISOString() });
  return event;
}

export function copyEvent(db, sourceId, input, { makeId, clock }) {
  assertObjectInput(input);
  const source = db.events.find((row) => row.id === sourceId);
  if (!source) throw businessError(404, "赛事不存在");
  const name = requireNonEmpty(input.name, "新赛事名称");
  const timestamp = clock().toISOString();
  const event = {
    ...source,
    id: makeId("E"),
    name,
    status: "draft",
    isCurrent: false,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  db.events.push(event);
  ensureDefaultPublicProfile(db, event, timestamp);

  const sourceProjects = db.projects.filter((row) => row.eventId === sourceId);
  const projects = sourceProjects.map((sourceProject) => {
    const fields = normalizeProjectFields(sourceProject, sourceProject);
    const project = {
      ...sourceProject,
      ...fields,
      id: makeId("P"),
      eventId: event.id,
      allowedGroups: [...fields.allowedGroups]
    };
    db.projects.push(project);
    syncProjectGroups(db, project);
    return project;
  });
  return { event, projects, registrationCount: 0 };
}

export function setCurrentEvent(db, eventId, { clock }) {
  const target = db.events.find((row) => row.id === eventId);
  if (!target) throw businessError(404, "赛事不存在");
  if (target.status === "archived") throw businessError(409, "归档赛事不能直接设为当前赛事");
  for (const event of db.events) event.isCurrent = event.id === eventId;
  target.archivedAt = null;
  if (db.siteSettings) db.siteSettings.featuredEventId = target.id;
  target.updatedAt = clock().toISOString();
  return target;
}

export function archiveEvent(db, eventId, { clock }) {
  const target = db.events.find((row) => row.id === eventId);
  if (!target) throw businessError(404, "赛事不存在");
  const timestamp = clock().toISOString();
  target.status = "archived";
  target.isCurrent = false;
  target.archivedAt = timestamp;
  target.updatedAt = timestamp;
  return target;
}

export function createProject(db, eventId, input, { makeId }) {
  const event = db.events.find((row) => row.id === eventId);
  if (!event) throw businessError(404, "赛事不存在");
  if (event.status === "archived") throw businessError(409, "归档赛事不能新增赛项");
  const fields = normalizeProjectFields(input);
  const project = { id: makeId("P"), eventId, ...fields };
  db.projects.push(project);
  syncProjectGroups(db, project);
  return project;
}

export function updateProject(db, projectId, input) {
  assertObjectInput(input);
  if (Object.hasOwn(input, "id") || Object.hasOwn(input, "eventId")) {
    throw businessError(422, "不能修改赛项归属或系统编号");
  }
  const project = db.projects.find((row) => row.id === projectId);
  if (!project) throw businessError(404, "赛项不存在");
  assertEventWritable(db.events.find((row) => row.id === project.eventId));
  const fields = normalizeProjectFields(input, project);
  Object.assign(project, fields);
  syncProjectGroups(db, project);
  return project;
}

export function deleteProject(db, projectId) {
  const index = db.projects.findIndex((row) => row.id === projectId);
  if (index < 0) throw businessError(404, "赛项不存在");
  assertEventWritable(db.events.find((row) => row.id === db.projects[index].eventId));
  if (db.registrations.some((row) => row.projectId === projectId)) {
    throw businessError(409, "已有历史报名的赛项不能删除，请改为停用");
  }
  const [project] = db.projects.splice(index, 1);
  db.projectGroups = db.projectGroups.filter((row) => row.projectId !== projectId);
  return project;
}

export function currentPublishedEvent(db) {
  const current = db.events.filter((row) => row.isCurrent && row.status !== "archived" && !row.archivedAt);
  if (current.length !== 1) throw businessError(503, "当前赛事尚未配置");
  return current[0];
}

function assertPublishedRegistrationEvent(db, event, clock) {
  if (event.archivedAt || event.status === "archived") {
    throw businessError(409, "赛事当前不可报名", "REGISTRATION_EVENT_UNAVAILABLE");
  }
  const window = isRegistrationOpen(event, clock());
  if (!window.open) throw businessError(409, window.reason, "REGISTRATION_CLOSED");
  return event;
}

export function publishedRegistrationEvent(db, eventId, clock = () => new Date()) {
  const requestedId = String(eventId || "").trim();
  if (requestedId) {
    const event = db.events.find((row) => row.id === requestedId);
    if (!event) throw businessError(422, "赛事不存在", "REGISTRATION_EVENT_NOT_FOUND");
    return assertPublishedRegistrationEvent(db, event, clock);
  }

  const available = db.events.filter((event) => {
    if (event.status === "archived" || event.archivedAt) return false;
    return isRegistrationOpen(event, clock()).open;
  });
  if (available.length === 1) return available[0];
  if (available.length > 1) throw businessError(422, "存在多场可报名赛事，请选择赛事", "REGISTRATION_EVENT_REQUIRED");

  const publicEvents = db.events.filter((event) => (
    event.status === "published" && !event.archivedAt
  ));
  if (publicEvents.length === 1) return assertPublishedRegistrationEvent(db, publicEvents[0], clock);
  throw businessError(422, "当前没有可报名赛事，请选择赛事后重试", "REGISTRATION_EVENT_REQUIRED");
}

function shanghaiDate(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function publicEventPayload(db, clock = () => new Date()) {
  const selection = selectHomeEvents(db, clock);
  // Preserve older installations whose current event predates public profiles.
  const legacyCurrent = db.events.filter(row => row.isCurrent && row.status === "published" && !row.archivedAt);
  const event = selection.featuredEvent || selection.fallbackEvent || (legacyCurrent.length === 1 ? legacyCurrent[0] : null);
  if (!event) return {
    event: {}, projects: [], groups: [...APPROVED_GROUP_NAMES], grades: [...APPROVED_GROUP_NAMES],
    registrationWindow: { open: false, reason: "暂无公开赛事" }
  };
  const projects = db.projects
    .filter((row) => row.eventId === event.id && row.enabled)
    .sort((left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id));
  const groups = [...APPROVED_GROUP_NAMES];
  return {
    event: {
      ...event,
      date: event.dateLabel,
      registrationDeadline: shanghaiDate(event.registrationEndAt)
    },
    projects,
    groups,
    grades: [...groups],
    registrationWindow: isRegistrationOpen(event, clock())
  };
}

export function registrationContext(db, input, clock = () => new Date()) {
  assertObjectInput(input);
  const event = publishedRegistrationEvent(db, input.eventId, clock);
  const window = isRegistrationOpen(event, clock());
  const project = db.projects.find((row) => row.id === input.projectId);
  if (!project || project.eventId !== event.id) throw businessError(422, "赛项不属于所选赛事");
  if (!project.enabled) throw businessError(422, "赛项已停用");
  if (!APPROVED_GROUP_NAMES.includes(input.group)) throw businessError(422, "组别不在赛事规程范围内");
  if (!project.allowedGroups.includes(input.group)) throw businessError(422, "所选组别不能报名该赛项");
  return { event, project, window };
}

export function projectForHistoricalRegistration(db, registration, projectId, group) {
  const project = db.projects.find((row) => row.id === projectId);
  if (!project) throw businessError(422, "赛项不存在");
  if (project.eventId !== registration.eventId) throw businessError(422, "不能把历史报名移动到其他赛事");
  if (!APPROVED_GROUP_NAMES.includes(group) || !project.allowedGroups.includes(group)) {
    throw businessError(422, "组别不适用于该赛项");
  }
  return project;
}
