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

test("personal result and certificate queries retain a validated event context", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      db.registrations = ["E1", "E2"].map((eventId) => ({
        id: `R-${eventId}`,
        eventId,
        userId: ordinary.user.id,
        athlete: { name: `学生-${eventId}`, school: "实验学校", grade: "三年级" },
        projectName: `赛项-${eventId}`,
        status: "approved"
      }));
      db.certificates = ["E1", "E2"].map((eventId) => ({
        id: `C-${eventId}`,
        registrationId: `R-${eventId}`,
        slot: 1,
        title: `证书-${eventId}`,
        status: "published",
        fileName: `${eventId}.png`,
        uploadedAt: "2026-01-01T00:00:00.000Z",
        publishedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }));
    });

    const records = await (await fetch(
      `${baseUrl}/api/me/registrations?eventId=E2`,
      withSession(ordinary.cookie)
    )).json();
    assert.deepEqual(records.rows.map((row) => row.id), ["R-E2"]);

    const certificates = await (await fetch(
      `${baseUrl}/api/me/certificates?eventId=E2`,
      withSession(ordinary.cookie)
    )).json();
    assert.deepEqual(certificates.rows.map((row) => row.id), ["C-E2"]);

    for (const path of ["/api/me/registrations", "/api/me/certificates"]) {
      const response = await fetch(`${baseUrl}${path}?eventId=%3Cscript%3E`, withSession(ordinary.cookie));
      assert.equal(response.status, 422, path);
    }
  }, { prefix: "aerogp-event-scoped-user-data-" });
});
