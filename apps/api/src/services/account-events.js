import { isRegistrationOpen } from "../domain/registration-window.js";
import { businessError } from "./events.js";
import { requireOrganizationOwner } from "./access-control.js";

function registrationState(event, clock) {
  const now = clock().getTime();
  if (event.registrationMode === "force_open") return "open";
  if (event.registrationMode === "force_closed") return "closed";
  if (now < Date.parse(event.registrationStartAt)) return "not_started";
  return isRegistrationOpen(event, clock()).open ? "open" : "closed";
}

export function organizationEventSummary(db, organizationId, eventId) {
  const registrations = db.registrations.filter((row) => (
    row.organizationId === organizationId && row.eventId === eventId
  ));
  const registrationIds = new Set(registrations.map((row) => row.id));
  return {
    registrationCount: registrations.length,
    pendingRegistrationCount: registrations.filter((row) => row.status === "pending").length,
    certificateCount: db.certificates.filter((row) => registrationIds.has(row.registrationId)).length
  };
}

function ordinaryOrganizations(db, userId, eventId) {
  return db.memberships
    .filter((membership) => membership.userId === userId && membership.status === "active")
    .filter((membership) => membership.role === "member")
    .map((membership) => db.organizations.find((organization) => organization.id === membership.organizationId))
    .filter(Boolean)
    .map((organization) => ({
      organization: { id: organization.id, name: organization.name, code: organization.code, status: organization.status },
      organizationJoined: db.organizationEventParticipations.some((participation) => (
        participation.organizationId === organization.id && participation.eventId === eventId
      ))
    }));
}

export function listAccountEvents(db, user, clock = () => new Date()) {
  const organization = user?.type === "organization"
    ? db.organizations.find((row) => row.ownerUserId === user.id)
    : null;
  const rows = db.events
    .filter((event) => !event.archivedAt && event.status !== "archived" && (
      event.status === "published" || isRegistrationOpen(event, clock()).open
    ))
    .map((event) => {
      const registrationCount = db.registrations.filter((row) => (
        row.eventId === event.id && (
          row.personalUserId === user.id
          || (organization && row.organizationId === organization.id)
        )
      )).length;
      const row = { event, registrationState: registrationState(event, clock), registrationCount };
      if (user.type === "ordinary") row.organizations = ordinaryOrganizations(db, user.id, event.id);
      if (user.type === "organization") {
        const joined = Boolean(organization && db.organizationEventParticipations.some((participation) => (
          participation.organizationId === organization.id && participation.eventId === event.id
        )));
        row.participationState = joined ? "joined" : (
          organization?.status === "active" && organization.reviewStatus === "approved" ? "available" : "blocked"
        );
        row.summary = organization
          ? organizationEventSummary(db, organization.id, event.id)
          : { registrationCount: 0, pendingRegistrationCount: 0, certificateCount: 0 };
      }
      return row;
    });
  return { rows };
}

export function joinOrganizationEvent(db, user, eventId, now) {
  const organization = requireOrganizationOwner(db, user);
  if (organization.status !== "active") {
    throw businessError(403, "组织已停用", "ORGANIZATION_DISABLED");
  }
  if (organization.reviewStatus !== "approved") {
    throw businessError(403, "组织资质尚未通过", "ORGANIZATION_NOT_APPROVED");
  }
  const event = db.events.find((row) => (
    row.id === eventId
    && !row.archivedAt
    && row.status !== "archived"
    && (row.status === "published" || isRegistrationOpen(row, new Date(now)).open)
  ));
  if (!event) throw businessError(404, "赛事不可加入", "EVENT_NOT_AVAILABLE");
  const existing = db.organizationEventParticipations.find((row) => (
    row.organizationId === organization.id && row.eventId === eventId
  ));
  if (existing) return { row: existing, created: false };
  const row = {
    organizationId: organization.id,
    eventId,
    joinedByUserId: user.id,
    joinedAt: now()
  };
  db.organizationEventParticipations.push(row);
  return { row, created: true };
}
