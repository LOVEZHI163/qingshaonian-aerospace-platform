import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { createPostgresStore } from "../src/data/postgres-store.js";
import { ensureDbShape } from "../src/data/seed.js";

test("certificate JSON migration keeps slot 2 and safely normalizes invalid legacy slots to 1", () => {
  const db = ensureDbShape({
    certificates: [
      { id: "C-LEGACY-EMPTY", awardName: "", slot: 0 },
      { id: "C-LEGACY-TWO", awardName: "二等奖", slot: 2 },
      { id: "C-LEGACY-INVALID", awardName: "", slot: 3 }
    ]
  });

  assert.deepEqual(db.certificates.map((certificate) => certificate.slot), [1, 2, 1]);
});

test("certificate schema migrates legacy certificates to slot 1 and permits one second slot", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const store = createPostgresStore(pool, { testOnlyPgMemCompatibility: true });

  try {
    await store.initialize();
    await pool.query(`
      INSERT INTO certificates
        (id, registration_id, slot, title, file_name, stored_name, file_path, source, uploaded_at)
      VALUES ('C-STATUS-DEFAULT', 'R20260627002', 1, '默认状态', 'default.png', 'default.png', '/tmp/default.png', 'manual', NOW())
    `);
    const status = await pool.query("SELECT status FROM certificates WHERE id = 'C-STATUS-DEFAULT'");
    assert.equal(status.rows[0].status, "draft");

    await assert.rejects(pool.query(`
      INSERT INTO certificates
        (id, registration_id, slot, title, file_name, stored_name, file_path, status, source, uploaded_at)
      VALUES ('C-INVALID-SLOT', 'R20260627002', 3, '非法槽位', 'invalid.png', 'invalid.png', '/tmp/invalid.png', 'draft', 'manual', NOW())
    `));

    const legacy = await store.readDb();
    legacy.certificates.push({
      id: "C-SLOT-1",
      registrationId: "R20260627001",
      fileName: "one.png",
      storedName: "one.png",
      filePath: "/tmp/one.png",
      awardName: "优秀选手",
      rank: "",
      score: "",
      status: "draft",
      uploadedAt: "2026-06-27T00:00:00.000Z",
      publishedAt: ""
    });
    await store.writeDb(legacy);

    await pool.query(`
      INSERT INTO certificates
        (id, registration_id, slot, title, file_name, stored_name, file_path,
         award_name, rank, score, status, source, uploaded_at)
      VALUES
        ('C-SLOT-2', 'R20260627001', 2, '优秀选手', 'two.png', 'two.png', '/tmp/two.png',
         '优秀选手', '', '', 'draft', 'manual', NOW())
    `);
    await assert.rejects(pool.query(`
      INSERT INTO certificates
        (id, registration_id, slot, title, file_name, stored_name, file_path, status, source, uploaded_at)
      VALUES ('C-DUP', 'R20260627001', 2, '重复', 'dup.png', 'dup.png', '/tmp/dup.png', 'draft', 'manual', NOW())
    `));

    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('certificate_import_batches', 'certificate_import_errors')
    `);
    assert.deepEqual(tables.rows.map((row) => row.table_name).sort(), ["certificate_import_batches", "certificate_import_errors"]);

    const persisted = await store.readDb();
    assert.deepEqual(persisted.certificates
      .filter((certificate) => certificate.registrationId === "R20260627001")
      .map((certificate) => ({ id: certificate.id, slot: certificate.slot, title: certificate.title }))
      .sort((left, right) => left.slot - right.slot), [
      { id: "C-SLOT-1", slot: 1, title: "优秀选手" },
      { id: "C-SLOT-2", slot: 2, title: "优秀选手" }
    ]);
  } finally {
    await store.close();
  }
});
