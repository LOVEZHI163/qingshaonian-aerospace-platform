import assert from "node:assert/strict";
import test from "node:test";

import { organizationForOwner, requireOrganizationOwner, requireOrdinaryUser, requireOrganizationEventParticipation, requireWritableEvent } from "../src/services/access-control.js";

test("access control identifies ownership from organizations instead of membership roles", () => {
  const db = {
    organizations: [{ id: "O1001", ownerUserId: "U2001", status: "active", reviewStatus: "approved" }],
    events: [{ id: "E1001", status: "published", archivedAt: null }],
    organizationEventParticipations: [{ organizationId: "O1001", eventId: "E1001" }]
  };

  assert.equal(organizationForOwner(db, "U2001").id, "O1001");
  assert.throws(
    () => requireOrganizationOwner(db, { id: "U1001", type: "ordinary" }),
    (error) => error.status === 403
  );
  assert.equal(requireOrdinaryUser({ id: "U1001", type: "ordinary" }).id, "U1001");
  assert.equal(requireOrganizationEventParticipation(db, { id: "U2001", type: "organization" }, "E1001", { writable: true }).organization.id, "O1001");
  assert.throws(() => requireWritableEvent({ ...db, events: [{ id: "E1002", status: "archived", archivedAt: "2026-07-30T00:00:00.000Z" }] }, "E1002"), (error) => error.status === 409 && error.code === "EVENT_ARCHIVED");
});
