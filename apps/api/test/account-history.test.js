import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function mutateDb(dbPath, mutate) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  mutate(db);
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
}

test("ordinary account history lists its registrations across events", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      const archived = { ...structuredClone(db.events[0]), id: "E-ARCHIVED", name: "往届航空绘画赛", status: "archived", archivedAt: "2025-12-31T00:00:00.000Z" };
      db.events.push(archived);
      db.registrations.push(
        { ...structuredClone(db.registrations[0]), id: "R-HISTORY-MINE", eventId: archived.id, projectId: "P-HISTORY", projectName: "航空绘画", organization: "", organizationId: null },
        { ...structuredClone(db.registrations[0]), id: "R-HISTORY-OTHER", eventId: archived.id, personalUserId: "U-OTHER", createdByUserId: "U-OTHER" }
      );
    });

    const response = await fetch(`${baseUrl}/api/me/registrations`, withSession(ordinary.cookie));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.rows.map((row) => row.id).sort(), ["R-HISTORY-MINE", "R20260627001"]);
    assert.equal(payload.rows.find((row) => row.id === "R-HISTORY-MINE").eventName, "往届航空绘画赛");
    assert.equal(payload.rows.find((row) => row.id === "R-HISTORY-MINE").eventId, "E-ARCHIVED");
  }, { prefix: "wz-account-history-registration-" });
});

test("ordinary account history lists only its published certificates across active and archived events", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      const archived = { ...structuredClone(db.events[0]), id: "E-ARCHIVED", name: "往届航空绘画赛", status: "archived", archivedAt: "2025-12-31T00:00:00.000Z" };
      db.events.push(archived);
      db.registrations.push(
        { ...structuredClone(db.registrations[0]), id: "R-HISTORY-MINE", eventId: archived.id, projectId: "P-HISTORY", projectName: "航空绘画" },
        { ...structuredClone(db.registrations[0]), id: "R-HISTORY-OTHER", eventId: archived.id, personalUserId: "U-OTHER", createdByUserId: "U-OTHER" }
      );
      const certificate = (id, registrationId, status) => ({
        id, registrationId, slot: 1, title: `${id}证书`, fileName: `${id}.png`, storedName: `${id}.png`,
        filePath: `/tmp/${id}.png`, status, source: "manual", uploadedAt: "2026-01-01T00:00:00.000Z",
        publishedAt: status === "published" ? "2026-01-02T00:00:00.000Z" : "", cleanedAt: "", updatedAt: "2026-01-02T00:00:00.000Z"
      });
      db.certificates.push(
        certificate("C-CURRENT-MINE", "R20260627001", "published"),
        certificate("C-HISTORY-MINE", "R-HISTORY-MINE", "published"),
        certificate("C-DRAFT-MINE", "R-HISTORY-MINE", "draft"),
        certificate("C-HISTORY-OTHER", "R-HISTORY-OTHER", "published")
      );
    });

    const response = await fetch(`${baseUrl}/api/me/certificates`, withSession(ordinary.cookie));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.rows.map((row) => row.id).sort(), ["C-CURRENT-MINE", "C-HISTORY-MINE"]);
    assert.equal(payload.rows.find((row) => row.id === "C-HISTORY-MINE").eventName, "往届航空绘画赛");
    assert.equal(payload.rows.find((row) => row.id === "C-HISTORY-MINE").eventId, "E-ARCHIVED");
  }, { prefix: "wz-account-history-certificate-" });
});
