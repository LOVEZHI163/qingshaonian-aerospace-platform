function at(clock) {
  return new Date(typeof clock === "function" ? clock() : clock);
}

function isRegistrationOpen(event, now) {
  if (event.registrationMode === "force_open") return true;
  if (event.registrationMode === "force_closed") return false;
  const start = Date.parse(event.registrationStartAt);
  const end = Date.parse(event.registrationEndAt);
  return Number.isFinite(start) && Number.isFinite(end) && start <= now.getTime() && now.getTime() <= end;
}

function compareActive(left, right) {
  return Date.parse(left.event.registrationEndAt) - Date.parse(right.event.registrationEndAt)
    || left.profile.displayOrder - right.profile.displayOrder
    || String(left.event.id).localeCompare(String(right.event.id));
}

function compareHistory(left, right) {
  return Date.parse(right.event.registrationEndAt) - Date.parse(left.event.registrationEndAt)
    || String(left.event.id).localeCompare(String(right.event.id));
}

export function selectHomeEvents(db, clock) {
  const now = at(clock);
  const profiles = new Map((db.eventPublicProfiles || []).map((profile) => [profile.eventId, profile]));
  const rows = (db.events || []).map((event) => ({ event, profile: profiles.get(event.id) }));
  const displayable = rows.filter(({ event, profile }) =>
    profile?.isVisible === true && event.status === "published" && !event.archivedAt
  );
  const active = displayable.filter(({ event }) => isRegistrationOpen(event, now)).sort(compareActive);
  const manual = displayable.find(({ event }) => event.id === db.siteSettings?.featuredEventId);

  if (manual || active.length > 0) {
    const featured = manual || active[0];
    return {
      featuredEvent: featured.event,
      concurrentEvents: active.filter((row) => row !== featured).slice(0, 2).map(({ event }) => event),
      fallbackEvent: null,
      mode: "active"
    };
  }

  const history = rows.filter(({ event, profile }) => {
    const endedAt = Date.parse(event.registrationEndAt);
    return Number.isFinite(endedAt)
      && endedAt < now.getTime()
      && (profile?.isVisible === true || event.status === "archived" || Boolean(event.archivedAt));
  }).sort(compareHistory)[0];

  return {
    featuredEvent: null,
    concurrentEvents: [],
    fallbackEvent: history?.event || null,
    mode: "history"
  };
}
