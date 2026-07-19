import assert from "node:assert/strict";
import test from "node:test";

import { selectHomeEvents } from "../src/services/public-site.js";

const now = new Date("2026-07-19T12:00:00.000Z");

function event(id, overrides = {}) {
  return {
    id,
    status: "published",
    archivedAt: null,
    registrationStartAt: "2026-07-01T00:00:00.000Z",
    registrationEndAt: "2026-07-31T00:00:00.000Z",
    registrationMode: "automatic",
    ...overrides
  };
}

function profile(eventId, overrides = {}) {
  return { eventId, isVisible: true, displayOrder: 0, ...overrides };
}

function db(events, profiles, featuredEventId = null) {
  return { siteSettings: { featuredEventId }, events, eventPublicProfiles: profiles };
}

test("home event selection respects a valid manual feature and caps concurrent events", () => {
  const source = db(
    [event("E1"), event("E2"), event("E3")],
    [profile("E1", { displayOrder: 1 }), profile("E2", { displayOrder: 2 }), profile("E3", { displayOrder: 3 })],
    "E2"
  );

  const selection = selectHomeEvents(source, now);

  assert.equal(selection.featuredEvent.id, "E2");
  assert.deepEqual(selection.concurrentEvents.map((row) => row.id), ["E1", "E3"]);
  assert.equal(selection.fallbackEvent, null);
  assert.equal(selection.mode, "active");
});

test("home event selection falls back when the manual feature is not public", () => {
  const source = db(
    [event("E1"), event("E2"), event("E3")],
    [profile("E1", { displayOrder: 2 }), profile("E2", { isVisible: false }), profile("E3", { displayOrder: 1 })],
    "E2"
  );

  const selection = selectHomeEvents(source, now);

  assert.equal(selection.featuredEvent.id, "E3");
  assert.deepEqual(selection.concurrentEvents.map((row) => row.id), ["E1"]);
});

test("home event selection keeps a valid manual feature outside the registration window", () => {
  const source = db(
    [event("FEATURED", { registrationEndAt: "2026-07-18T00:00:00.000Z" }), event("OPEN")],
    [profile("FEATURED"), profile("OPEN")],
    "FEATURED"
  );

  const selection = selectHomeEvents(source, now);

  assert.equal(selection.featuredEvent.id, "FEATURED");
  assert.deepEqual(selection.concurrentEvents.map((row) => row.id), ["OPEN"]);
  assert.equal(selection.mode, "active");
});

test("home event selection orders automatic choices by registration end, display order, then id", () => {
  const source = db(
    [
      event("E3", { registrationEndAt: "2026-07-25T00:00:00.000Z" }),
      event("E2", { registrationEndAt: "2026-07-25T00:00:00.000Z" }),
      event("E1", { registrationEndAt: "2026-07-24T00:00:00.000Z" })
    ],
    [profile("E3", { displayOrder: 1 }), profile("E2", { displayOrder: 1 }), profile("E1", { displayOrder: 99 })]
  );

  const selection = selectHomeEvents(source, now);

  assert.equal(selection.featuredEvent.id, "E1");
  assert.deepEqual(selection.concurrentEvents.map((row) => row.id), ["E2", "E3"]);
});

test("home event selection handles zero, one, two, and three open events", () => {
  const closed = db(
    [event("ENDED", { registrationEndAt: "2026-07-18T00:00:00.000Z" })],
    [profile("ENDED")]
  );
  const one = db([event("E1")], [profile("E1")]);
  const two = db([event("E1"), event("E2")], [profile("E1"), profile("E2")]);
  const three = db([event("E1"), event("E2"), event("E3")], [profile("E1"), profile("E2"), profile("E3")]);

  assert.equal(selectHomeEvents(closed, now).mode, "history");
  assert.equal(selectHomeEvents(closed, now).featuredEvent, null);
  assert.equal(selectHomeEvents(closed, now).fallbackEvent.id, "ENDED");
  assert.deepEqual(selectHomeEvents(one, now).concurrentEvents.map((row) => row.id), []);
  assert.deepEqual(selectHomeEvents(two, now).concurrentEvents.map((row) => row.id), ["E2"]);
  assert.deepEqual(selectHomeEvents(three, now).concurrentEvents.map((row) => row.id), ["E2", "E3"]);
});

test("home event selection honors forced registration opening and closing", () => {
  const source = db(
    [
      event("OPEN", { registrationMode: "force_open", registrationStartAt: "2030-01-01T00:00:00.000Z", registrationEndAt: "2030-02-01T00:00:00.000Z" }),
      event("CLOSED", { registrationMode: "force_closed" })
    ],
    [profile("OPEN"), profile("CLOSED")]
  );

  const selection = selectHomeEvents(source, now);

  assert.equal(selection.featuredEvent.id, "OPEN");
  assert.deepEqual(selection.concurrentEvents, []);
});

test("home event selection excludes hidden archived events from public history", () => {
  const noActiveDb = db(
    [
      event("PUBLIC-OLD", { registrationEndAt: "2026-07-10T00:00:00.000Z" }),
      event("ARCHIVED-NEW", { status: "archived", archivedAt: "2026-07-18T00:00:00.000Z", registrationEndAt: "2026-07-18T00:00:00.000Z" })
    ],
    [profile("PUBLIC-OLD"), profile("ARCHIVED-NEW", { isVisible: false })]
  );

  const selection = selectHomeEvents(noActiveDb, now);

  assert.equal(selection.mode, "history");
  assert.equal(selection.fallbackEvent.id, "PUBLIC-OLD");
  assert.equal(selection.featuredEvent, null);
  assert.deepEqual(selection.concurrentEvents, []);
});

test("home event selection returns a stable empty history when every archived event is hidden", () => {
  const noActiveDb = db(
    [event("ARCHIVED", { status: "archived", archivedAt: "2026-07-18T00:00:00.000Z", registrationEndAt: "2026-07-18T00:00:00.000Z" })],
    [profile("ARCHIVED", { isVisible: false })]
  );

  const selection = selectHomeEvents(noActiveDb, now);

  assert.equal(selection.mode, "history");
  assert.equal(selection.fallbackEvent, null);
  assert.equal(selection.featuredEvent, null);
  assert.deepEqual(selection.concurrentEvents, []);
});

test("home event selection excludes visible draft events from history fallback", () => {
  const noActiveDb = db(
    [
      event("PUBLISHED", { registrationEndAt: "2026-07-17T00:00:00.000Z" }),
      event("DRAFT", { status: "draft", registrationEndAt: "2026-07-18T00:00:00.000Z" })
    ],
    [profile("PUBLISHED"), profile("DRAFT")]
  );

  const selection = selectHomeEvents(noActiveDb, now);

  assert.equal(selection.mode, "history");
  assert.equal(selection.fallbackEvent.id, "PUBLISHED");
});
