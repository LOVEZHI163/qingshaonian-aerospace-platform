import express from "express";

import { isRegistrationOpen } from "../domain/registration-window.js";
import { requireEventId } from "../services/registrations.js";
import { readStorageStatus } from "../services/system-storage.js";

function positiveInteger(value, fallback, name, maximum) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    const error = new Error(`${name} 参数无效`);
    error.status = 422;
    throw error;
  }
  return number;
}
function sortNewest(rows) {
  return [...rows].sort((left, right) => (
    String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
    || String(right.id || "").localeCompare(String(left.id || ""))
  ));
}

function publicImport(batch) {
  return {
    id: batch.id,
    eventId: batch.eventId,
    originalName: batch.originalName,
    status: batch.status,
    validCount: batch.validCount,
    errorCount: batch.errorCount,
    replaceCount: batch.replaceCount,
    createdAt: batch.createdAt,
    committedAt: batch.committedAt
  };
}

function dashboardPayload(db, event, clock) {
  const registrations = db.registrations.filter((row) => row.eventId === event.id);
  const registrationIds = new Set(registrations.map((row) => row.id));
  const submissionAssets = (db.registrationSubmissionAssets || []).filter((row) => (
    registrationIds.has(row.registrationId) && !row.cleanedAt
  ));
  return {
    event,
    events: sortNewest(db.events).map(({ id, name, status, isCurrent, createdAt, updatedAt }) => ({
      id, name, status, isCurrent, createdAt, updatedAt
    })),
    registrationWindow: isRegistrationOpen(event, clock()),
    counts: {
      registrations: registrations.length,
      pendingRegistrations: registrations.filter((row) => row.status === "pending").length,
      pendingOrganizations: db.organizations.filter((row) => row.reviewStatus === "pending").length,
      draftCertificates: db.certificates.filter((row) => (
        registrationIds.has(row.registrationId) && row.status === "draft" && !row.cleanedAt
      )).length,
      artworkImages: submissionAssets.filter((row) => row.kind === "artwork_image").length,
      creationVideos: submissionAssets.filter((row) => row.kind === "creation_video").length
    },
    submissionStorage: {
      totalFiles: submissionAssets.length,
      totalBytes: submissionAssets.reduce((sum, row) => sum + Number(row.sizeBytes || 0), 0),
      artworkImages: {
        count: submissionAssets.filter((row) => row.kind === "artwork_image").length,
        bytes: submissionAssets.filter((row) => row.kind === "artwork_image").reduce((sum, row) => sum + Number(row.sizeBytes || 0), 0)
      },
      creationVideos: {
        count: submissionAssets.filter((row) => row.kind === "creation_video").length,
        bytes: submissionAssets.filter((row) => row.kind === "creation_video").reduce((sum, row) => sum + Number(row.sizeBytes || 0), 0)
      }
    },
    recentImports: sortNewest(db.certificateImportBatches.filter((row) => row.eventId === event.id))
      .slice(0, 5)
      .map(publicImport),
    recentAuditLogs: sortNewest(db.auditLogs).slice(0, 10)
  };
}

export function createDashboardRouter({
  store, requireAdmin, requirePasswordReady, asyncRoute, clock = () => new Date(),
  uploadRoot = process.env.UPLOAD_ROOT || "/data/uploads", storageStatus = readStorageStatus
}) {
  const router = express.Router();
  const admin = [requireAdmin, requirePasswordReady];

  router.get("/admin/dashboard", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const event = requireEventId(db, req.query.eventId);
    const payload = dashboardPayload(db, event, clock);
    try {
      payload.serverStorage = { available: true, ...(await storageStatus({ uploadRoot })) };
    } catch (error) {
      payload.serverStorage = { available: false, error: "暂时无法读取服务器磁盘状态" };
    }
    res.json(payload);
  }));

  router.get("/admin/audit-logs", ...admin, asyncRoute(async (req, res) => {
    const pageSize = positiveInteger(req.query.pageSize, 50, "pageSize", 100);
    const requestedPage = positiveInteger(req.query.page, 1, "page", Number.MAX_SAFE_INTEGER);
    const action = String(req.query.action || "").trim();
    const targetType = String(req.query.targetType || "").trim();
    const targetId = String(req.query.targetId || "").trim();
    const db = await store.readDb();
    const filtered = sortNewest(db.auditLogs).filter((row) => (
      (!action || row.action === action)
      && (!targetType || row.targetType === targetType)
      && (!targetId || row.targetId === targetId)
    ));
    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, pageCount);
    res.json({ total, page, pageSize, rows: filtered.slice((page - 1) * pageSize, page * pageSize) });
  }));

  return router;
}
