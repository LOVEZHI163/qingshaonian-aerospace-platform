import express from "express";

import { listAccountEvents, joinOrganizationEvent } from "../services/account-events.js";
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

  return router;
}
