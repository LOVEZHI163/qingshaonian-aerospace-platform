import express from "express";

import { GRADE_GROUPS } from "../domain/grades.js";
import { buildBoundRegistrationWorkbook, contentDisposition } from "../exports/registration-workbook.js";
import { listAccountEvents, joinOrganizationEvent } from "../services/account-events.js";
import { requireOrganizationEventParticipation } from "../services/access-control.js";
import { recordAudit } from "../services/audit.js";

export function createAccountEventsRouter({ store, requireUser, requirePasswordReady, asyncRoute, now, clock = () => new Date() }) {
  const router = express.Router();
  const user = [requireUser, requirePasswordReady];

  router.get("/me/events", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    res.json(listAccountEvents(db, req.user, clock));
  }));

  router.post("/organization/events/:eventId/join", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const result = joinOrganizationEvent(db, req.user, req.params.eventId, now);
    if (result.created) {
      const event = db.events.find((row) => row.id === result.row.eventId);
      recordAudit(db, {
        actor: req.user,
        action: "organization.event.join",
        targetType: "event",
        targetId: result.row.eventId,
        summary: `${event.name}已加入赛事`,
        createdAt: result.row.joinedAt
      });
      await store.writeDb(db);
    }
    res.status(result.created ? 201 : 200).json({ row: result.row });
  }));

  router.get("/organization/events/:eventId/workspace", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const { organization, event } = requireOrganizationEventParticipation(db, req.user, req.params.eventId);
    const registrations = db.registrations.filter((row) => row.organizationId === organization.id && row.eventId === event.id);
    res.json({
      event,
      organization: { id: organization.id, name: organization.name },
      summary: {
        registrationCount: registrations.length,
        pendingRegistrationCount: registrations.filter((row) => row.status === "pending").length,
        certificateCount: db.certificates.filter((certificate) => registrations.some((row) => row.id === certificate.registrationId)).length
      },
      registrations,
      projects: db.projects.filter((project) => project.eventId === event.id && project.enabled),
      grades: GRADE_GROUPS
    });
  }));

  router.get("/organization/events/:eventId/export", ...user, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const { organization, event } = requireOrganizationEventParticipation(db, req.user, req.params.eventId);
    const registrations = db.registrations.filter((row) => row.organizationId === organization.id && row.eventId === event.id);
    const workbook = buildBoundRegistrationWorkbook(registrations);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", contentDisposition(`${event.name}_${organization.name}_报名名单.xlsx`));
    await workbook.xlsx.write(res);
    res.end();
  }));

  return router;
}
