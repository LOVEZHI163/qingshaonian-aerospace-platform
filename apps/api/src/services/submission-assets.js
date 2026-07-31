import { isRegistrationOpen } from "../domain/registration-window.js";
import { businessError } from "./events.js";
import { requireOrganizationEventParticipation, requireOrdinaryUser, requireWritableEvent } from "./access-control.js";
import { recordAudit } from "./audit.js";

export const SUBMISSION_ASSET_KINDS = new Set(["artwork_image", "creation_video"]);
const SUBMISSION_ASSET_LABELS = {
  artwork_image: "作品图片",
  creation_video: "作画视频"
};
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

function registrationAssetSummary(asset) {
  if (!asset) return null;
  const { id: _id, ...summary } = submissionAssetSummary(asset);
  return summary;
}

function replacementAuditMetadata(asset) {
  return JSON.stringify({
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    width: asset.width ?? null,
    height: asset.height ?? null,
    durationMs: asset.durationMs ?? null,
    uploadedAt: asset.uploadedAt
  });
}

export function registrationSubmissionSummary(db, registration) {
  const project = db.projects.find((row) => row.id === registration.projectId && row.eventId === registration.eventId);
  if (project?.submissionMode !== "image_video") return null;
  const byKind = new Map(
    db.registrationSubmissionAssets
      .filter((asset) => asset.registrationId === registration.id)
      .map((asset) => [asset.kind, asset])
  );
  const assets = {
    artwork_image: registrationAssetSummary(byKind.get("artwork_image")),
    creation_video: registrationAssetSummary(byKind.get("creation_video"))
  };
  const complete = [...SUBMISSION_ASSET_KINDS].every((kind) => assets[kind] && !assets[kind].cleanedAt);
  const warnings = [...new Set(Object.values(assets).flatMap((asset) => asset?.warnings || []))];
  return { required: true, complete, warnings, assets };
}

export function withRegistrationSubmission(db, registration) {
  const submission = registrationSubmissionSummary(db, registration);
  return submission ? { ...registration, submission } : registration;
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
  } else if (channel === "admin") {
    if (actor?.type !== "admin") {
      throw businessError(403, "仅平台管理员可创建管理员作品上传会话", "UPLOAD_SESSION_FORBIDDEN");
    }
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
  } else if (channel === "admin") {
    if (actor?.type !== "admin" || session.organizationId) {
      throw businessError(403, "无权访问该管理员上传会话", "UPLOAD_SESSION_FORBIDDEN");
    }
  } else {
    throw businessError(422, "上传渠道不合法", "SUBMISSION_CHANNEL_INVALID");
  }
  eventProject(db, session.eventId, session.projectId);
  if (session.state !== "active") throw businessError(409, "上传会话已提交或不可用", "UPLOAD_SESSION_NOT_ACTIVE");
  if (sessionIsExpired(session, now)) throw businessError(409, "上传会话已过期", "UPLOAD_SESSION_EXPIRED");
  return session;
}

export function commitUploadSession({ db, sessionId, registration, actor, channel, now }) {
  const session = db.registrationUploadSessions.find((row) => row.id === sessionId);
  if (!session) throw businessError(422, "请先创建上传会话", "UPLOAD_SESSION_REQUIRED");
  if (session.ownerUserId !== actor?.id) {
    throw businessError(403, "无权使用该上传会话", "UPLOAD_SESSION_FORBIDDEN");
  }
  if (channel === "personal") {
    requireOrdinaryUser(actor);
    if (session.organizationId || registration.personalUserId !== actor.id) {
      throw businessError(403, "上传会话与个人报名不匹配", "UPLOAD_SESSION_FORBIDDEN");
    }
  } else if (channel === "organization") {
    const { organization } = requireOrganizationEventParticipation(db, actor, session.eventId, { writable: true });
    if (session.organizationId !== organization.id || registration.organizationId !== organization.id) {
      throw businessError(403, "上传会话与组织报名不匹配", "UPLOAD_SESSION_FORBIDDEN");
    }
  } else {
    throw businessError(422, "报名渠道不合法", "SUBMISSION_CHANNEL_INVALID");
  }
  if (session.eventId !== registration.eventId || session.projectId !== registration.projectId) {
    throw businessError(422, "上传会话与报名赛项不匹配", "UPLOAD_SESSION_SCOPE_MISMATCH");
  }
  if (session.state !== "active") {
    throw businessError(409, "上传会话已提交或不可用", "UPLOAD_SESSION_NOT_ACTIVE");
  }
  if (sessionIsExpired(session, now)) {
    throw businessError(409, "上传会话已过期", "UPLOAD_SESSION_EXPIRED");
  }
  if (db.registrationSubmissionAssets.some((asset) => (
    asset.registrationId === registration.id && SUBMISSION_ASSET_KINDS.has(asset.kind)
  ))) {
    throw businessError(409, "该报名已绑定作品材料，不能重复提交上传会话", "REGISTRATION_SUBMISSION_ALREADY_BOUND");
  }
  const assets = db.registrationSubmissionAssets.filter((asset) => (
    asset.uploadSessionId === session.id && !asset.registrationId && !asset.cleanedAt
  ));
  const byKind = new Map(assets.map((asset) => [asset.kind, asset]));
  const missing = [...SUBMISSION_ASSET_KINDS].filter((kind) => !byKind.has(kind));
  if (missing.length) {
    throw businessError(422, `缺少必传作品材料：${missing.map((kind) => SUBMISSION_ASSET_LABELS[kind]).join("、")}`, "SUBMISSION_ASSETS_INCOMPLETE");
  }
  for (const kind of SUBMISSION_ASSET_KINDS) byKind.get(kind).registrationId = registration.id;
  session.state = "committed";
  session.committedAt = timestamp(now);
  return session;
}

export function replacementSessionAsset({ db, sessionId, registration, kind, actor, channel, now }) {
  validKind(kind);
  let session;
  if (channel === "admin") {
    session = db.registrationUploadSessions.find((row) => row.id === sessionId);
    if (!session) throw businessError(404, "上传会话不存在", "UPLOAD_SESSION_NOT_FOUND");
    eventProject(db, session.eventId, session.projectId);
    if (session.state !== "active") throw businessError(409, "上传会话已提交或不可用", "UPLOAD_SESSION_NOT_ACTIVE");
    if (sessionIsExpired(session, now)) throw businessError(409, "上传会话已过期", "UPLOAD_SESSION_EXPIRED");
  } else {
    session = requireUploadSessionAccess({ db, sessionId, actor, channel, now, kind });
  }
  if (session.eventId !== registration.eventId || session.projectId !== registration.projectId) {
    throw businessError(422, "上传会话与报名赛项不匹配", "UPLOAD_SESSION_SCOPE_MISMATCH");
  }
  const asset = db.registrationSubmissionAssets.find((row) => (
    row.uploadSessionId === session.id && row.kind === kind && !row.registrationId && !row.cleanedAt
  ));
  if (!asset) throw businessError(422, "上传会话缺少待替换的作品材料", "SUBMISSION_REPLACEMENT_ASSET_MISSING");
  return { session, asset };
}

export function replaceRegistrationAsset({ db, registration, kind, uploadedAsset, actor, channel, now }) {
  validKind(kind);
  const current = db.registrationSubmissionAssets.find((asset) => (
    asset.registrationId === registration.id && asset.kind === kind
  ));
  if (!current) throw businessError(404, "报名作品材料不存在", "SUBMISSION_ASSET_NOT_FOUND");
  if (!uploadedAsset || uploadedAsset.kind !== kind || uploadedAsset.registrationId || uploadedAsset.cleanedAt) {
    throw businessError(422, "替换作品材料无效", "SUBMISSION_REPLACEMENT_ASSET_INVALID");
  }
  if (!db.registrationSubmissionAssets.includes(uploadedAsset)) {
    throw businessError(422, "替换作品材料不存在", "SUBMISSION_REPLACEMENT_ASSET_INVALID");
  }

  if (channel === "personal") {
    requireOrdinaryUser(actor);
    if (registration.personalUserId !== actor.id) {
      throw businessError(403, "无权替换该报名作品材料", "REGISTRATION_ASSET_FORBIDDEN");
    }
    if (!new Set(["pending", "rejected"]).has(registration.status)) {
      throw businessError(403, "已通过报名不可由个人替换作品材料", "REGISTRATION_ASSET_APPROVED_READONLY");
    }
  } else if (channel === "organization") {
    const { organization } = requireOrganizationEventParticipation(db, actor, registration.eventId, { writable: true });
    if (registration.organizationId !== organization.id) {
      throw businessError(403, "无权替换其他组织的报名作品材料", "REGISTRATION_ASSET_FORBIDDEN");
    }
  } else if (channel !== "admin") {
    throw businessError(422, "替换渠道不合法", "SUBMISSION_CHANNEL_INVALID");
  }

  const timestampValue = timestamp(now);
  const previous = structuredClone(current);
  const sourceIndex = db.registrationSubmissionAssets.indexOf(uploadedAsset);
  const registrationBefore = { status: registration.status, rejectReason: registration.rejectReason, updatedAt: registration.updatedAt };
  Object.assign(current, {
    originalName: uploadedAsset.originalName,
    storedName: uploadedAsset.storedName,
    filePath: uploadedAsset.filePath,
    mimeType: uploadedAsset.mimeType,
    sizeBytes: uploadedAsset.sizeBytes,
    width: uploadedAsset.width,
    height: uploadedAsset.height,
    durationMs: uploadedAsset.durationMs,
    warnings: [...(uploadedAsset.warnings || [])],
    uploadedByUserId: actor.id,
    uploadedAt: timestampValue,
    cleanedAt: null,
    cleanupReason: ""
  });
  db.registrationSubmissionAssets.splice(sourceIndex, 1);
  if ((channel === "organization" || channel === "admin") && registration.status === "approved") {
    registration.status = "pending";
    registration.rejectReason = "";
    registration.updatedAt = timestampValue;
  }
  recordAudit(db, {
    actor,
    action: "registration.asset.replace",
    targetType: "registration",
    targetId: registration.id,
    summary: `替换报名 ${registration.id} 的 ${kind} 作品材料；旧素材元数据：${replacementAuditMetadata(previous)}`,
    createdAt: timestampValue
  });
  return {
    asset: current,
    previous,
    rollback() {
      Object.assign(current, previous);
      db.registrationSubmissionAssets.splice(sourceIndex, 0, uploadedAsset);
      Object.assign(registration, registrationBefore);
      const audit = db.auditLogs.find((row) => (
        row.targetId === registration.id && row.action === "registration.asset.replace" && row.createdAt === timestampValue
      ));
      if (audit) db.auditLogs.splice(db.auditLogs.indexOf(audit), 1);
    }
  };
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
