import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";

import { createPostgresStore } from "../src/data/postgres-store.js";
import { PROJECT_GROUPS, PROJECTS } from "../src/data/seed.js";
import {
  executeTestBusinessCleanup,
  previewTestBusinessCleanup
} from "../src/services/test-business-cleanup.js";
import { runCleanupCommand } from "../src/cli/cleanup-test-business-data.js";

async function withFixture(fn) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const store = createPostgresStore(pool, { seedOnEmpty: false, testOnlyPgMemCompatibility: true });
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-test-business-cleanup-"));

  try {
    await store.initialize();
    const certificatePath = path.join(uploadRoot, "certificates", "R1", "slot-1.png");
    const documentPath = path.join(uploadRoot, "organization-credentials", "O1", "license.png");
    const siteMediaPath = path.join(uploadRoot, "site-media", "M1", "original.webp");
    await Promise.all([certificatePath, documentPath, siteMediaPath].map(async (filePath) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "fixture");
    }));

    await pool.query(`
      INSERT INTO users (id, name, phone, password, type, status, created_at) VALUES
        ('U1', 'User 1', '13600000001', 'hash', 'ordinary', 'active', NOW()),
        ('U2', 'User 2', '13600000002', 'hash', 'organization', 'active', NOW()),
        ('U3', 'User 3', '13600000003', 'hash', 'admin', 'active', NOW())
    `);
    await pool.query(`
      INSERT INTO organizations (id, name, code, owner_user_id, status, created_at)
      VALUES ('O1', 'Organization', 'ORG-1', 'U2', 'active', NOW())
    `);
    await pool.query(`
      INSERT INTO memberships (id, user_id, organization_id, role, status, direction, created_at, updated_at)
      VALUES ('MB1', 'U1', 'O1', 'member', 'active', 'user_request', NOW(), NOW())
    `);
    await pool.query(`
      INSERT INTO organization_event_participations (organization_id, event_id, joined_by_user_id)
      VALUES ('O1', 'wz-aerospace-2026', 'U2')
    `);
    await pool.query(`
      INSERT INTO registrations
        (id, event_id, source, created_by_user_id, personal_user_id, organization_id, created_via,
         athlete, athlete_key, group_name, project_id, project_name, project_type, status, created_at, updated_at)
      VALUES
        ('R1', 'wz-aerospace-2026', 'fixture', 'U1', 'U1', 'O1', 'personal',
         '{}', 'athlete-1', '小学低段', 'paper-plane-gate', 'Paper plane', 'individual', 'approved', NOW(), NOW()),
        ('R2', 'wz-aerospace-2026', 'fixture', 'U2', NULL, 'O1', 'organization',
         '{}', 'athlete-2', '小学低段', 'rocket-duration', 'Rocket', 'individual', 'approved', NOW(), NOW())
    `);
    await pool.query(`
      INSERT INTO certificates (id, registration_id, file_name, stored_name, file_path, uploaded_at)
      VALUES ('C1', 'R1', 'slot-1.png', 'slot-1.png', $1, NOW())
    `, [certificatePath]);
    await pool.query(`
      INSERT INTO organization_documents
        (id, organization_id, document_type, original_name, stored_name, file_path, mime_type, size_bytes, uploaded_at)
      VALUES ('D1', 'O1', 'license', 'license.png', 'license.png', $1, 'image/png', 7, NOW())
    `, [documentPath]);
    await fn({ pool, uploadRoot, certificatePath, documentPath, siteMediaPath });
  } finally {
    await store.close();
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
}

test("cleanup removes test business data and preserves public event configuration", async () => {
  await withFixture(async ({ pool, uploadRoot, certificatePath, documentPath, siteMediaPath }) => {
    const preview = await previewTestBusinessCleanup(pool);
    assert.deepEqual(preview.preserved, {
      events: 1,
      projects: PROJECTS.length,
      projectGroups: PROJECT_GROUPS.length,
      siteSettings: 1,
      eventPublicProfiles: 0,
      contentPosts: 0,
      mediaAssets: 0,
      contentAttachments: 0
    });
    assert.equal(preview.deleted.users, 3);
    assert.equal(preview.deleted.registrations, 2);
    assert.equal(preview.files, 2);

    const result = await executeTestBusinessCleanup(pool, uploadRoot);
    assert.equal(result.deleted.users, 3);
    assert.equal((await pool.query("SELECT COUNT(*)::int count FROM events")).rows[0].count, 1);
    assert.equal((await pool.query("SELECT COUNT(*)::int count FROM projects")).rows[0].count, PROJECTS.length);
    assert.equal((await pool.query("SELECT COUNT(*)::int count FROM users")).rows[0].count, 0);
    assert.equal(await fs.stat(siteMediaPath).then(() => true, () => false), true);
    assert.equal(await fs.stat(certificatePath).then(() => true, () => false), false);
    assert.equal(await fs.stat(documentPath).then(() => true, () => false), false);

    const second = await executeTestBusinessCleanup(pool, uploadRoot);
    assert.equal(second.deleted.users, 0);
  });
});

test("cleanup records failed file removal after committing database data", async () => {
  await withFixture(async ({ pool, uploadRoot, certificatePath }) => {
    const fileSystem = {
      rm: async () => { throw new Error("simulated file removal failure"); }
    };
    let marker = 0;
    await executeTestBusinessCleanup(pool, uploadRoot, {
      fileSystem,
      now: () => "2026-07-30T00:00:00.000Z",
      makeId: () => `FCJ-${++marker}`
    });

    assert.equal((await pool.query("SELECT COUNT(*)::int count FROM users")).rows[0].count, 0);
    const journal = await pool.query("SELECT file_path, category, last_error FROM file_cleanup_journal");
    assert.equal(journal.rowCount, 2);
    assert.equal(journal.rows.every((row) => row.category === "test-business-cleanup"), true);
    assert.equal(journal.rows.every((row) => row.last_error.includes("simulated file removal failure")), true);
    assert.equal(await fs.stat(certificatePath).then(() => true, () => false), true);
  });
});

test("cleanup safely skips the pre-migration participation table", async () => {
  await withFixture(async ({ pool, uploadRoot }) => {
    await pool.query("DROP TABLE organization_event_participations");
    const preview = await previewTestBusinessCleanup(pool);
    assert.equal(Object.hasOwn(preview.deleted, "organization_event_participations"), false);
    await executeTestBusinessCleanup(pool, uploadRoot);
    assert.equal((await pool.query("SELECT COUNT(*)::int count FROM users")).rows[0].count, 0);
  });
});

test("cleanup command previews by default and needs the exact confirmation token", async () => {
  await withFixture(async ({ pool, uploadRoot }) => {
    let output = "";
    const preview = await runCleanupCommand({
      client: pool,
      uploadRoot,
      args: [],
      write: (chunk) => { output += chunk; }
    });
    assert.equal(preview.executed, false);
    assert.match(output, /Preview only\. No data was deleted\./);
    assert.equal((await pool.query("SELECT COUNT(*)::int count FROM users")).rows[0].count, 3);

    const executed = await runCleanupCommand({
      client: pool,
      uploadRoot,
      args: ["--confirm=DELETE-TEST-BUSINESS-DATA"],
      write: () => {}
    });
    assert.equal(executed.executed, true);
    assert.equal((await pool.query("SELECT COUNT(*)::int count FROM users")).rows[0].count, 0);
  });
});
