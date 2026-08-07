import { isRegistrationOpen } from "../domain/registration-window.js";
import { deleteSubmissionFile, submissionFileExists } from "../files/submission-storage.js";
import path from "node:path";
import { businessError } from "./events.js";
import { requireOrganizationEventParticipation, requireOrdinaryRegistrationEligibility, requireOrdinaryUser, requireWritableEvent } from "./access-control.js";
import { recordAudit } from "./audit.js";

export const SUBMISSION_ASSET_KINDS = new Set(["artwork_image", "creation_video"]);
const SUBMISSION_ASSET_LABELS = {
  artwork_image: "作品图片",
  creation_video: "作画视频"
};
const SESSION_TTL_MS = Number(process.env.SUBMISSION_SESSION_TTL_MS || 86_400_000);
const SAFE_ASSET_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_STORED_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

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

function isControlledTemporaryAsset(asset, uploadRoot) {
  if (!asset || !SAFE_ASSET_COMPONENT.test(String(asset.id || "")) || !SAFE_STORED_FILE.test(String(asset.storedName || ""))) {
    return false;
  }
  const expected = path.resolve(uploadRoot, "submission-assets", asset.id, asset.storedName);
  return path.resolve(String(asset.filePath || "")) === expected;
}

function pendingCleanupMarker({ asset, makeId, now }) {
  const createdAt = timestamp(now);
  return {
    id: makeId("CLN"),
    filePath: asset.filePath,
    category: "submission-session-expired",
    attempts: 1,
    lastError: "pending cleanup",
    createdAt,
    lastAttemptAt: createdAt
  };
}

export async function cleanupExpiredSubmissionSessions({
  store,
  now = () => new Date().toISOString(),
  makeId = (prefix) => `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`,
  uploadRoot = process.env.UPLOAD_ROOT || "/data/uploads",
  deleteFile = deleteSubmissionFile,
  logger = console
}) {
  const run = async () => {
    const originalDb = await store.readDb();
    const expiredSessionIds = new Set(
      (originalDb.registrationUploadSessions || [])
        .filter((session) => session.state === "active" && sessionIsExpired(session, now))
        .map((session) => session.id)
    );
    if (!expiredSessionIds.size) return { expiredSessionIds: [], removedAssetIds: [], journaledAssetIds: [] };

    const db = structuredClone(originalDb);
    const removableAssets = (db.registrationSubmissionAssets || []).filter((asset) => (
      expiredSessionIds.has(asset.uploadSessionId)
      && !asset.registrationId
      && isControlledTemporaryAsset(asset, uploadRoot)
    ));
    const removableAssetIds = new Set(removableAssets.map((asset) => asset.id));
    for (const session of db.registrationUploadSessions) {
      if (expiredSessionIds.has(session.id) && session.state === "active") session.state = "expired";
    }
    db.registrationSubmissionAssets = (db.registrationSubmissionAssets || []).filter((asset) => !removableAssetIds.has(asset.id));
    db.fileCleanupJournal ||= [];
    const sessionById = new Map(db.registrationUploadSessions.map((session) => [session.id, session]));
    for (const asset of removableAssets) {
      const session = sessionById.get(asset.uploadSessionId);
      recordSubmissionAssetAudit(db, {
        actor: null,
        action: "registration_asset_cleanup",
        eventId: session?.eventId || null,
        organizationId: session?.organizationId || null,
        registrationId: null,
        sessionId: asset.uploadSessionId,
        asset,
        assetKind: asset.kind,
        cleanupCategory: "submission-session-expired",
        createdAt: timestamp(now)
      });
    }
    const removablePaths = new Set(removableAssets.map((asset) => asset.filePath));
    const pendingMarkersByPath = new Map();
    db.fileCleanupJournal = db.fileCleanupJournal.filter((marker) => {
      if (marker.category !== "submission-session-expired" || !removablePaths.has(marker.filePath)) return true;
      if (pendingMarkersByPath.has(marker.filePath)) return false;
      pendingMarkersByPath.set(marker.filePath, marker);
      return true;
    });
    const markerByAssetId = new Map();
    for (const asset of removableAssets) {
      let marker = pendingMarkersByPath.get(asset.filePath);
      if (!marker) {
        marker = pendingCleanupMarker({ asset, makeId, now });
        db.fileCleanupJournal.push(marker);
        pendingMarkersByPath.set(asset.filePath, marker);
      }
      markerByAssetId.set(asset.id, marker);
    }

    // Persist both expiry and the retry marker before touching the filesystem. A
    // crash or later write failure can then leave only a replayable marker, never
    // an untracked physical orphan.
    await store.writeDb(db);

    const completedMarkerPaths = new Set();
    const failedAssetIds = [];
    for (const asset of removableAssets) {
      try {
        await deleteFile(asset, { uploadRoot });
        completedMarkerPaths.add(markerByAssetId.get(asset.id).filePath);
      } catch (error) {
        if (error?.code === "ENOENT") completedMarkerPaths.add(markerByAssetId.get(asset.id).filePath);
        else failedAssetIds.push(asset.id);
      }
    }
    if (completedMarkerPaths.size) {
      const finalizedDb = structuredClone(db);
      finalizedDb.fileCleanupJournal = finalizedDb.fileCleanupJournal.filter((marker) => (
        marker.category !== "submission-session-expired" || !completedMarkerPaths.has(marker.filePath)
      ));
      try {
        await store.writeDb(finalizedDb);
      } catch {
        try { logger?.error?.("Submission-session expiry marker removal persistence failed", { completedFileCount: completedMarkerPaths.size }); } catch { /* a durable marker remains for generic replay */ }
      }
    }
    return {
      expiredSessionIds: [...expiredSessionIds],
      removedAssetIds: [...removableAssetIds],
      journaledAssetIds: failedAssetIds
    };
  };
  return store.withMutationLock ? store.withMutationLock(run) : run();
}

export function startSubmissionSessionExpiryCleanup({
  store,
  intervalMs = Number(process.env.SUBMISSION_SESSION_CLEANUP_INTERVAL_MS || 60 * 60 * 1000),
  cleanup = cleanupExpiredSubmissionSessions,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console
}) {
  let activeCleanup = null;
  const run = () => {
    if (activeCleanup) return activeCleanup;
    activeCleanup = Promise.resolve(cleanup({ store }))
      .catch(() => {
        try { logger?.error?.("Submission-session expiry cleanup failed"); } catch { /* cleanup errors must not stop the API */ }
      })
      .finally(() => { activeCleanup = null; });
    return activeCleanup;
  };
  void run();
  const timer = setIntervalFn(run, intervalMs);
  timer?.unref?.();
  return () => clearIntervalFn(timer);
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

function safeAuditAsset(asset) {
  if (!asset) return null;
  return {
    assetId: asset.id,
    assetKind: asset.kind,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes
  };
}

export function recordSubmissionAssetAudit(db, {
  actor,
  action,
  eventId,
  organizationId = null,
  registrationId = null,
  sessionId = null,
  asset = null,
  assetKind = asset?.kind || null,
  channel = null,
  access = null,
  rangeStart = null,
  cleanupCategory = null,
  previousAsset = null,
  previousStatus = null,
  nextStatus = null,
  createdAt
}) {
  const targetId = registrationId || asset?.id || sessionId;
  const summary = {
    eventId,
    organizationId,
    registrationId,
    uploadBatchId: sessionId,
    asset: safeAuditAsset(asset),
    channel,
    access,
    rangeStart,
    cleanupCategory,
    previousAsset: safeAuditAsset(previousAsset),
    previousStatus,
    nextStatus
  };
  for (const [key, value] of Object.entries(summary)) if (value === null || value === undefined) delete summary[key];
  return recordAudit(db, {
    actor,
    action,
    targetType: registrationId ? "registration" : asset ? "registration_submission_asset" : "registration_upload_session",
    targetId,
    summary: JSON.stringify(summary),
    createdAt
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

export async function registrationSubmissionAvailability(db, registration, { fileExists = submissionFileExists } = {}) {
  const submission = registrationSubmissionSummary(db, registration);
  if (!submission) return null;
  const records = new Map(
    db.registrationSubmissionAssets
      .filter((asset) => asset.registrationId === registration.id)
      .map((asset) => [asset.kind, asset])
  );
  const missingKinds = [];
  for (const kind of SUBMISSION_ASSET_KINDS) {
    const asset = records.get(kind);
    if (!asset || (!asset.cleanedAt && !(await fileExists(asset)))) missingKinds.push(kind);
  }
  return { ...submission, complete: submission.complete && missingKinds.length === 0, missingKinds };
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
    requireOrdinaryRegistrationEligibility(db, actor.id, { requireApprovedLeader: false });
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
    channel, state: "active", createdAt, expiresAt, committedAt: null
  };
  db.registrationUploadSessions.push(session);
  return session;
}

export function requireUploadSessionAccess({ db, sessionId, actor, channel, now, kind = null }) {
  if (kind !== null) validKind(kind);
  const session = db.registrationUploadSessions.find((row) => row.id === sessionId);
  if (!session) throw businessError(404, "上传会话不存在", "UPLOAD_SESSION_NOT_FOUND");
  if (session.ownerUserId !== actor?.id) throw businessError(403, "无权访问该上传会话", "UPLOAD_SESSION_FORBIDDEN");
  const sessionChannel = session.channel || (session.organizationId ? "organization" : "personal");
  if (channel === "personal") {
    requireOrdinaryUser(actor);
    if (sessionChannel !== "personal" || session.organizationId) throw businessError(403, "该上传会话不属于个人报名", "UPLOAD_SESSION_FORBIDDEN");
  } else if (channel === "organization") {
    const { organization } = requireOrganizationEventParticipation(db, actor, session.eventId, { writable: true });
    if (sessionChannel !== "organization" || session.organizationId !== organization.id) throw businessError(403, "无权访问该组织上传会话", "UPLOAD_SESSION_FORBIDDEN");
  } else if (channel === "admin") {
    if (actor?.type !== "admin" || session.ownerUserId !== actor.id || session.channel !== "admin" || session.organizationId) {
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
    if (actor?.type !== "admin" || session.ownerUserId !== actor.id || session.channel !== "admin" || session.organizationId) {
      throw businessError(403, "无权使用该管理员上传会话", "UPLOAD_SESSION_FORBIDDEN");
    }
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
  const reviewWasReset = (channel === "organization" || channel === "admin") && registration.status === "approved";
  if (reviewWasReset) {
    registration.status = "pending";
    registration.rejectReason = "";
    registration.updatedAt = timestampValue;
  }
  const auditRows = [
    recordSubmissionAssetAudit(db, {
      actor, action: "registration_asset_replace", eventId: registration.eventId, registrationId: registration.id,
      organizationId: registration.organizationId || null,
      sessionId: uploadedAsset.uploadSessionId, asset: current, assetKind: kind, channel,
      previousAsset: previous, createdAt: timestampValue
    }),
    recordSubmissionAssetAudit(db, {
      actor, action: "registration_asset_cleanup", eventId: registration.eventId, registrationId: registration.id,
      organizationId: registration.organizationId || null,
      sessionId: previous.uploadSessionId, asset: previous, assetKind: kind, channel,
      cleanupCategory: "registration-asset-replaced", createdAt: timestampValue
    })
  ];
  if (reviewWasReset) {
    auditRows.push(recordSubmissionAssetAudit(db, {
      actor,
      action: "registration_review_reset_after_asset_replace",
      eventId: registration.eventId,
      organizationId: registration.organizationId || null,
      registrationId: registration.id,
      sessionId: uploadedAsset.uploadSessionId,
      asset: current,
      assetKind: kind,
      channel,
      previousStatus: registrationBefore.status,
      nextStatus: registration.status,
      createdAt: timestampValue
    }));
  }
  return {
    asset: current,
    previous,
    rollback() {
      Object.assign(current, previous);
      db.registrationSubmissionAssets.splice(sourceIndex, 0, uploadedAsset);
      Object.assign(registration, registrationBefore);
      for (const audit of auditRows) {
        const index = db.auditLogs.indexOf(audit);
        if (index >= 0) db.auditLogs.splice(index, 1);
      }
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
