import express from "express";

import { isRegistrationOpen } from "../domain/registration-window.js";

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

function selectedEvent(db, eventId) {
  if (eventId) return db.events.find((event) => event.id === eventId);
  return db.events.find((event) => event.isCurrent)
    || sortNewest(db.events.map((event) => ({ ...event, createdAt: event.updatedAt || event.createdAt })))[0];
}

function dashboardPayload(db, event, clock) {
  const registrations = db.registrations.filter((row) => row.eventId === event.id);
  const registrationIds = new Set(registrations.map((row) => row.id));
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
      )).length
    },
    recentImports: sortNewest(db.certificateImportBatches.filter((row) => row.eventId === event.id))
      .slice(0, 5)
      .map(publicImport),
    recentAuditLogs: sortNewest(db.auditLogs).slice(0, 10)
  };
}

export function createDashboardRouter({ store, requireAdmin, requirePasswordReady, asyncRoute, clock = () => new Date() }) {
  const router = express.Router();
  const admin = [requireAdmin, requirePasswordReady];

  router.get("/admin/dashboard", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const eventId = String(req.query.eventId || "").trim();
    const event = selectedEvent(db, eventId);
    if (!event) return res.status(404).json({ error: "赛事不存在" });
    res.json(dashboardPayload(db, event, clock));
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
