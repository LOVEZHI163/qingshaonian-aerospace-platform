import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { newDb } from "pg-mem";

import * as mutationLock from "../src/data/mutation-lock.js";
import { createPostgresStore } from "../src/data/postgres-store.js";
import { createOrganizationsRouter } from "../src/routes/organizations.js";
import * as organizations from "../src/services/organizations.js";

class SingleConnectionPool {
  constructor(pool) {
    this.pool = pool;
    this.busy = false;
    this.waiters = [];
  }

  async connect() {
    if (this.busy) await new Promise((resolve) => this.waiters.push(resolve));
    this.busy = true;
    const client = await this.pool.connect();
    let released = false;
    return {
      query: client.query.bind(client),
      release: () => {
        if (released) return;
        released = true;
        client.release();
        const next = this.waiters.shift();
        if (next) next();
        else this.busy = false;
      }
    };
  }

  async query(...args) {
    const client = await this.connect();
    try {
      return await client.query(...args);
    } finally {
      client.release();
    }
  }

  end() {
    return this.pool.end();
  }
}

const withTimeout = (promise, milliseconds = 2_000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("operation timed out")), milliseconds))
]);

test("PostgreSQL mutations with pool size one bind all snapshot reads and writes to the advisory-lock client", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const first = createPostgresStore(new SingleConnectionPool(new Pool()));
  const second = createPostgresStore(new SingleConnectionPool(new Pool()));

  try {
    await first.initialize();
    await second.initialize();
    let firstAttempt = true;
    await assert.rejects(() => first.withMutationLock(async () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("handler failed");
      }
    }), /handler failed/);

    await withTimeout(Promise.all([
      first.withMutationLock(async () => {
        const db = await first.readDb();
        await new Promise((resolve) => setTimeout(resolve, 20));
        db.users.push({ id: "UFIRST", name: "First", phone: "13100000001", password: "x", type: "ordinary", status: "active", sessionVersion: 0, mustChangePassword: false, createdAt: "2026-07-17T00:00:00.000Z" });
        await first.writeDb(db);
      }),
      second.withMutationLock(async () => {
        const db = await second.readDb();
        db.users.push({ id: "USECOND", name: "Second", phone: "13100000002", password: "x", type: "ordinary", status: "active", sessionVersion: 0, mustChangePassword: false, createdAt: "2026-07-17T00:00:01.000Z" });
        await second.writeDb(db);
      })
    ]));

    const persisted = await first.readDb();
    assert.equal(persisted.users.some((row) => row.id === "UFIRST"), true);
    assert.equal(persisted.users.some((row) => row.id === "USECOND"), true);
  } finally {
    await first.close();
    await second.close();
  }
});

test("a mutating API completes with a PostgreSQL pool of one connection", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const store = createPostgresStore(new SingleConnectionPool(new Pool()));
  const app = express();
  app.use(express.json());
  app.use("/api", createOrganizationsRouter({
    store,
    requireUser: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    requirePasswordReady: (_req, _res, next) => next(),
    asyncRoute: mutationLock.createMutationAsyncRoute(store),
    hashPassword: async () => "hash",
    validatePassword: () => "",
    makeId: (prefix) => `${prefix}-POOL-ONE`,
    now: () => "2026-07-17T00:00:00.000Z",
    publicUser: ({ password, ...user }) => user
  }));
  let server;

  try {
    await store.initialize();
    server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    const response = await withTimeout(fetch(`http://127.0.0.1:${address.port}/api/auth/register/ordinary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "单连接用户", phone: "13100000003", password: "Strong123" })
    }));
    assert.equal(response.status, 201);
    assert.equal((await response.json()).user.id, "U-POOL-ONE");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await store.close();
  }
});

test("PostgreSQL advisory-lock errors outside the explicit pg-mem unsupported case are not downgraded", async () => {
  const denied = Object.assign(new Error("permission denied for function pg_advisory_lock"), { code: "42501" });
  let released = false;
  let denyLock = true;
  const pool = {
    async connect() {
      return {
        async query() {
          if (denyLock) throw denied;
          return { rows: [], rowCount: 1 };
        },
        release() { released = true; }
      };
    },
    async end() {}
  };
  const store = createPostgresStore(pool);

  await assert.rejects(() => store.withMutationLock(async () => {
    assert.fail("handler must not run without the advisory lock");
  }), (error) => error === denied);
  assert.equal(released, true);
  denyLock = false;
  await store.withMutationLock(async () => {});
});

test("mutation-aware route wrapper releases its lock after handler errors and early response close", async () => {
  assert.equal(typeof mutationLock.createMutationAsyncRoute, "function");
  let active = false;
  const store = {
    async withMutationLock(handler) {
      assert.equal(active, false);
      active = true;
      try { return await handler(); } finally { active = false; }
    }
  };
  const route = mutationLock.createMutationAsyncRoute(store);
  const invoke = (handler, { close = false } = {}) => new Promise((resolve) => {
    const req = { method: "POST", aborted: false };
    const res = new EventEmitter();
    res.destroyed = false;
    route(handler)(req, res, (error) => resolve(error));
    if (close) {
      res.destroyed = true;
      res.emit("close");
      setTimeout(() => resolve(), 10);
    }
  });

  const expected = new Error("route failed");
  assert.equal(await invoke(async () => { throw expected; }), expected);
  assert.equal(active, false);
  await invoke(() => new Promise(() => {}), { close: true });
  assert.equal(active, false);
  const completed = await new Promise((resolve) => {
    const req = { method: "POST", aborted: false };
    const res = new EventEmitter();
    route(async () => resolve(true))(req, res, resolve);
  });
  assert.equal(completed, true);
});

test("cleanup journal replay removes orphan files and markers but never deletes referenced documents", async () => {
  assert.equal(typeof organizations.replayFileCleanupJournal, "function");
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-replay-"));
  const previousRoot = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = uploadRoot;
  const orphanPath = path.join(uploadRoot, "organization-documents", "O1", "orphan.pdf");
  const referencedPath = path.join(uploadRoot, "organization-documents", "O1", "current.pdf");
  await fs.mkdir(path.dirname(orphanPath), { recursive: true });
  await fs.writeFile(orphanPath, "orphan");
  await fs.writeFile(referencedPath, "current");
  let db = {
    organizationDocuments: [
      { id: "DOC-OLD-CLEANED", organizationId: "O0", filePath: referencedPath, cleanedAt: "2026-07-16T00:00:00.000Z" },
      { id: "DOC-CURRENT", organizationId: "O1", filePath: referencedPath, cleanedAt: null }
    ],
    organizations: [{ id: "O1", currentDocumentId: "DOC-CURRENT" }],
    certificates: [],
    fileCleanupJournal: [
      { id: "CLN-ORPHAN", filePath: orphanPath, category: "organization-documents", attempts: 3, lastError: "old", createdAt: "2026-07-17T00:00:00.000Z" },
      { id: "CLN-CURRENT", filePath: referencedPath, category: "organization-documents", attempts: 3, lastError: "old", createdAt: "2026-07-17T00:00:00.000Z" }
    ]
  };
  const store = {
    withMutationLock: (handler) => handler(),
    readDb: async () => structuredClone(db),
    writeDb: async (next) => { db = structuredClone(next); }
  };

  try {
    await organizations.replayFileCleanupJournal({ store, now: () => "2026-07-17T01:00:00.000Z" });
    await assert.rejects(fs.access(orphanPath));
    await fs.access(referencedPath);
    assert.equal(db.fileCleanupJournal.some((row) => row.id === "CLN-ORPHAN"), false);
    assert.equal(db.fileCleanupJournal.some((row) => row.id === "CLN-CURRENT"), true);
  } finally {
    if (previousRoot === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previousRoot;
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
});

test("cleanup journal replay retains failed markers and updates their attempt metadata", async () => {
  const failedPath = path.join(os.tmpdir(), `cleanup-failed-${Date.now()}.pdf`);
  const attemptedAt = "2026-07-17T02:00:00.000Z";
  let db = {
    organizationDocuments: [], organizations: [], certificates: [],
    fileCleanupJournal: [{ id: "CLN-FAILED", filePath: failedPath, category: "organization-documents", attempts: 3, lastError: "old", createdAt: "2026-07-17T00:00:00.000Z" }]
  };
  const store = {
    withMutationLock: (handler) => handler(),
    readDb: async () => structuredClone(db),
    writeDb: async (next) => { db = structuredClone(next); }
  };

  const result = await organizations.replayFileCleanupJournal({
    store,
    removePrivateFile: async () => { throw new Error("disk unavailable"); },
    now: () => attemptedAt
  });
  assert.deepEqual(result, { removed: 0, retained: 1 });
  assert.equal(db.fileCleanupJournal[0].attempts, 4);
  assert.equal(db.fileCleanupJournal[0].lastAttemptAt, attemptedAt);
  assert.equal(db.fileCleanupJournal[0].lastError, "disk unavailable");
});
