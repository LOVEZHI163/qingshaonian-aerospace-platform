import express from "express";

import { MAX_CERTIFICATE_ROWS } from "../certificates/workbook-parser.js";
import { buildCertificateTemplate } from "../certificates/template.js";
import { buildBoundRegistrationWorkbook, contentDisposition } from "../exports/registration-workbook.js";

import {
  findSchools,
  filterAdminRegistrations,
  listAdminRegistrations,
  prepareAdminRegistrationUpdate,
  prepareOrdinaryRegistrationUpdate,
  prepareRegistrationCreate,
  registrationDuplicateCheck,
  registrationContextPayload,
  updateRegistrationStatus
} from "../services/registrations.js";
import { recordAudit } from "../services/audit.js";

export function createRegistrationsRouter({ store, requireUser, requireAdmin, requirePasswordReady, asyncRoute, makeId, now, clock = () => new Date() }) {
  const router = express.Router();
  const user = [requireUser, requirePasswordReady];
  const admin = [requireAdmin, requirePasswordReady];

  router.get("/schools", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json({ rows: findSchools(db, req.query.q) });
  }));

  router.get("/me/registration-context", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json(registrationContextPayload(db, req.user.id));
  }));

  router.get("/admin/registrations", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json(listAdminRegistrations(db, req.query, clock));
  }));

  router.get("/admin/registrations/export.xlsx", ...admin, asyncRoute(async (req, res) => {
    const scope = req.query.scope || "filtered";
    if (!new Set(["filtered", "all"]).has(scope)) return res.status(422).json({ error: "导出范围不合法" });
    const db = await store.readDb();
    if (scope === "all" && !String(req.query.eventId || "").trim()) return res.status(422).json({ error: "导出全部名单必须选择赛事" });
    if (scope === "all" && !db.events.some((event) => event.id === req.query.eventId)) return res.status(404).json({ error: "赛事不存在" });
    const query = scope === "all" ? { eventId: req.query.eventId } : req.query;
    const workbook = buildBoundRegistrationWorkbook(filterAdminRegistrations(db, query));
    const suffix = scope === "all" ? "全部名单" : "筛选名单";
    const fileName = `报名${suffix}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", contentDisposition(fileName));
    await workbook.xlsx.write(res);
    res.end();
  }));

  router.get("/admin/events/:eventId/certificate-template.xlsx", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const event = db.events.find((item) => item.id === req.params.eventId);
    if (!event) return res.status(404).json({ error: "赛事不存在" });
    const rows = filterAdminRegistrations(db, { eventId: event.id, status: "approved" });
    if (rows.length > MAX_CERTIFICATE_ROWS) {
      const error = new Error(`证书模板最多支持 ${MAX_CERTIFICATE_ROWS.toLocaleString("en-US")} 条已审核报名`);
      error.status = 413;
      throw error;
    }
    const workbook = await buildCertificateTemplate(rows);
    const fileName = `${event.name}_证书导入模板.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", contentDisposition(fileName));
    await workbook.xlsx.write(res);
    res.end();
  }));

  router.get("/registrations", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json(listAdminRegistrations(db, req.query, clock));
  }));

  router.post("/registrations/check", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json(registrationDuplicateCheck(db, req.body));
  }));

  router.post("/registrations", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const prepared = prepareRegistrationCreate(db, req.body, req.user.id);
    const row = {
      id: makeId("R"), eventId: prepared.event.id, source: "普通用户", userId: req.user.id,
      organizationId: prepared.organization?.id || null, organization: prepared.organization?.name || "",
      athlete: prepared.athlete, athleteKey: prepared.validation.athleteKey, group: prepared.group,
      projectId: prepared.project.id, projectName: prepared.project.name, projectType: prepared.validation.projectType,
      instructor: String(req.body.instructor || "").trim(), status: "pending", rejectReason: "", createdAt: now(), updatedAt: now()
    };
    db.registrations.unshift(row);
    await store.writeDb(db);
    res.status(201).json({ row, duplicateCount: prepared.validation.duplicateCount });
  }));

  router.patch("/admin/registrations/:id", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = db.registrations.find((item) => item.id === req.params.id);
    if (!row) return res.status(404).json({ error: "报名记录不存在" });
    const prepared = prepareAdminRegistrationUpdate(db, row, req.body);
    Object.assign(row, {
      organizationId: prepared.organizationId, organization: prepared.organization?.name || "", athlete: prepared.athlete,
      athleteKey: prepared.validation.athleteKey, group: prepared.group, projectId: prepared.project.id,
      projectName: prepared.project.name, projectType: prepared.validation.projectType, instructor: prepared.instructor, updatedAt: now()
    });
    const certificate = db.certificates.find((item) => item.registrationId === row.id);
    if (certificate) {
      certificate.userId = row.userId || null;
      certificate.organizationId = row.organizationId || null;
    }
    await store.writeDb(db);
    res.json({ row });
  }));

  router.patch("/registrations/:id", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = db.registrations.find((item) => item.id === req.params.id);
    if (!row) return res.status(404).json({ error: "报名记录不存在" });
    const prepared = prepareOrdinaryRegistrationUpdate(db, row, req.body, req.user.id);
    Object.assign(row, {
      organizationId: prepared.organizationId, organization: prepared.organization?.name || "", athlete: prepared.athlete,
      athleteKey: prepared.validation.athleteKey, group: prepared.group, projectId: prepared.project.id,
      projectName: prepared.project.name, projectType: prepared.validation.projectType, instructor: prepared.instructor, updatedAt: now()
    });
    const certificate = db.certificates.find((item) => item.registrationId === row.id);
    if (certificate) certificate.organizationId = row.organizationId || null;
    await store.writeDb(db);
    res.json({ row });
  }));

  router.patch("/registrations/:id/status", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = db.registrations.find((item) => item.id === req.params.id);
    if (!row) return res.status(404).json({ error: "报名记录不存在" });
    updateRegistrationStatus(db, row, req.body, req.user);
    row.updatedAt = now();
    if (req.user.type === "admin" && ["approved", "rejected"].includes(row.status)) {
      recordAudit(db, {
        actor: req.user,
        action: "registration.review",
        targetType: "registration",
        targetId: row.id,
        summary: `${row.athlete?.name || row.id}的${row.projectName}报名审核为${row.status === "approved" ? "通过" : "驳回"}`,
        createdAt: now()
      });
    }
    await store.writeDb(db);
    res.json({ row });
  }));

  return router;
}
