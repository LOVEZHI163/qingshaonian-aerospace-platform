import express from "express";

import {
  archiveEvent,
  copyEvent,
  createEvent,
  createProject,
  deleteProject,
  publicEventPayload,
  setCurrentEvent,
  updateEvent,
  updateProject
} from "../services/events.js";
import { recordAudit } from "../services/audit.js";
import { deleteArchivedEvent } from "../services/resource-cleanup.js";

export function createEventsRouter({ store, requireAdmin, requirePasswordReady, asyncRoute, makeId, clock = () => new Date() }) {
  const router = express.Router();
  const admin = [requireAdmin, requirePasswordReady];

  router.get("/admin/events", ...admin, asyncRoute(async (_req, res) => {
    const db = await store.readDb();
    res.json({ rows: db.events, projects: db.projects });
  }));

  router.post("/admin/events", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = createEvent(db, req.body, { makeId, clock });
    await store.writeDb(db);
    res.status(201).json({ row });
  }));

  router.patch("/admin/events/:id", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const previousMode = db.events.find((event) => event.id === req.params.id)?.registrationMode;
    const row = updateEvent(db, req.params.id, req.body, { clock });
    if (previousMode !== row.registrationMode) {
      const modeText = { automatic: "自动控制", force_open: "临时开放", force_closed: "临时关闭" }[row.registrationMode];
      recordAudit(db, {
        actor: req.user,
        action: "event.registration-mode",
        targetType: "event",
        targetId: row.id,
        summary: `${row.name}报名已设为${modeText}`,
        createdAt: clock().toISOString()
      });
    }
    await store.writeDb(db);
    res.json({ row });
  }));

  router.post("/admin/events/:id/copy", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const result = copyEvent(db, req.params.id, req.body, { makeId, clock });
    await store.writeDb(db);
    res.status(201).json(result);
  }));

  router.post("/admin/events/:id/current", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = setCurrentEvent(db, req.params.id, { clock });
    recordAudit(db, {
      actor: req.user,
      action: "event.publish",
      targetType: "event",
      targetId: row.id,
      summary: `${row.name}已设为当前发布赛事`,
      createdAt: clock().toISOString()
    });
    await store.writeDb(db);
    res.json({ row });
  }));

  router.post("/admin/events/:id/archive", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = archiveEvent(db, req.params.id, { clock });
    recordAudit(db, {
      actor: req.user,
      action: "event.archive",
      targetType: "event",
      targetId: row.id,
      summary: `${row.name}已归档`,
      createdAt: clock().toISOString()
    });
    await store.writeDb(db);
    res.json({ row });
  }));

  router.delete("/admin/events/:id", ...admin, asyncRoute(async (req, res) => {
    res.json(await deleteArchivedEvent({
      store,
      eventId: req.params.id,
      confirmName: req.body?.confirmName,
      actor: req.user,
      makeId,
      now: () => clock().toISOString()
    }));
  }));

  router.post("/admin/events/:eventId/projects", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = createProject(db, req.params.eventId, req.body, { makeId });
    await store.writeDb(db);
    res.status(201).json({ row });
  }));

  router.patch("/admin/projects/:id", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = updateProject(db, req.params.id, req.body);
    await store.writeDb(db);
    res.json({ row });
  }));

  router.delete("/admin/projects/:id", ...admin, asyncRoute(async (req, res) => {
    const db = await store.readDb();
    const row = deleteProject(db, req.params.id);
    await store.writeDb(db);
    res.json({ ok: true, row });
  }));

  router.get("/public/event", asyncRoute(async (_req, res) => {
    const db = await store.readDb();
    res.json(publicEventPayload(db, clock));
  }));

  return router;
}
