import { isRegistrationOpen } from "../domain/registration-window.js";
import { APPROVED_GROUP_NAMES, REGISTRATION_MODES } from "../data/seed.js";

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
  "allowedGroups"
];

export function businessError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function requireNonEmpty(value, label) {
  if (!String(value ?? "").trim()) throw businessError(422, `${label}不能为空`);
  return String(value).trim();
}

function normalizeIso(value, label) {
  if (typeof value !== "string" || !value.trim()) throw businessError(422, `${label}必须是有效 ISO 时间`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw businessError(422, `${label}必须是有效 ISO 时间`);
  return new Date(timestamp).toISOString();
}

function normalizeEventFields(input, current = {}) {
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

function normalizeProjectFields(input, current = {}) {
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
  return next;
}

function syncProjectGroups(db, project) {
  db.projectGroups = db.projectGroups.filter((row) => row.projectId !== project.id);
  db.projectGroups.push(...project.allowedGroups.map((groupName) => ({ projectId: project.id, groupName })));
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
  return event;
}

export function updateEvent(db, eventId, input, { clock }) {
  const event = db.events.find((row) => row.id === eventId);
  if (!event) throw businessError(404, "赛事不存在");
  const fields = normalizeEventFields(input, event);
  Object.assign(event, fields, { updatedAt: clock().toISOString() });
  return event;
}

export function copyEvent(db, sourceId, input, { makeId, clock }) {
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

  const sourceProjects = db.projects.filter((row) => row.eventId === sourceId);
  const projects = sourceProjects.map((sourceProject) => {
    const project = {
      ...sourceProject,
      id: makeId("P"),
      eventId: event.id,
      allowedGroups: [...sourceProject.allowedGroups]
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
  target.status = "published";
  target.archivedAt = null;
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
  if (Object.hasOwn(input, "id") || Object.hasOwn(input, "eventId")) {
    throw businessError(422, "不能修改赛项归属或系统编号");
  }
  const project = db.projects.find((row) => row.id === projectId);
  if (!project) throw businessError(404, "赛项不存在");
  const fields = normalizeProjectFields(input, project);
  Object.assign(project, fields);
  syncProjectGroups(db, project);
  return project;
}

export function deleteProject(db, projectId) {
  const index = db.projects.findIndex((row) => row.id === projectId);
  if (index < 0) throw businessError(404, "赛项不存在");
  if (db.registrations.some((row) => row.projectId === projectId)) {
    throw businessError(409, "已有历史报名的赛项不能删除，请改为停用");
  }
  const [project] = db.projects.splice(index, 1);
  db.projectGroups = db.projectGroups.filter((row) => row.projectId !== projectId);
  return project;
}

export function currentPublishedEvent(db) {
  const current = db.events.filter((row) => row.isCurrent && row.status === "published");
  if (current.length !== 1) throw businessError(503, "当前赛事尚未配置");
  return current[0];
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
  const event = currentPublishedEvent(db);
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
  const event = currentPublishedEvent(db);
  const window = isRegistrationOpen(event, clock());
  if (!window.open) throw businessError(409, window.reason, "REGISTRATION_CLOSED");
  const project = db.projects.find((row) => row.id === input.projectId);
  if (!project || project.eventId !== event.id) throw businessError(422, "赛项不属于当前赛事");
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
