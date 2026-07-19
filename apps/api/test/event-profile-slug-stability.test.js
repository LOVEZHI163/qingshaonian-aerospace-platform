import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const EVENT_ID = "wz-aerospace-2026";

async function mutateDb(dbPath, mutation) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  mutation(db);
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

async function readDb(dbPath) {
  return JSON.parse(await fs.readFile(dbPath, "utf8"));
}

async function jsonRequest(url, cookie, method, body) {
  return fetch(url, withSession(cookie, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }));
}

test("an event profile slug remains editable until first public visibility, then stays permanent", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await mutateDb(dbPath, (db) => {
      const event = db.events.find((row) => row.id === EVENT_ID);
      event.status = "draft";
      event.isCurrent = false;
      event.archivedAt = null;
      db.eventPublicProfiles = [];
      db.contentPosts = [];
      db.auditLogs = [];
    });

    const createdResponse = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`, admin.cookie, "PUT", {
      slug: "draft-event-link",
      isVisible: false,
      displayOrder: 0
    });
    const created = (await createdResponse.json()).row;
    assert.equal(createdResponse.status, 201);

    const renamedDraftResponse = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`, admin.cookie, "PUT", {
      version: created.version,
      slug: "hidden-event-link",
      isVisible: false,
      displayOrder: 0
    });
    const renamedDraft = (await renamedDraftResponse.json()).row;
    assert.equal(renamedDraftResponse.status, 200);

    const publishEvent = await jsonRequest(`${baseUrl}/api/admin/events/${EVENT_ID}/current`, admin.cookie, "POST", {});
    assert.equal(publishEvent.status, 200);

    const renamedWhileHiddenResponse = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`, admin.cookie, "PUT", {
      version: renamedDraft.version,
      slug: "public-event-link",
      isVisible: false,
      displayOrder: 0
    });
    const renamedWhileHidden = (await renamedWhileHiddenResponse.json()).row;
    assert.equal(renamedWhileHiddenResponse.status, 200);

    const firstPublicResponse = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`, admin.cookie, "PUT", {
      version: renamedWhileHidden.version,
      slug: "public-event-link",
      isVisible: true,
      displayOrder: 0
    });
    const firstPublic = (await firstPublicResponse.json()).row;
    assert.equal(firstPublicResponse.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/public/events/public-event-link`)).status, 200);

    const hiddenResponse = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`, admin.cookie, "PUT", {
      version: firstPublic.version,
      slug: "public-event-link",
      isVisible: false,
      displayOrder: 0
    });
    const hidden = (await hiddenResponse.json()).row;
    assert.equal(hiddenResponse.status, 200);

    const renamedAfterPublic = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`, admin.cookie, "PUT", {
      version: hidden.version,
      slug: "broken-old-link",
      isVisible: false,
      displayOrder: 0
    });
    assert.equal(renamedAfterPublic.status, 409);
    assert.equal((await renamedAfterPublic.json()).code, "EVENT_SLUG_STABLE");

    const restoredResponse = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`, admin.cookie, "PUT", {
      version: hidden.version,
      slug: "public-event-link",
      isVisible: true,
      displayOrder: 0
    });
    assert.equal(restoredResponse.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/public/events/public-event-link`)).status, 200);
    const sitemap = await (await fetch(`${baseUrl}/api/public/sitemap.xml`)).text();
    assert.equal(sitemap.includes("https://public.example/events/public-event-link"), true);
    assert.equal(sitemap.includes("broken-old-link"), false);

    const db = await readDb(dbPath);
    assert.equal(db.auditLogs.filter(
      (row) => row.action === "event.profile-public" && row.targetId === EVENT_ID
    ).length, 1);
  }, {
    prefix: "event-profile-slug-lifecycle-",
    env: { PUBLIC_SITE_URL: "https://public.example" }
  });
});

test("legacy visible published and archived event profiles lock immediately without prior audit", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await mutateDb(dbPath, (db) => {
      const template = db.events[0];
      db.events = [
        { ...template, id: "LEGACY-PUBLISHED", status: "published", isCurrent: false, archivedAt: null },
        { ...template, id: "LEGACY-ARCHIVED", status: "archived", isCurrent: false, archivedAt: "2026-07-01T00:00:00.000Z" }
      ];
      db.eventPublicProfiles = [
        { eventId: "LEGACY-PUBLISHED", slug: "legacy-published", slogan: "", summary: "", isVisible: true, displayOrder: 0, heroMediaId: null, version: 1, updatedAt: "2026-07-01T00:00:00.000Z" },
        { eventId: "LEGACY-ARCHIVED", slug: "legacy-archived", slogan: "", summary: "", isVisible: true, displayOrder: 1, heroMediaId: null, version: 1, updatedAt: "2026-07-01T00:00:00.000Z" }
      ];
      db.contentPosts = [];
      db.auditLogs = [];
    });

    for (const [eventId, slug] of [["LEGACY-PUBLISHED", "legacy-published"], ["LEGACY-ARCHIVED", "legacy-archived"]]) {
      const rename = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${eventId}`, admin.cookie, "PUT", {
        version: 1,
        slug: `${slug}-changed`,
        isVisible: true,
        displayOrder: 0
      });
      assert.equal(rename.status, 409, eventId);

      const hide = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${eventId}`, admin.cookie, "PUT", {
        version: 1,
        slug,
        isVisible: false,
        displayOrder: 0
      });
      assert.equal(hide.status, 200, eventId);
      const hidden = (await hide.json()).row;

      const renameHidden = await jsonRequest(`${baseUrl}/api/admin/event-public-profiles/${eventId}`, admin.cookie, "PUT", {
        version: hidden.version,
        slug: `${slug}-changed-after-hide`,
        isVisible: false,
        displayOrder: 0
      });
      assert.equal(renameHidden.status, 409, eventId);
    }

    const db = await readDb(dbPath);
    assert.deepEqual(
      db.auditLogs.filter((row) => row.action === "event.profile-public").map((row) => row.targetId).sort(),
      ["LEGACY-ARCHIVED", "LEGACY-PUBLISHED"]
    );
  }, { prefix: "legacy-event-profile-slug-" });
});
