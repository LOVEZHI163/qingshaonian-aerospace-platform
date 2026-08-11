import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { newDb } from "pg-mem";

import * as mutationLock from "../src/data/mutation-lock.js";
import { requireAdmin, requirePasswordReady } from "../src/auth/session.js";
import { resetUserTemporaryPassword } from "../src/services/account-passwords.js";
import { createFileStore } from "../src/data/file-store.js";
import { createPostgresStore } from "../src/data/postgres-store.js";
import { createOrganizationsRouter } from "../src/routes/organizations.js";
import { createSiteContentImportRouter } from "../src/routes/site-content-imports.js";
import * as organizations from "../src/services/organizations.js";

test("content import mutations use the locked route wrapper while reads remain unlocked", () => {
  const registrations = [];
  const capture = (kind) => (handler) => {
    registrations.push({ kind, handler });
    return handler;
  };
  const router = createSiteContentImportRouter({
    store: { readDb: async () => ({ siteContentImportBatches: [] }) },
    requireAdmin: (_req, _res, next) => next(),
    requirePasswordReady: (_req, _res, next) => next(),
    asyncRoute: capture("read"),
    mutationAsyncRoute: capture("mutation"),
    makeId: () => "ID",
    now: () => "2026-08-11T00:00:00.000Z"
  });

  assert.ok(router);
  assert.equal(registrations.filter((entry) => entry.kind === "mutation").length, 5);
  assert.equal(registrations.filter((entry) => entry.kind === "read").length, 2);
});

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

test("a queued authenticated mutation revalidates the session inside the lock after an administrator reset", async () => {
  const admin = {
    id: "U-STALE-ADMIN", name: "Queued Admin", phone: "13900000099", password: "hash",
    type: "admin", status: "active", sessionVersion: 0, mustChangePassword: false
  };
  const db = { users: [admin], sentinelWrites: 0 };
  let releaseQueued;
  const store = {
    readDb: async () => db,
    withMutationLock(handler) {
      return new Promise((resolve, reject) => {
        releaseQueued = () => Promise.resolve(handler()).then(resolve, reject);
      });
    }
  };
  const route = mutationLock.createMutationAsyncRoute(store);
  const req = {
    method: "POST", aborted: false,
    user: { ...admin },
    session: { userId: admin.id, sessionVersion: 0 }
  };
  const res = new EventEmitter();
  res.destroyed = false;
  let requestPromise;
  let forwarded;

  requireAdmin(req, res, () => requirePasswordReady(req, res, () => {
    requestPromise = route(async () => { db.sentinelWrites += 1; })(req, res, (error) => { forwarded = error; });
  }));
  assert.equal(typeof releaseQueued, "function");

  // A password reset wins while the already-authorized write is waiting.
  await resetUserTemporaryPassword(db, admin, {
    vault: {
      generate: () => "GeneratedPass2",
      seal: () => ({ ciphertext: "sealed", iv: "iv", tag: "tag" })
    },
    hashPassword: async () => "new-hash",
    now: () => "2026-08-06T00:00:00.000Z"
  });
  await releaseQueued();
  await requestPromise;

  assert.equal(db.sentinelWrites, 0);
  assert.equal(forwarded?.status, 401);
  assert.equal(forwarded?.code, "SESSION_INVALIDATED");
});

test("a queued password-ready mutation rechecks mustChangePassword inside the lock", async () => {
  const user = {
    id: "U-FORCED", name: "Forced User", phone: "13800000099", password: "hash",
    type: "ordinary", status: "active", sessionVersion: 0, mustChangePassword: false
  };
  const db = { users: [user], sentinelWrites: 0 };
  let releaseQueued;
  const store = {
    readDb: async () => db,
    withMutationLock(handler) {
      return new Promise((resolve, reject) => {
        releaseQueued = () => Promise.resolve(handler()).then(resolve, reject);
      });
    }
  };
  const route = mutationLock.createMutationAsyncRoute(store);
  const req = {
    method: "PATCH", aborted: false,
    user: { ...user },
    session: { userId: user.id, sessionVersion: 0 }
  };
  const res = new EventEmitter();
  res.destroyed = false;
  let requestPromise;
  let forwarded;

  requirePasswordReady(req, res, () => {
    requestPromise = route(async () => { db.sentinelWrites += 1; })(req, res, (error) => { forwarded = error; });
  });
  user.mustChangePassword = true;
  await releaseQueued();
  await requestPromise;

  assert.equal(db.sentinelWrites, 0);
  assert.equal(forwarded?.status, 428);
  assert.equal(forwarded?.code, "PASSWORD_CHANGE_REQUIRED");
});

test("an unauthenticated public mutation is not subjected to password-ready revalidation", async () => {
  const store = {
    readDb: async () => ({ users: [] }),
    withMutationLock: (handler) => handler()
  };
  const route = mutationLock.createMutationAsyncRoute(store);
  const req = { method: "POST", aborted: false, session: {} };
  const res = new EventEmitter();
  res.destroyed = false;
  let executed = false;
  let forwarded;

  await route(async () => { executed = true; })(req, res, (error) => { forwarded = error; });

  assert.equal(executed, true);
  assert.ifError(forwarded);
});

for (const [label, changeUser, expectedStatus, expectedCode] of [
  ["disabled account", (user) => { user.status = "disabled"; }, 401, "SESSION_INVALIDATED"],
  ["lost administrator role", (user) => { user.type = "ordinary"; }, 403, "ADMIN_REQUIRED"]
]) test(`a queued administrator mutation rejects a ${label} inside the lock`, async () => {
  const user = {
    id: "U-ADMIN-RECHECK", name: "Queued Admin", phone: "13900000098", password: "hash",
    type: "admin", status: "active", sessionVersion: 0, mustChangePassword: false
  };
  const db = { users: [user], sentinelWrites: 0 };
  let releaseQueued;
  const store = {
    readDb: async () => db,
    withMutationLock(handler) {
      return new Promise((resolve, reject) => {
        releaseQueued = () => Promise.resolve(handler()).then(resolve, reject);
      });
    }
  };
  const route = mutationLock.createMutationAsyncRoute(store);
  const req = {
    method: "DELETE", aborted: false,
    user: { ...user },
    session: { userId: user.id, sessionVersion: 0 }
  };
  const res = new EventEmitter();
  res.destroyed = false;
  let requestPromise;
  let forwarded;

  requireAdmin(req, res, () => requirePasswordReady(req, res, () => {
    requestPromise = route(async () => { db.sentinelWrites += 1; })(req, res, (error) => { forwarded = error; });
  }));
  changeUser(user);
  await releaseQueued();
  await requestPromise;

  assert.equal(db.sentinelWrites, 0);
  assert.equal(forwarded?.status, expectedStatus);
  assert.equal(forwarded?.code, expectedCode);
});

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

test("response close keeps the mutation lock until its running handler settles", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mutation-close-"));
  const store = createFileStore(path.join(tempDir, "db.json"));
  const route = mutationLock.createMutationAsyncRoute(store);
  let resumeFirst;
  let markFirstStarted;
  let markFirstFinished;
  const firstMayFinish = new Promise((resolve) => { resumeFirst = resolve; });
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstFinished = new Promise((resolve) => { markFirstFinished = resolve; });
  let secondStarted = false;
  let firstError;
  let secondError;

  const firstReq = { method: "POST", aborted: false };
  const firstRes = new EventEmitter();
  firstRes.destroyed = false;
  const firstRequest = route(async () => {
    try {
      const db = await store.readDb();
      markFirstStarted();
      await firstMayFinish;
      db.users.push({ id: "U-CLOSE-FIRST", name: "First", phone: "13100000011", password: "x", type: "ordinary", status: "active", sessionVersion: 0, mustChangePassword: false, createdAt: "2026-07-17T00:00:00.000Z" });
      await store.writeDb(db);
    } finally {
      markFirstFinished();
    }
  })(firstReq, firstRes, (error) => { firstError = error; });

  try {
    await firstStarted;
    firstRes.destroyed = true;
    firstRes.emit("close");

    const secondReq = { method: "POST", aborted: false };
    const secondRes = new EventEmitter();
    secondRes.destroyed = false;
    const secondRequest = route(async () => {
      secondStarted = true;
      const db = await store.readDb();
      db.users.push({ id: "U-CLOSE-SECOND", name: "Second", phone: "13100000012", password: "x", type: "ordinary", status: "active", sessionVersion: 0, mustChangePassword: false, createdAt: "2026-07-17T00:00:01.000Z" });
      await store.writeDb(db);
    })(secondReq, secondRes, (error) => { secondError = error; });

    await new Promise((resolve) => setImmediate(resolve));
    const secondWaited = !secondStarted;
    resumeFirst();
    await Promise.all([firstRequest, firstFinished, secondRequest]);

    assert.equal(secondWaited, true);
    assert.ifError(firstError);
    assert.ifError(secondError);
    const persisted = await store.readDb();
    assert.equal(persisted.users.some((user) => user.id === "U-CLOSE-FIRST"), true);
    assert.equal(persisted.users.some((user) => user.id === "U-CLOSE-SECOND"), true);
  } finally {
    resumeFirst();
    await firstFinished;
    await store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("mutation handler errors release the lock for the next request", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mutation-error-"));
  const store = createFileStore(path.join(tempDir, "db.json"));
  const route = mutationLock.createMutationAsyncRoute(store);
  const expected = new Error("route failed");
  let forwarded;

  try {
    const failedReq = { method: "POST", aborted: false };
    const failedRes = new EventEmitter();
    failedRes.destroyed = false;
    await route(async () => { throw expected; })(failedReq, failedRes, (error) => { forwarded = error; });
    assert.equal(forwarded, expected);

    const nextReq = { method: "POST", aborted: false };
    const nextRes = new EventEmitter();
    nextRes.destroyed = false;
    await route(async () => {
      const db = await store.readDb();
      db.users.push({ id: "U-AFTER-ERROR", name: "Recovered", phone: "13100000013", password: "x", type: "ordinary", status: "active", sessionVersion: 0, mustChangePassword: false, createdAt: "2026-07-17T00:00:00.000Z" });
      await store.writeDb(db);
    })(nextReq, nextRes, (error) => { throw error; });
    assert.equal((await store.readDb()).users.some((user) => user.id === "U-AFTER-ERROR"), true);
  } finally {
    await store.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("file store keeps the original JSON and removes its temporary file when atomic rename fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-file-store-"));
  const dbPath = path.join(tempDir, "db.json");
  const original = '{"sentinel":"original"}\n';
  await fs.writeFile(dbPath, original, "utf8");
  const failingFileSystem = {
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rm: fs.rm,
    async rename() {
      const error = new Error("simulated atomic rename failure");
      error.code = "EPERM";
      throw error;
    }
  };
  const store = createFileStore(dbPath, {
    fileSystem: failingFileSystem,
    makeTempPath: () => path.join(tempDir, ".db.json.atomic-test.tmp")
  });

  try {
    await assert.rejects(store.writeDb({ users: [] }), /simulated atomic rename failure/);
    assert.equal(await fs.readFile(dbPath, "utf8"), original);
    await assert.rejects(fs.access(path.join(tempDir, ".db.json.atomic-test.tmp")), { code: "ENOENT" });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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

test("cleanup journal safely replays imported-content staging directories", async () => {
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "content-import-cleanup-"));
  const previousRoot = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = uploadRoot;
  const staging = path.join(uploadRoot, "site-content-import-staging", "SCI-SAFE");
  const outside = path.join(uploadRoot, "must-remain.txt");
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, "image.png"), "image");
  await fs.writeFile(outside, "safe");
  let db = {
    organizationDocuments: [], organizations: [], certificates: [],
    fileCleanupJournal: [
      { id: "CLN-STAGING", filePath: staging, category: "site-content-import-staging", attempts: 0, lastError: "pending", createdAt: "2026-08-11T00:00:00.000Z" },
      { id: "CLN-ESCAPE", filePath: outside, category: "site-content-import-staging", attempts: 0, lastError: "pending", createdAt: "2026-08-11T00:00:00.000Z" }
    ]
  };
  const store = {
    withMutationLock: (handler) => handler(),
    readDb: async () => structuredClone(db),
    writeDb: async (next) => { db = structuredClone(next); }
  };

  try {
    const result = await organizations.replayFileCleanupJournal({ store, now: () => "2026-08-11T01:00:00.000Z" });
    assert.deepEqual(result, { removed: 1, retained: 1 });
    await assert.rejects(fs.access(staging));
    await fs.access(outside);
    assert.deepEqual(db.fileCleanupJournal.map((row) => row.id), ["CLN-ESCAPE"]);
    assert.equal(db.fileCleanupJournal[0].attempts, 1);
  } finally {
    if (previousRoot === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previousRoot;
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
});
