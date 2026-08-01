import { isRegistrationOpen } from "../domain/registration-window.js";
import { businessError } from "./events.js";

export function organizationForOwner(db, userId) {
  return db.organizations.find((row) => row.ownerUserId === userId) || null;
}

export function requireOrdinaryUser(user) {
  if (user?.type !== "ordinary") {
    throw businessError(403, "仅普通用户可以个人报名", "ORDINARY_USER_REQUIRED");
  }
  return user;
}

export function requireOrganizationOwner(db, user) {
  if (user?.type !== "organization") {
    throw businessError(403, "仅组织负责人可以执行此操作", "ORGANIZATION_OWNER_REQUIRED");
  }
  const organization = organizationForOwner(db, user.id);
  if (!organization) {
    throw businessError(403, "当前账号没有负责的组织", "ORGANIZATION_OWNER_REQUIRED");
  }
  return organization;
}

export function requireWritableEvent(db, eventId, clock = () => new Date()) {
  const event = db.events.find((row) => row.id === eventId);
  if (!event) {
    throw businessError(404, "赛事不存在或尚未发布", "EVENT_NOT_AVAILABLE");
  }
  if (event.archivedAt || event.status === "archived") {
    throw businessError(409, "赛事已归档，只允许查看历史信息", "EVENT_ARCHIVED");
  }
  const now = typeof clock === "function" ? clock() : clock;
  if (event.status !== "published" && !isRegistrationOpen(event, now || new Date()).open) {
    throw businessError(404, "赛事不存在或尚未发布", "EVENT_NOT_AVAILABLE");
  }
  return event;
}

export function requireOrganizationEventParticipation(db, user, eventId, { writable = false } = {}) {
  const organization = requireOrganizationOwner(db, user);
  if (organization.status !== "active") {
    throw businessError(403, "组织已停用", "ORGANIZATION_DISABLED");
  }
  if (organization.reviewStatus !== "approved") {
    throw businessError(403, "组织资质尚未通过", "ORGANIZATION_NOT_APPROVED");
  }
  const event = writable
    ? requireWritableEvent(db, eventId)
    : db.events.find((row) => row.id === eventId);
  if (!event) throw businessError(404, "赛事不存在", "EVENT_NOT_AVAILABLE");
  const participation = db.organizationEventParticipations.find(
    (row) => row.organizationId === organization.id && row.eventId === eventId
  );
  if (!participation) {
    throw businessError(403, "组织尚未加入该赛事", "ORGANIZATION_NOT_JOINED");
  }
  return { organization, event, participation };
}
