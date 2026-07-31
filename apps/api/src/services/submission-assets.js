import { isRegistrationOpen } from "../domain/registration-window.js";
import { businessError } from "./events.js";
import { requireOrganizationEventParticipation, requireOrdinaryUser, requireWritableEvent } from "./access-control.js";

export const SUBMISSION_ASSET_KINDS = new Set(["artwork_image", "creation_video"]);
const SESSION_TTL_MS = Number(process.env.SUBMISSION_SESSION_TTL_MS || 86_400_000);

function timestamp(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error("Upload session timestamp is invalid");
  return date.toISOString();
}

function eventProject(db, eventId, projectId) {
  const event = requireWritableEvent(db, eventId);
  const window = isRegistrationOpen(event);
  if (!window.open) throw businessError(409, window.reason, "REGISTRATION_CLOSED");
  const project = db.projects.find((row) => row.id === projectId && row.eventId === eventId);
  if (!project || !project.enabled) throw businessError(422, "赛项不存在、未启用或不属于当前赛事", "PROJECT_NOT_WRITABLE");
  if (project.submissionMode !== "image_video") {
    throw businessError(422, "该赛项无需上传图像视频作品", "SUBMISSION_NOT_REQUIRED");
  }
  return { event, project };
}

function sessionIsExpired(session, now) {
  return !session?.expiresAt || Date.parse(session.expiresAt) <= Date.parse(timestamp(now));
}

function validKind(kind) {
  if (!SUBMISSION_ASSET_KINDS.has(kind)) throw businessError(422, "作品材料类型不合法", "SUBMISSION_ASSET_KIND_INVALID");
  return kind;
}

export function submissionAssetSummary(asset) {
  if (!asset) return null;
  return {
    id: asset.id,
    kind: asset.kind,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    durationMs: asset.durationMs,
    uploadedAt: asset.uploadedAt,
    cleanedAt: asset.cleanedAt || null,
    cleanupReason: asset.cleanupReason || "",
    warnings: Array.isArray(asset.warnings) ? asset.warnings : []
  };
}

export function uploadSessionSummary(db, session) {
  if (!session) return null;
  const byKind = new Map(
    db.registrationSubmissionAssets
      .filter((asset) => asset.uploadSessionId === session.id && !asset.registrationId)
      .map((asset) => [asset.kind, asset])
  );
  return {
    id: session.id,
    eventId: session.eventId,
    projectId: session.projectId,
    organizationId: session.organizationId || null,
    state: session.state,
    expiresAt: session.expiresAt,
    assets: {
      artwork_image: submissionAssetSummary(byKind.get("artwork_image")),
      creation_video: submissionAssetSummary(byKind.get("creation_video"))
    }
  };
}

export function createUploadSession({ db, eventId, projectId, actor, channel, now, makeId }) {
  eventProject(db, eventId, projectId);
  let organizationId = null;
  if (channel === "personal") {
    requireOrdinaryUser(actor);
  } else if (channel === "organization") {
    organizationId = requireOrganizationEventParticipation(db, actor, eventId, { writable: true }).organization.id;
  } else {
    throw businessError(422, "上传渠道不合法", "SUBMISSION_CHANNEL_INVALID");
  }
  const createdAt = timestamp(now);
  const expiresAt = new Date(Date.parse(createdAt) + SESSION_TTL_MS).toISOString();
  const session = {
    id: makeId("US"), eventId, projectId, ownerUserId: actor.id, organizationId,
    state: "active", createdAt, expiresAt, committedAt: null
  };
  db.registrationUploadSessions.push(session);
  return session;
}

export function requireUploadSessionAccess({ db, sessionId, actor, channel, now, kind = null }) {
  if (kind !== null) validKind(kind);
  const session = db.registrationUploadSessions.find((row) => row.id === sessionId);
  if (!session) throw businessError(404, "上传会话不存在", "UPLOAD_SESSION_NOT_FOUND");
  if (session.ownerUserId !== actor?.id) throw businessError(403, "无权访问该上传会话", "UPLOAD_SESSION_FORBIDDEN");
  if (channel === "personal") {
    requireOrdinaryUser(actor);
    if (session.organizationId) throw businessError(403, "该上传会话不属于个人报名", "UPLOAD_SESSION_FORBIDDEN");
  } else if (channel === "organization") {
    const { organization } = requireOrganizationEventParticipation(db, actor, session.eventId, { writable: true });
    if (session.organizationId !== organization.id) throw businessError(403, "无权访问该组织上传会话", "UPLOAD_SESSION_FORBIDDEN");
  } else {
    throw businessError(422, "上传渠道不合法", "SUBMISSION_CHANNEL_INVALID");
  }
  eventProject(db, session.eventId, session.projectId);
  if (session.state !== "active") throw businessError(409, "上传会话已提交或不可用", "UPLOAD_SESSION_NOT_ACTIVE");
  if (sessionIsExpired(session, now)) throw businessError(409, "上传会话已过期", "UPLOAD_SESSION_EXPIRED");
  return session;
}

export function replaceSessionAsset({ db, session, kind, stored, actor, now, makeId }) {
  validKind(kind);
  if (!session || session.state !== "active") throw businessError(409, "上传会话不可用", "UPLOAD_SESSION_NOT_ACTIVE");
  const previous = db.registrationSubmissionAssets.find((asset) => (
    asset.uploadSessionId === session.id && asset.kind === kind && !asset.registrationId
  )) || null;
  const asset = {
    id: stored.id || makeId("SA"), registrationId: null, uploadSessionId: session.id, kind,
    originalName: stored.originalName, storedName: stored.storedName, filePath: stored.filePath,
    mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, width: stored.width,
    height: stored.height, durationMs: stored.durationMs, warnings: stored.warnings || [],
    uploadedByUserId: actor.id, uploadedAt: timestamp(now), cleanedAt: null, cleanupReason: ""
  };
  if (previous) {
    const index = db.registrationSubmissionAssets.indexOf(previous);
    db.registrationSubmissionAssets.splice(index, 1);
  }
  db.registrationSubmissionAssets.push(asset);
  return { asset, previous };
}

export function removeSessionAsset({ db, session, kind }) {
  validKind(kind);
  const index = db.registrationSubmissionAssets.findIndex((asset) => (
    asset.uploadSessionId === session.id && asset.kind === kind && !asset.registrationId
  ));
  if (index < 0) throw businessError(404, "作品材料不存在", "SUBMISSION_ASSET_NOT_FOUND");
  return db.registrationSubmissionAssets.splice(index, 1)[0];
}

export function registrationAssetForRead(db, { eventId, registrationId, kind }) {
  validKind(kind);
  const registration = db.registrations.find((row) => row.id === registrationId && row.eventId === eventId);
  if (!registration) throw businessError(404, "报名记录不存在", "REGISTRATION_NOT_FOUND");
  const asset = db.registrationSubmissionAssets.find((row) => (
    row.registrationId === registration.id && row.kind === kind && !row.cleanedAt
  ));
  if (!asset) throw businessError(404, "作品材料不存在或已清理", "SUBMISSION_ASSET_NOT_FOUND");
  return { registration, asset };
}

export function authorizeRegistrationAssetRead({ db, eventId, registrationId, kind, actor, channel }) {
  const result = registrationAssetForRead(db, { eventId, registrationId, kind });
  if (channel === "personal") {
    requireOrdinaryUser(actor);
    if (result.registration.personalUserId !== actor.id) {
      throw businessError(403, "无权查看该报名材料", "REGISTRATION_ASSET_FORBIDDEN");
    }
  } else if (channel === "organization") {
    const { organization } = requireOrganizationEventParticipation(db, actor, eventId);
    if (result.registration.organizationId !== organization.id) {
      throw businessError(403, "无权查看该组织报名材料", "REGISTRATION_ASSET_FORBIDDEN");
    }
  } else if (channel !== "admin") {
    throw businessError(422, "读取渠道不合法", "SUBMISSION_CHANNEL_INVALID");
  }
  return result;
}
