import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { createPostgresAuthState } from "../src/data/auth-state.js";
import { createPostgresStore } from "../src/data/postgres-store.js";

async function withStore(fn) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const store = createPostgresStore(pool);

  try {
    await store.initialize();
    await fn(store, pool);
  } finally {
    await store.close();
  }
}

test("PostgreSQL store creates normalized tables and seeds an empty database", async () => {
  await withStore(async (store, pool) => {
    const tableRows = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const tables = new Set(tableRows.rows.map((row) => row.table_name));
    for (const name of ["users", "organizations", "memberships", "events", "projects", "project_groups", "registrations", "results", "certificates", "auth_rate_buckets", "password_reset_challenges"]) {
      assert.equal(tables.has(name), true, `missing table ${name}`);
    }

    const eventColumns = await pool.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'events'
    `);
    const names = new Set(eventColumns.rows.map((row) => row.column_name));
    for (const name of ["registration_start_at", "registration_end_at", "registration_mode", "status", "is_current", "archived_at"]) {
      assert.equal(names.has(name), true, `missing events.${name}`);
    }

    const data = await store.readDb();
    assert.equal(data.users.length, 3);
    assert.equal(data.registrations.length, 2);
    assert.equal(data.registrations[0].awardName, "");
    assert.equal(data.events.filter((event) => event.isCurrent).length, 1);
    assert.equal(data.registrations.every((row) => row.eventId), true);
    assert.equal(data.projects.every((project) => project.allowedGroups.length === 4), true);
  });
});

test("PostgreSQL store persists mutations, results, and deletions", async () => {
  await withStore(async (store) => {
    const data = await store.readDb();
    data.registrations[0].awardName = "一等奖";
    data.registrations[0].rank = "1";
    data.registrations[0].score = "98.5";
    data.registrations[0].resultRecordedAt = "2026-07-16T01:00:00.000Z";
    data.memberships = data.memberships.filter((row) => row.id !== "M1003");

    await store.writeDb(data);
    const persisted = await store.readDb();

    assert.equal(persisted.registrations[0].awardName, "一等奖");
    assert.equal(persisted.registrations[0].score, "98.5");
    assert.equal(persisted.memberships.some((row) => row.id === "M1003"), false);
  });
});

test("PostgreSQL store switches the unique current event and removes projects without registrations", async () => {
  await withStore(async (store, pool) => {
    const data = await store.readDb();
    data.events.push({
      id: "event-next",
      name: "下一届赛事",
      theme: "下一届主题",
      dateLabel: "2027年10月1日",
      venue: "测试场馆",
      contact: "测试联系人",
      registrationStartAt: "2027-08-01T00:00:00.000Z",
      registrationEndAt: "2027-09-01T00:00:00.000Z",
      registrationMode: "automatic",
      status: "published",
      isCurrent: true,
      archivedAt: null,
      createdAt: "2027-01-01T00:00:00.000Z",
      updatedAt: "2027-01-01T00:00:00.000Z"
    });
    data.events.find((event) => event.id === "wz-aerospace-2026").isCurrent = false;
    data.projects.push({
      id: "project-removable",
      eventId: "event-next",
      name: "可删除赛项",
      type: "individual",
      category: "测试",
      enabled: true,
      instructorRequired: false,
      displayOrder: 0,
      allowedGroups: ["小学低段"]
    });
    data.projectGroups.push({ projectId: "project-removable", groupName: "小学低段" });
    await store.writeDb(data);

    const switched = await store.readDb();
    assert.deepEqual(switched.events.filter((event) => event.isCurrent).map((event) => event.id), ["event-next"]);
    switched.events.find((event) => event.id === "wz-aerospace-2026").isCurrent = true;
    switched.events.find((event) => event.id === "event-next").isCurrent = false;
    switched.projects = switched.projects.filter((project) => project.id !== "project-removable");
    switched.projectGroups = switched.projectGroups.filter((group) => group.projectId !== "project-removable");
    await store.writeDb(switched);

    const persisted = await store.readDb();
    assert.deepEqual(persisted.events.filter((event) => event.isCurrent).map((event) => event.id), ["wz-aerospace-2026"]);
    assert.equal(persisted.projects.some((project) => project.id === "project-removable"), false);
    assert.equal((await pool.query("SELECT 1 FROM project_groups WHERE project_id = $1", ["project-removable"])).rowCount, 0);
  });
});

test("PostgreSQL restart preserves an administrator-selected project group subset", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const first = createPostgresStore(new Pool());
  let second;

  try {
    await first.initialize();
    const data = await first.readDb();
    const project = data.projects.find((row) => row.id === "rocket-duration");
    project.allowedGroups = ["小学低段"];
    data.projectGroups = data.projectGroups.filter((row) => row.projectId !== project.id);
    data.projectGroups.push({ projectId: project.id, groupName: "小学低段" });
    await first.writeDb(data);
    await first.close();

    second = createPostgresStore(new Pool());
    await second.initialize();
    await second.initialize();
    const restarted = await second.readDb();
    assert.deepEqual(restarted.projects.find((row) => row.id === project.id).allowedGroups, ["小学低段"]);
    assert.deepEqual(restarted.projectGroups.filter((row) => row.projectId === project.id), [
      { projectId: project.id, groupName: "小学低段" }
    ]);
  } finally {
    if (second) await second.close();
    else await first.close();
  }
});

test("PostgreSQL schema enforces unique phone and registration foreign keys", async () => {
  await withStore(async (_store, pool) => {
    await assert.rejects(
      pool.query(
        `INSERT INTO users (id, name, phone, password, type, status, created_at)
         VALUES ('UDUP', '重复手机号', '13800000001', 'x', 'ordinary', 'active', NOW())`
      )
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO registrations
          (id, event_id, source, user_id, organization_id, organization_name, athlete, athlete_key,
           group_name, project_id, project_name, project_type, instructor, status, reject_reason, created_at, updated_at)
         VALUES
          ('RBAD', 'wz-aerospace-2026', '普通用户', 'UNOPE', NULL, '', '{}', '', '',
           'paper-plane-gate', '', 'individual', '', 'pending', '', NOW(), NOW())`
      )
    );

    await assert.rejects(pool.query(`
      INSERT INTO events
        (id, name, theme, date_label, venue, registration_deadline, contact,
         registration_start_at, registration_end_at, registration_mode, status, is_current)
      VALUES
        ('duplicate-current', '重复当前赛事', '主题', '2027年', '场馆', '2027-01-01', '联系人',
         '2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'automatic', 'published', TRUE)
    `));
  });
});

test("PostgreSQL auth state atomically enforces limits and consumes challenges once across instances", async () => {
  await withStore(async (store, pool) => {
    const now = Date.parse("2026-07-17T00:00:00.000Z");
    const peer = createPostgresAuthState(pool);
    const states = [store.authState, peer];
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => states[index % 2].consumeRateLimits([
      { key: "login:ip:127.0.0.1", limit: 5, windowMs: 60_000 }
    ], now)));
    assert.equal(results.filter(Boolean).length, 5);

    for (let index = 0; index < 5; index += 1) {
      await states[index % 2].releaseRateLimits(["login:ip:127.0.0.1"], now);
    }
    const emptyBuckets = await pool.query("SELECT key FROM auth_rate_buckets WHERE key = $1", ["login:ip:127.0.0.1"]);
    assert.equal(emptyBuckets.rowCount, 0);

    await store.authState.saveChallenge({ phone: "13800000001", digest: "b".repeat(64), expiresAt: now + 300_000 });
    const consumed = await Promise.all(states.map((state) => state.consumeChallenge({
      phone: "13800000001", digest: "b".repeat(64), now, maxAttempts: 5
    })));
    assert.equal(consumed.filter(Boolean).length, 1);

    await peer.saveChallenge({ phone: "13800000002", digest: "c".repeat(64), expiresAt: now + 1 });
    await store.authState.consumeChallenge({ phone: "13800000003", digest: "d".repeat(64), now: now + 2, maxAttempts: 5 });
    const expired = await pool.query("SELECT phone FROM password_reset_challenges WHERE phone = $1", ["13800000002"]);
    assert.equal(expired.rowCount, 0);
  });
});

test("PostgreSQL auth state handles burst contention without surfacing storage conflicts", async () => {
  await withStore(async (_store, pool) => {
    const now = Date.parse("2026-07-17T00:00:00.000Z");
    const states = Array.from({ length: 10 }, () => createPostgresAuthState(pool));
    const settled = await Promise.allSettled(Array.from({ length: 50 }, (_, index) => states[index % states.length].consumeRateLimits([
      { key: "login:ip:burst", limit: 20, windowMs: 60_000 }
    ], now)));
    assert.equal(settled.every((result) => result.status === "fulfilled"), true);
    assert.equal(settled.filter((result) => result.status === "fulfilled" && result.value).length, 20);
  });
});

test("denied PostgreSQL requests do not retain empty buckets for rotating phone keys", async () => {
  await withStore(async (store, pool) => {
    const now = Date.parse("2026-07-17T00:00:00.000Z");
    assert.equal(await store.authState.consumeRateLimits([
      { key: "login:ip:saturated", limit: 1, windowMs: 60_000 }
    ], now), true);

    const states = Array.from({ length: 5 }, () => createPostgresAuthState(pool));
    const denied = await Promise.all(Array.from({ length: 25 }, (_, index) => states[index % states.length].consumeRateLimits([
      { key: `login:phone:rotating:${index}`, limit: 5, windowMs: 60_000 },
      { key: "login:ip:saturated", limit: 1, windowMs: 60_000 }
    ], now + 1)));
    assert.equal(denied.every((allowed) => allowed === false), true);

    const emptyPhones = await pool.query("SELECT key FROM auth_rate_buckets WHERE key LIKE 'login:phone:rotating:%'");
    assert.equal(emptyPhones.rowCount, 0);
  });
});

test("PostgreSQL store rejects invalid registration modes and project groups", async () => {
  await withStore(async (store) => {
    const invalidMode = await store.readDb();
    invalidMode.events[0].registrationMode = "manual";
    await assert.rejects(store.writeDb(invalidMode), /registration mode/i);

    const invalidGroup = await store.readDb();
    invalidGroup.projectGroups[0].groupName = "大学组";
    await assert.rejects(store.writeDb(invalidGroup), /project group/i);
  });
});

test("PostgreSQL store upgrades a legacy schema without losing existing records", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const store = createPostgresStore(pool);

  assert.equal(store.pool, pool);
  assert.equal(Object.getOwnPropertyDescriptor(store, "pool").writable, false);

  try {
    await pool.query(`
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, password TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, owner_user_id TEXT NOT NULL REFERENCES users(id), contact_name TEXT NOT NULL DEFAULT '', contact_phone TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE memberships (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), invited_phone TEXT, invited_name TEXT, organization_id TEXT NOT NULL REFERENCES organizations(id), role TEXT NOT NULL, status TEXT NOT NULL, direction TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, UNIQUE (user_id, organization_id));
      CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT NOT NULL, date_label TEXT NOT NULL, venue TEXT NOT NULL, registration_deadline TEXT NOT NULL, contact TEXT NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL);
      CREATE TABLE registrations (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), source TEXT NOT NULL, user_id TEXT REFERENCES users(id), organization_id TEXT REFERENCES organizations(id), organization_name TEXT NOT NULL DEFAULT '', athlete JSONB NOT NULL, athlete_key TEXT NOT NULL, group_name TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), project_name TEXT NOT NULL, project_type TEXT NOT NULL, instructor TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, reject_reason TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE results (registration_id TEXT PRIMARY KEY REFERENCES registrations(id) ON DELETE CASCADE, award_name TEXT NOT NULL DEFAULT '', rank TEXT NOT NULL DEFAULT '', score TEXT NOT NULL DEFAULT '', recorded_at TIMESTAMPTZ);
      CREATE TABLE certificates (id TEXT PRIMARY KEY, registration_id TEXT NOT NULL UNIQUE REFERENCES registrations(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id), organization_id TEXT REFERENCES organizations(id), certificate_no TEXT NOT NULL, file_name TEXT NOT NULL, stored_name TEXT NOT NULL, file_path TEXT NOT NULL, award_name TEXT NOT NULL DEFAULT '', rank TEXT NOT NULL DEFAULT '', score TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, uploaded_at TIMESTAMPTZ NOT NULL, published_at TIMESTAMPTZ);
    `);
    await pool.query(`
      INSERT INTO users VALUES ('ULEGACY', 'Legacy User', '13000000000', 'secret', 'ordinary', 'active', '2026-01-01T00:00:00.000Z');
      INSERT INTO organizations VALUES ('OLEGACY', 'Legacy Org', 'LEGACY', 'ULEGACY', 'Owner', '13000000000', 'active', '2026-01-01T00:00:00.000Z');
      INSERT INTO memberships VALUES ('MLEGACY', 'ULEGACY', NULL, NULL, 'OLEGACY', 'owner', 'active', 'system', 'legacy membership', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO events VALUES ('legacy-event', 'Administrator Edited Event', 'Legacy Theme', '2026-12-01', 'Legacy Venue', '2026-10-31', 'Legacy Contact');
      INSERT INTO projects VALUES ('legacy-project', 'legacy-event', 'Administrator Edited Project', 'individual', 'legacy');
      INSERT INTO registrations VALUES ('RLEGACY', 'legacy-event', 'legacy', 'ULEGACY', 'OLEGACY', 'Legacy Org', '{"name":"Legacy Athlete"}', 'legacy-key', '小学低段', 'legacy-project', 'Administrator Edited Project', 'individual', '', 'approved', '', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO results VALUES ('RLEGACY', '一等奖', '1', '99', '2026-01-03T00:00:00.000Z');
      INSERT INTO certificates VALUES ('CLEGACY', 'RLEGACY', 'ULEGACY', 'OLEGACY', 'LEGACY-001', 'legacy.pdf', 'legacy.pdf', '/legacy.pdf', '一等奖', '1', '99', 'published', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
    `);

    await store.initialize();
    const data = await store.readDb();
    const legacyEvent = data.events.find((event) => event.id === "legacy-event");
    const legacyProject = data.projects.find((project) => project.id === "legacy-project");
    const legacyRegistration = data.registrations.find((registration) => registration.id === "RLEGACY");

    assert.equal(data.users.some((user) => user.id === "ULEGACY"), true);
    assert.equal(data.organizations.some((organization) => organization.id === "OLEGACY"), true);
    assert.equal(data.memberships.some((membership) => membership.id === "MLEGACY"), true);
    assert.equal(legacyEvent.name, "Administrator Edited Event");
    assert.equal(legacyProject.name, "Administrator Edited Project");
    assert.equal(legacyProject.allowedGroups.length, 4);
    assert.equal(legacyRegistration.eventId, "legacy-event");
    assert.equal(legacyRegistration.awardName, "一等奖");
    assert.equal(data.certificates.some((certificate) => certificate.id === "CLEGACY"), true);
    assert.equal(data.events.filter((event) => event.isCurrent).length, 1);
  } finally {
    await store.close();
  }
});
