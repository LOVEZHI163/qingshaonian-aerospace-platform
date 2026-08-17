import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { createAccountEmailTokenStore } from "../src/data/account-email-tokens.js";
import { createPostgresStore } from "../src/data/postgres-store.js";

function createMemoryStore() {
  let db = { accountEmailTokens: [] };
  let tail = Promise.resolve();
  return createAccountEmailTokenStore({
    readDb: async () => structuredClone(db),
    writeDb: async (next) => { db = structuredClone(next); },
    withMutationLock: async (handler) => {
      let release;
      const previous = tail;
      tail = new Promise((resolve) => { release = resolve; });
      await previous;
      try { return await handler(); } finally { release(); }
    }
  });
}

const base = {
  userId: "U1",
  targetEmail: "a@example.com",
  requestIp: "127.0.0.1",
  createdAt: "2026-08-17T10:00:00.000Z",
  expiresAt: "2026-08-17T10:10:00.000Z"
};
const now = "2026-08-17T10:05:00.000Z";

async function verifySemantics(store, userId = "U1") {
  const input = { ...base, userId };
  await store.replace({ ...input, purpose: "reset_password", digest: "d1" });
  await store.replace({ ...input, purpose: "verify_email", digest: "v1" });
  await store.replace({ ...input, purpose: "reset_password", digest: "d2" });

  assert.equal(await store.inspect({ digest: "d1", purpose: "reset_password", now }), null);
  assert.equal(await store.inspect({ digest: "v1", purpose: "reset_password", now }), null);
  assert.equal((await store.inspect({ digest: "v1", purpose: "verify_email", now })).targetEmail, "a@example.com");

  const consumed = await Promise.all([
    store.consume({ digest: "d2", purpose: "reset_password", now }),
    store.consume({ digest: "d2", purpose: "reset_password", now })
  ]);
  assert.equal(consumed.filter(Boolean).length, 1);
  assert.equal(consumed.find(Boolean).userId, userId);
  assert.equal(await store.inspect({ digest: "d2", purpose: "reset_password", now }), null);

  await store.replace({ ...input, purpose: "reset_password", digest: "expired", expiresAt: "2026-08-17T10:04:59.000Z" });
  assert.equal(await store.consume({ digest: "expired", purpose: "reset_password", now }), null);
  await store.revokeUserPurpose(userId, "verify_email");
  assert.equal(await store.inspect({ digest: "v1", purpose: "verify_email", now }), null);
  await store.replace({ ...input, purpose: "reset_password", digest: "older" });
  await store.replace({ ...input, purpose: "reset_password", digest: "newer" });
  await store.revokeDigest("older", "reset_password");
  assert.equal((await store.inspect({ digest: "newer", purpose: "reset_password", now })).digest, "newer");
}

test("file account email token store replaces, expires, separates purpose, and consumes once", async () => {
  await verifySemantics(createMemoryStore());
});

test("PostgreSQL account email token store consumes atomically", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const dataStore = createPostgresStore(pool);
  await dataStore.initialize();
  try {
    await verifySemantics(createAccountEmailTokenStore({ pool }), "U1001");
  } finally {
    await dataStore.close();
  }
});
