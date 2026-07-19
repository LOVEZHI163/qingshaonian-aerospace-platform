import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";

async function mutateDb(dbPath, mutation) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  mutation(db);
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

function event(id, overrides = {}) {
  return {
    id,
    name: `${id} 航空航天比赛`,
    theme: `${id} 主题`,
    dateLabel: "往届赛事",
    venue: "温州科技馆",
    contact: "组委会",
    registrationStartAt: "1999-01-01T00:00:00.000Z",
    registrationEndAt: "2000-01-01T00:00:00.000Z",
    registrationMode: "automatic",
    status: "published",
    isCurrent: false,
    archivedAt: null,
    createdAt: "1999-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    ...overrides
  };
}

function profile(eventId, overrides = {}) {
  return {
    eventId,
    slug: eventId.toLowerCase(),
    slogan: `${eventId} 宣传语`,
    summary: `${eventId} 摘要`,
    isVisible: true,
    displayOrder: 0,
    heroMediaId: null,
    version: 1,
    updatedAt: "2000-01-01T00:00:00.000Z",
    ...overrides
  };
}

test("public history events are visible, historical and independently paginated while an active event exists", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    await mutateDb(dbPath, (db) => {
      db.events = [
        event("ACTIVE", {
          registrationStartAt: "2998-01-01T00:00:00.000Z",
          registrationEndAt: "2999-01-01T00:00:00.000Z",
          registrationMode: "force_open"
        }),
        event("OLD-NEW", { registrationEndAt: "2002-01-01T00:00:00.000Z" }),
        event("OLD-ARCHIVED", {
          registrationEndAt: "2001-01-01T00:00:00.000Z",
          status: "archived",
          archivedAt: "2001-01-02T00:00:00.000Z"
        }),
        event("FORCED-ACTIVE", { registrationMode: "force_open" }),
        event("CURRENT-ENDED", { isCurrent: true, registrationEndAt: "2005-01-01T00:00:00.000Z" }),
        event("MANUAL-FEATURED", { registrationEndAt: "2006-01-01T00:00:00.000Z" }),
        event("HIDDEN", { registrationEndAt: "2003-01-01T00:00:00.000Z" }),
        event("DRAFT", { registrationEndAt: "2004-01-01T00:00:00.000Z", status: "draft" })
      ];
      db.eventPublicProfiles = [
        profile("ACTIVE"), profile("OLD-NEW"), profile("OLD-ARCHIVED"), profile("FORCED-ACTIVE"),
        profile("CURRENT-ENDED"), profile("MANUAL-FEATURED"),
        profile("HIDDEN", { isVisible: false }), profile("DRAFT")
      ];
      db.siteSettings.featuredEventId = "MANUAL-FEATURED";
    });

    const firstResponse = await fetch(`${baseUrl}/api/public/events?page=1&pageSize=1`);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.deepEqual(first.pagination, { page: 1, pageSize: 1, total: 2, totalPages: 2 });
    assert.deepEqual(first.rows.map((row) => row.id), ["OLD-NEW"]);
    assert.equal(first.rows[0].slug, "old-new");

    const second = await (await fetch(`${baseUrl}/api/public/events?page=2&pageSize=1`)).json();
    assert.deepEqual(second.rows.map((row) => row.id), ["OLD-ARCHIVED"]);
    assert.equal(JSON.stringify({ first, second }).includes("ACTIVE"), false);
    assert.equal(JSON.stringify({ first, second }).includes("FORCED-ACTIVE"), false);
    assert.equal(JSON.stringify({ first, second }).includes("CURRENT-ENDED"), false);
    assert.equal(JSON.stringify({ first, second }).includes("MANUAL-FEATURED"), false);
    assert.equal(JSON.stringify({ first, second }).includes("HIDDEN"), false);
    assert.equal(JSON.stringify({ first, second }).includes("DRAFT"), false);
  }, { prefix: "aerogp-public-history-events-" });
});

test("public history event pagination rejects invalid bounds", async () => {
  await withTestServer(async ({ baseUrl }) => {
    for (const query of ["page=0", "page=1.5", "pageSize=0", "pageSize=51"]) {
      const response = await fetch(`${baseUrl}/api/public/events?${query}`);
      assert.equal(response.status, 422, query);
    }
  }, { prefix: "aerogp-public-history-validation-" });
});
