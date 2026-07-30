import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function payload(response) {
  const body = await response.json();
  assert.ok(body && typeof body === "object");
  return body;
}

test("organization certificate history reads only its published archived-event registrations", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.events[0].status = "archived";
    db.events[0].archivedAt = "2026-07-30T00:00:00.000Z";
    db.organizationEventParticipations.push({
      organizationId: "O1001", eventId: db.events[0].id, joinedAt: "2026-07-01T00:00:00.000Z"
    });
    db.certificates.push(
      { id: "C-PUBLISHED", registrationId: "R20260627001", slot: 1, title: "published", status: "published", fileName: "p.png", storedName: "p.png", filePath: "/safe/p.png", cleanedAt: "" },
      { id: "C-DRAFT", registrationId: "R20260627001", slot: 2, title: "draft", status: "draft", fileName: "d.png", storedName: "d.png", filePath: "/safe/d.png", cleanedAt: "" },
      { id: "C-OTHER", registrationId: "R20260627002", slot: 1, title: "other", status: "published", fileName: "o.png", storedName: "o.png", filePath: "/safe/o.png", cleanedAt: "" }
    );
    await fs.writeFile(dbPath, JSON.stringify(db));

    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const otherOwner = await loginAs(baseUrl, "13800000012", "123456");
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const eventId = "wz-aerospace-2026";

    const organization = await fetch(`${baseUrl}/api/organization/events/${eventId}/certificates`, withSession(owner.cookie));
    assert.equal(organization.status, 200);
    assert.deepEqual((await payload(organization)).rows.map((row) => row.id), ["C-PUBLISHED"]);

    const foreign = await fetch(`${baseUrl}/api/organization/events/${eventId}/certificates`, withSession(otherOwner.cookie));
    assert.equal(foreign.status, 403);

    const personal = await fetch(`${baseUrl}/api/me/events/${eventId}/certificates`, withSession(ordinary.cookie));
    assert.equal(personal.status, 200);
    assert.deepEqual((await payload(personal)).rows.map((row) => row.id), ["C-PUBLISHED"]);

    const adminRows = await fetch(`${baseUrl}/api/admin/events/${eventId}/certificates`, withSession(admin.cookie));
    assert.equal(adminRows.status, 200);
    assert.deepEqual((await payload(adminRows)).rows.map((row) => row.id).sort(), ["C-DRAFT", "C-OTHER", "C-PUBLISHED"]);
  }, { prefix: "organization-certificate-history-" });
});
