import { recordAudit } from "./audit.js";
import { publishContent } from "./site-admin.js";

function asTimestamp(clock) {
  const value = new Date(typeof clock === "function" ? clock() : clock);
  if (!Number.isFinite(value.getTime())) throw new TypeError("clock must return a valid date");
  return value.toISOString();
}

function isDue(post, timestamp) {
  return post?.status === "scheduled"
    && Number.isFinite(Date.parse(post.publishAt))
    && Date.parse(post.publishAt) <= Date.parse(timestamp);
}

function recordPublicationAudit(db, row, timestamp) {
  if (row.eventId && !(db.auditLogs || []).some(
    (audit) => audit.action === "event.content-published" && audit.targetId === row.eventId
  )) {
    recordAudit(db, {
      actor: null,
      action: "event.content-published",
      targetType: "event",
      targetId: row.eventId,
      summary: `赛事已有内容发布：${row.title}`,
      createdAt: timestamp
    });
  }
  recordAudit(db, {
    actor: null,
    action: "content.publish",
    targetType: "content",
    targetId: row.id,
    summary: `定时发布内容：${row.title}`,
    createdAt: timestamp
  });
}

export async function publishDueScheduledContent({ store, clock = () => new Date() }) {
  return store.withMutationLock(async () => {
    const timestamp = asTimestamp(clock);
    let working = structuredClone(await store.readDb());
    const dueIds = (working.contentPosts || []).filter((row) => isDue(row, timestamp)).map((row) => row.id);
    const publishedIds = [];
    const failures = [];

    for (const contentId of dueIds) {
      const candidate = structuredClone(working);
      const current = (candidate.contentPosts || []).find((row) => row.id === contentId);
      try {
        const row = publishContent(candidate, contentId, { version: current.version }, {
          now: timestamp,
          incrementVersion: store.kind !== "postgres"
        });
        recordPublicationAudit(candidate, row, timestamp);
        working = candidate;
        publishedIds.push(contentId);
      } catch (error) {
        failures.push({ contentId, code: error.code || null, message: error.message });
      }
    }

    if (publishedIds.length > 0) await store.writeDb(working);
    return { publishedIds, failures };
  });
}

export function startScheduledContentPublisher({
  store,
  clock = () => new Date(),
  intervalMs = 30_000,
  onError = (error) => console.error("Scheduled content publishing failed", error)
}) {
  const run = () => publishDueScheduledContent({ store, clock }).catch(onError);
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
  return () => clearInterval(timer);
}
