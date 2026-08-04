import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function mutateDb(dbPath, mutation) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  mutation(db);
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

test("personal registration reads retain an explicit event-scoped ownership context", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      db.registrations = ["E1", "E2"].map((eventId) => ({
        id: `R-${eventId}`,
        eventId,
        createdByUserId: ordinary.user.id,
        personalUserId: ordinary.user.id,
        organizationId: null,
        createdVia: "personal",
        athlete: { name: `学生-${eventId}`, school: "实验学校", grade: "三年级" },
        projectName: `赛项-${eventId}`,
        status: "approved"
      }));
      db.events = ["E1", "E2"].map((id) => ({
        ...db.events[0], id, isCurrent: id === "E1", archivedAt: null, status: "published"
      }));
    });

    const records = await (await fetch(
      `${baseUrl}/api/me/events/E2/registrations`,
      withSession(ordinary.cookie)
    )).json();
    assert.deepEqual(records.rows.map((row) => row.id), ["R-E2"]);

    for (const path of ["/api/me/events/%3Cscript%3E/registrations"]) {
      const response = await fetch(`${baseUrl}${path}?eventId=%3Cscript%3E`, withSession(ordinary.cookie));
      assert.equal(response.status, 404, path);
    }
  }, { prefix: "aerogp-event-scoped-user-data-" });
});

test("account registration history remains owned even when a query tries to select an event", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const response = await fetch(`${baseUrl}/api/me/registrations?eventId=wz-aerospace-2026`, withSession(ordinary.cookie));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.rows.map((row) => row.id), ["R20260627001"]);
  });
});
