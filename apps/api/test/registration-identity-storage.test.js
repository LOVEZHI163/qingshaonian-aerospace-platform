import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { createPostgresStore } from "../src/data/postgres-store.js";
import { ensureDbShape, seedDb } from "../src/data/seed.js";

async function withStore(fn) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const store = createPostgresStore(new Pool(), { testOnlyPgMemCompatibility: true });

  try {
    await store.initialize();
    await fn(store);
  } finally {
    await store.close();
  }
}

test("identity storage shape adds an empty registration identity collection", () => {
  const db = ensureDbShape({});

  assert.deepEqual(db.registrationIdentities, []);
});

test("identity storage shape rejects plaintext identity keys nested in athlete data", () => {
  for (const key of ["studentIdNumber", "identityNumber", "idCardNumber", "idCard"]) {
    const db = structuredClone(seedDb);
    db.registrations[0].athlete = { profile: { [key]: "330000200001010001" } };

    assert.throws(() => ensureDbShape(db), /identity field/i, key);
  }
});

test("identity storage round-trips encrypted registration identities through PostgreSQL", async () => {
  await withStore(async (store) => {
    const db = await store.readDb();
    const identity = {
      registrationId: db.registrations[0].id,
      ciphertext: "encrypted-identity",
      iv: "initialization-vector",
      authTag: "authentication-tag",
      keyVersion: 2,
      idFingerprint: "sha256-fingerprint",
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T01:00:00.000Z"
    };
    db.registrationIdentities.push(identity);

    await store.writeDb(db);

    assert.deepEqual((await store.readDb()).registrationIdentities, [identity]);
  });
});

test("identity storage upserts changed rows and removes omitted rows", async () => {
  await withStore(async (store) => {
    const db = await store.readDb();
    const identity = {
      registrationId: db.registrations[0].id,
      ciphertext: "first-ciphertext",
      iv: "first-iv",
      authTag: "first-tag",
      keyVersion: 1,
      idFingerprint: "first-fingerprint",
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z"
    };
    db.registrationIdentities.push(identity);
    await store.writeDb(db);

    identity.ciphertext = "updated-ciphertext";
    identity.keyVersion = 2;
    identity.updatedAt = "2026-08-07T01:00:00.000Z";
    await store.writeDb(db);
    assert.deepEqual((await store.readDb()).registrationIdentities, [identity]);

    db.registrationIdentities = [];
    await store.writeDb(db);
    assert.deepEqual((await store.readDb()).registrationIdentities, []);
  });
});
