import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";

async function mutateDb(dbPath, mutation) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  mutation(db);
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

async function readDb(dbPath) {
  return JSON.parse(await fs.readFile(dbPath, "utf8"));
}

function scheduledPost(id, publishAt, overrides = {}) {
  return {
    id,
    slug: id.toLowerCase(),
    eventId: null,
    type: "announcement",
    title: `${id} title`,
    summary: `${id} summary`,
    bodyHtml: `<p onclick="bad()">${id}<script>alert(1)</script></p>`,
    status: "scheduled",
    publishAt,
    pinned: false,
    sortOrder: 0,
    coverMediaId: null,
    version: 1,
    createdBy: "U9001",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

test("public request atomically publishes due scheduled content and keeps future content hidden", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.contentPosts = [
        scheduledPost("DUE", "2020-01-01T00:00:00.000Z", { coverMediaId: "COVER" }),
        scheduledPost("FUTURE", "2999-01-01T00:00:00.000Z")
      ];
      db.mediaAssets = [{
        id: "COVER",
        eventId: null,
        purpose: "content-cover",
        visibility: "draft",
        originalName: "cover.png",
        storedName: "cover.png",
        filePath: "C:/uploads/cover.png",
        mimeType: "image/png",
        sizeBytes: 1,
        width: 1,
        height: 1,
        variants: {},
        createdBy: "U9001",
        createdAt: "2026-07-01T00:00:00.000Z",
        cleanedAt: null
      }];
      db.contentAttachments = [{ contentId: "DUE", mediaId: "COVER", label: "cover", displayOrder: 0 }];
      db.auditLogs = [];
    });

    const [first, second] = await Promise.all([
      fetch(`${baseUrl}/api/public/home`),
      fetch(`${baseUrl}/api/public/home`)
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const firstHome = await first.json();
    const secondHome = await second.json();
    assert.deepEqual(firstHome.announcements.map((row) => row.id), ["DUE"]);
    assert.deepEqual(secondHome.announcements.map((row) => row.id), ["DUE"]);

    const db = await readDb(dbPath);
    const due = db.contentPosts.find((row) => row.id === "DUE");
    const future = db.contentPosts.find((row) => row.id === "FUTURE");
    assert.equal(due.status, "published");
    assert.equal(due.version, 2);
    assert.equal(due.bodyHtml.includes("script"), false);
    assert.equal(due.bodyHtml.includes("onclick"), false);
    assert.equal(future.status, "scheduled");
    assert.equal(db.mediaAssets.find((row) => row.id === "COVER").visibility, "public");
    assert.equal(db.auditLogs.filter((row) => row.action === "content.publish" && row.targetId === "DUE").length, 1);
  }, { prefix: "scheduled-content-publish-" });
});

test("invalid due scheduled content remains hidden and does not partially promote media", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.contentPosts = [scheduledPost("INVALID-DUE", "2020-01-01T00:00:00.000Z", { coverMediaId: "MISSING" })];
      db.contentAttachments = [];
      db.auditLogs = [];
    });

    const response = await fetch(`${baseUrl}/api/public/home`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).announcements, []);

    const db = await readDb(dbPath);
    assert.equal(db.contentPosts[0].status, "scheduled");
    assert.equal(db.auditLogs.some((row) => row.action === "content.publish"), false);
  }, { prefix: "scheduled-content-invalid-" });
});

test("due scheduled content linked to a draft event remains scheduled", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.events[0].status = "draft";
      db.contentPosts = [scheduledPost("DRAFT-EVENT-DUE", "2020-01-01T00:00:00.000Z", {
        eventId: db.events[0].id
      })];
      db.contentAttachments = [];
      db.auditLogs = [];
    });

    const response = await fetch(`${baseUrl}/api/public/home`);
    assert.equal(response.status, 200);

    const db = await readDb(dbPath);
    assert.equal(db.contentPosts.find((row) => row.id === "DRAFT-EVENT-DUE").status, "scheduled");
    assert.equal(db.auditLogs.some((row) => row.targetId === "DRAFT-EVENT-DUE"), false);
  }, { prefix: "scheduled-content-draft-event-" });
});

test("a draft with an intended due time cannot be activated by the scheduler", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.contentPosts = [scheduledPost("UNCONFIRMED-DRAFT", "2020-01-01T00:00:00.000Z", {
        status: "draft"
      })];
      db.contentAttachments = [];
      db.auditLogs = [];
    });

    const response = await fetch(`${baseUrl}/api/public/home`);
    assert.equal(response.status, 200);

    const db = await readDb(dbPath);
    assert.equal(db.contentPosts[0].status, "draft");
    assert.equal(db.auditLogs.some((row) => row.targetId === "UNCONFIRMED-DRAFT"), false);
  }, { prefix: "scheduled-content-unconfirmed-draft-" });
});
