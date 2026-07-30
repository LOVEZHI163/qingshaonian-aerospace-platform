import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

function jsonOptions(method, body, cookie) {
  return withSession(cookie, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("certificate import writes require their URL event and reject archived or cross-event batches", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.events.push({ id: "E2", status: "published", archivedAt: null });
    db.registrations.push({ ...db.registrations[1], id: "R-E2", eventId: "E2" });
    db.certificateImportBatches.push({
      id: "B-E1", eventId: "wz-aerospace-2026", status: "preview", previewJson: [], originalName: "empty.xlsx"
    });
    db.certificateImportBatches.push({
      id: "B-MISMATCH",
      eventId: "wz-aerospace-2026",
      status: "preview",
      previewJson: [{
        registrationId: "R-E2",
        expectedCertificateStates: { 1: { state: "missing" } },
        certificates: [{ slot: 1 }]
      }],
      originalName: "mismatch.xlsx"
    });
    db.certificates.push({
      id: "C-E1", registrationId: "R20260627002", slot: 1, title: "draft", status: "draft",
      fileName: "draft.png", storedName: "draft.png", filePath: "/safe/draft.png", cleanedAt: ""
    });
    await fs.writeFile(dbPath, JSON.stringify(db));
    const admin = await loginAs(baseUrl, "13900000000", "admin123");

    const oldPreview = await fetch(`${baseUrl}/api/admin/certificate-imports/preview`, withSession(admin.cookie, { method: "POST" }));
    assert.equal(oldPreview.status, 404);

    const crossEventCommit = await fetch(
      `${baseUrl}/api/admin/events/E2/certificate-imports/B-E1/commit`,
      withSession(admin.cookie, { method: "POST" })
    );
    assert.equal(crossEventCommit.status, 404);

    const mismatchedRegistration = await fetch(
      `${baseUrl}/api/admin/events/wz-aerospace-2026/certificate-imports/B-MISMATCH/commit`,
      withSession(admin.cookie, { method: "POST" })
    );
    assert.equal(mismatchedRegistration.status, 409);

    for (const [method, path, body] of [
      ["PATCH", "/api/admin/events/E2/certificates/C-E1", { title: "wrong event" }],
      ["DELETE", "/api/admin/events/E2/certificates/C-E1"],
      ["POST", "/api/admin/events/E2/certificates/bulk-status", { ids: ["C-E1"], status: "published" }]
    ]) {
      const options = body
        ? jsonOptions(method, body, admin.cookie)
        : withSession(admin.cookie, { method });
      const response = await fetch(`${baseUrl}${path}`, options);
      assert.equal(response.status, 404, `${method} ${path}`);
    }

    const archive = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/archive`, jsonOptions("POST", {}, admin.cookie));
    assert.equal(archive.status, 200);

    const archivedPreview = await fetch(
      `${baseUrl}/api/admin/events/wz-aerospace-2026/certificate-imports/preview`,
      withSession(admin.cookie, { method: "POST" })
    );
    assert.equal(archivedPreview.status, 409);
    const archivedCommit = await fetch(
      `${baseUrl}/api/admin/events/wz-aerospace-2026/certificate-imports/B-E1/commit`,
      withSession(admin.cookie, { method: "POST" })
    );
    assert.equal(archivedCommit.status, 409);
    const archivedUpload = await fetch(
      `${baseUrl}/api/admin/events/wz-aerospace-2026/registrations/R20260627002/certificates/1`,
      withSession(admin.cookie, { method: "POST" })
    );
    assert.equal(archivedUpload.status, 409);
    for (const [method, path, body] of [
      ["PATCH", "/api/admin/events/wz-aerospace-2026/certificates/C-E1", { title: "archived" }],
      ["DELETE", "/api/admin/events/wz-aerospace-2026/certificates/C-E1"],
      ["POST", "/api/admin/events/wz-aerospace-2026/certificates/bulk-status", { ids: ["C-E1"], status: "published" }]
    ]) {
      const options = body
        ? jsonOptions(method, body, admin.cookie)
        : withSession(admin.cookie, { method });
      const response = await fetch(`${baseUrl}${path}`, options);
      assert.equal(response.status, 409, `${method} ${path}`);
    }
  }, { prefix: "certificate-import-event-context-" });
});
