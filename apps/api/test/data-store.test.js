import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDataStore } from "../src/data/index.js";
import { ensureDbShape, EVENT, seedDb } from "../src/data/seed.js";

test("seed keeps the approved Wenzhou event contact label", () => {
  assert.equal(EVENT.contact, "吴老师 88968723 / 15858799111");
  assert.equal(seedDb.events.find((event) => event.id === EVENT.id)?.contact, EVENT.contact);
});

test("website data shape fills missing public site collections and default settings", () => {
  const db = ensureDbShape({});

  assert.deepEqual(db.siteSettings, {
    id: "default",
    platformName: "温州市青少年航空航天创新比赛",
    featuredEventId: null,
    platformIntro: "",
    organizers: [],
    contact: "",
    icp: "",
    seoTitle: "温州市青少年航空航天创新比赛",
    seoDescription: "",
    defaultHeroMediaId: null,
    shareMediaId: null,
    version: 1
  });
  assert.deepEqual(db.eventPublicProfiles, []);
  assert.deepEqual(db.contentPosts, []);
  assert.deepEqual(db.mediaAssets, []);
  assert.deepEqual(db.contentAttachments, []);
  assert.deepEqual(db.organizationEventParticipations, []);
  assert.equal(db.registrations.every((row) => "createdByUserId" in row), true);
  assert.equal(db.registrations.every((row) => !("userId" in row)), true);
});

test("seed organization registrations are created by their organization owner", () => {
  for (const registration of seedDb.registrations.filter((row) => row.createdVia === "organization")) {
    const organization = seedDb.organizations.find((row) => row.id === registration.organizationId);
    assert.ok(organization, registration.id);
    assert.equal(registration.createdByUserId, organization.ownerUserId, registration.id);
  }
});

test("data store selects file persistence and keeps mutations", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-store-"));
  const dbPath = path.join(tempDir, "db.json");
  const store = createDataStore({ DB_PATH: dbPath });

  try {
    assert.equal(store.kind, "file");
    await store.initialize();

    const initial = await store.readDb();
    assert.deepEqual(initial, seedDb);

    initial.users.push({
      id: "UTEST",
      name: "测试用户",
      phone: "13611112222",
      password: "test-only",
      type: "ordinary",
      status: "active",
      createdAt: "2026-07-16T00:00:00.000Z"
    });
    await store.writeDb(initial);

    const persisted = await store.readDb();
    assert.equal(persisted.users.at(-1).id, "UTEST");
    assert.equal(persisted.registrations[0].awardName, "");
  } finally {
    await store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("file store rejects nested plaintext athlete identity fields without replacing persisted data", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-athlete-identity-"));
  const dbPath = path.join(tempDir, "db.json");
  const store = createDataStore({ DB_PATH: dbPath });

  try {
    const db = await store.readDb();
    db.registrations[0].athlete.emergencyContact = { name: "陈家长", phone: "13800000001" };
    await store.writeDb(db);
    const persisted = await store.readDb();
    assert.deepEqual(persisted.registrations[0].athlete.emergencyContact, { name: "陈家长", phone: "13800000001" });

    const invalid = structuredClone(persisted);
    invalid.registrations[0].status = "approved";
    invalid.registrations[0].athlete.guardian = { idCard: "330000200001010001" };
    await assert.rejects(store.writeDb(invalid), /identity field/i);

    const afterRejectedWrite = await store.readDb();
    assert.equal(afterRejectedWrite.registrations[0].status, persisted.registrations[0].status);
    assert.equal("guardian" in afterRejectedWrite.registrations[0].athlete, false);
  } finally {
    await store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("file auth state persists rate limits and one-time challenges across store instances", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-auth-state-"));
  const dbPath = path.join(tempDir, "db.json");
  const now = Date.parse("2026-07-17T00:00:00.000Z");

  try {
    const first = createDataStore({ DB_PATH: dbPath });
    await first.initialize();
    assert.equal(await first.authState.consumeRateLimits([
      { key: "sms:phone:13800000001", limit: 1, windowMs: 60_000 }
    ], now), true);
    await first.authState.saveChallenge({ phone: "13800000001", digest: "a".repeat(64), expiresAt: now + 300_000 });
    await first.close();

    const second = createDataStore({ DB_PATH: dbPath });
    await second.initialize();
    assert.equal(await second.authState.consumeRateLimits([
      { key: "sms:phone:13800000001", limit: 1, windowMs: 60_000 }
    ], now + 1), false);
    assert.equal(await second.authState.consumeRateLimits([
      { key: "sms:phone:13800000001", limit: 1, windowMs: 60_000 }
    ], now + 60_001), true);
    const persistedAuth = JSON.parse(await fs.readFile(`${dbPath}.auth.json`, "utf8"));
    assert.deepEqual(persistedAuth.rateBuckets["sms:phone:13800000001"], [now + 60_001]);
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => second.authState.consumeRateLimits([
      { key: "login:ip:127.0.0.1", limit: 5, windowMs: 60_000 }
    ], now)));
    assert.equal(concurrent.filter(Boolean).length, 5);
    assert.equal(await second.authState.consumeChallenge({
      phone: "13800000001", digest: "a".repeat(64), now: now + 1, maxAttempts: 5
    }), true);
    assert.equal(await second.authState.consumeChallenge({
      phone: "13800000001", digest: "a".repeat(64), now: now + 1, maxAttempts: 5
    }), false);
    await second.authState.saveChallenge({ phone: "13800000002", digest: "c".repeat(64), expiresAt: now + 10 });
    await second.authState.consumeChallenge({ phone: "13800000003", digest: "d".repeat(64), now: now + 11, maxAttempts: 5 });
    const cleanedAuth = JSON.parse(await fs.readFile(`${dbPath}.auth.json`, "utf8"));
    assert.equal("13800000002" in cleanedAuth.challenges, false);
    await second.close();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
