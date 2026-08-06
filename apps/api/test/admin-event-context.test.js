import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { requireEventId } from "../src/services/registrations.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

function jsonOptions(method, body, cookie) {
  return withSession(cookie, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("strict administrator event parser rejects missing and unknown event IDs", () => {
  const db = { events: [{ id: "E1" }] };
  assert.throws(() => requireEventId(db), { status: 422, code: "EVENT_ID_REQUIRED" });
  assert.throws(() => requireEventId(db, "E2"), { status: 404, code: "EVENT_NOT_AVAILABLE" });
  assert.equal(requireEventId(db, " E1 ").id, "E1");
});

test("administrator dashboard requires an explicit existing event ID", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    for (const path of ["/api/admin/dashboard", "/api/admin/dashboard?eventId=%20"]) {
      const response = await fetch(`${baseUrl}${path}`, withSession(admin.cookie));
      assert.equal(response.status, 422, path);
      assert.equal((await response.json()).code, "EVENT_ID_REQUIRED");
    }
    const missing = await fetch(`${baseUrl}/api/admin/dashboard?eventId=missing`, withSession(admin.cookie));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "EVENT_NOT_AVAILABLE");
  }, { prefix: "admin-event-context-dashboard-" });
});

test("administrator event-scoped readers share the unavailable-event error contract", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    for (const path of [
      "/api/admin/events/missing/registrations",
      "/api/admin/events/missing/certificates",
      "/api/admin/events/missing/certificate-imports"
    ]) {
      const response = await fetch(`${baseUrl}${path}`, withSession(admin.cookie));
      assert.equal(response.status, 404, path);
      assert.equal((await response.json()).code, "EVENT_NOT_AVAILABLE", path);
    }
  }, { prefix: "admin-event-context-readers-" });
});

test("administrator organization payload exposes per-event registration, result and certificate counts", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const eventId = "wz-aerospace-2026";
    db.organizationEventParticipations.push({
      organizationId: "O1001",
      eventId,
      joinedByUserId: "U2001",
      joinedAt: "2026-07-30T00:00:00.000Z"
    });
    const result = db.registrations.find((row) => row.id === "R20260627001");
    result.awardName = "一等奖";
    db.certificates.push(
      { id: "C1", registrationId: result.id, status: "published" },
      { id: "C2", registrationId: result.id, status: "draft" }
    );
    await fs.writeFile(dbPath, JSON.stringify(db), "utf8");

    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const response = await fetch(`${baseUrl}/api/admin/organizations/O1001`, withSession(admin.cookie));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.row.eventParticipations, [{
      organizationId: "O1001",
      eventId,
      joinedByUserId: "U2001",
      joinedAt: "2026-07-30T00:00:00.000Z",
      registrationCount: 1,
      resultCount: 1,
      certificateCount: 2
    }]);
  }, { prefix: "admin-event-context-organizations-" });
});

test("administrator mutations bind registrations to the URL event and reject archived event writes", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.events.push({ ...structuredClone(db.events[0]), id: "E2", isCurrent: false });
    await fs.writeFile(dbPath, JSON.stringify(db), "utf8");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");

    const mismatch = await fetch(
      `${baseUrl}/api/admin/events/E2/registrations/R20260627001`,
      jsonOptions("PATCH", { instructor: "测试" }, admin.cookie)
    );
    assert.equal(mismatch.status, 404);

    const archive = await fetch(
      `${baseUrl}/api/admin/events/wz-aerospace-2026/archive`,
      jsonOptions("POST", {}, admin.cookie)
    );
    assert.equal(archive.status, 200);
    const archivedResult = await fetch(
      `${baseUrl}/api/admin/events/wz-aerospace-2026/registrations/R20260627001/result`,
      jsonOptions("POST", { score: "100" }, admin.cookie)
    );
    assert.equal(archivedResult.status, 409);
    assert.equal((await archivedResult.json()).code, "EVENT_ARCHIVED");
  }, { prefix: "admin-event-context-mutations-" });
});
