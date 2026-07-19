import { recordAudit } from "./audit.js";

const PUBLICATION_ACTION = "event.profile-public";

export function isEventProfilePublic(db, eventId) {
  const event = (db.events || []).find((row) => row.id === eventId);
  const profile = (db.eventPublicProfiles || []).find((row) => row.eventId === eventId);
  return profile?.isVisible === true && ["published", "archived"].includes(event?.status);
}

export function eventProfileSlugIsLocked(db, eventId) {
  return isEventProfilePublic(db, eventId)
    || (db.auditLogs || []).some((row) => row.action === PUBLICATION_ACTION && row.targetId === eventId);
}

export function recordEventProfilePublication(db, eventId, { actor, createdAt } = {}) {
  if (!isEventProfilePublic(db, eventId)) return false;
  if ((db.auditLogs || []).some((row) => row.action === PUBLICATION_ACTION && row.targetId === eventId)) return false;
  const event = (db.events || []).find((row) => row.id === eventId);
  recordAudit(db, {
    actor,
    action: PUBLICATION_ACTION,
    targetType: "event",
    targetId: eventId,
    summary: `赛事公开地址已生效：${event?.name || eventId}`,
    createdAt
  });
  return true;
}
