import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

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
    for (const name of ["users", "organizations", "memberships", "events", "projects", "project_groups", "registrations", "results", "certificates"]) {
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
  });
});
