import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDataStore } from "../src/data/index.js";
import { seedDb } from "../src/data/seed.js";

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
