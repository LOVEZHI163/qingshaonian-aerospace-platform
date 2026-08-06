import assert from "node:assert/strict";
import test from "node:test";

import { organizationAccessState, organizationForOwner, requireOrganizationOwner, requireOrdinaryUser, requireOrganizationEventParticipation, requireWritableEvent } from "../src/services/access-control.js";

test("organization access state exposes stable owner review and password codes", () => {
  const pendingOrganization = { id: "O-pending", ownerUserId: "U-pending", status: "active", reviewStatus: "pending" };
  const db = { organizations: [pendingOrganization] };
  const pendingOwner = { id: "U-pending", type: "organization", mustChangePassword: false };

  assert.deepEqual(organizationAccessState(db, pendingOwner), {
    allowed: false,
    code: "ORGANIZATION_REVIEW_PENDING",
    organization: pendingOrganization
  });
  pendingOrganization.reviewStatus = "rejected";
  assert.equal(organizationAccessState(db, pendingOwner).code, "ORGANIZATION_REJECTED");
  pendingOrganization.reviewStatus = "approved";
  pendingOrganization.status = "disabled";
  assert.equal(organizationAccessState(db, pendingOwner).code, "ORGANIZATION_DISABLED");
  pendingOrganization.status = "active";
  pendingOwner.mustChangePassword = true;
  assert.equal(organizationAccessState(db, pendingOwner).code, "PASSWORD_CHANGE_REQUIRED");
  pendingOwner.mustChangePassword = false;
  assert.equal(organizationAccessState(db, pendingOwner).code, "OK");
  assert.equal(organizationAccessState(db, { id: "U-ordinary", type: "ordinary" }).code, "ORGANIZATION_OWNER_REQUIRED");
});

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
  assert.equal(requireWritableEvent({
    ...db,
    events: [{ id: "E1002", status: "draft", archivedAt: null, registrationMode: "force_open" }]
  }, "E1002").id, "E1002");
  assert.throws(() => requireWritableEvent({ ...db, events: [{ id: "E1002", status: "archived", archivedAt: "2026-07-30T00:00:00.000Z" }] }, "E1002"), (error) => error.status === 409 && error.code === "EVENT_ARCHIVED");
});
