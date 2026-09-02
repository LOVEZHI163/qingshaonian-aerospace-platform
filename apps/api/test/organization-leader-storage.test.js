import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { createPostgresStore } from "../src/data/postgres-store.js";
import { ensureDbShape } from "../src/data/seed.js";

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

test("leader storage shape adds empty leader collections", () => {
  const db = ensureDbShape({});

  assert.deepEqual(db.organizationLeaders, []);
  assert.deepEqual(db.organizationLeaderDocuments, []);
  assert.deepEqual(db.organizationLeaderReviews, []);
});

test("leader storage round-trips leaders, private documents, and review snapshots through PostgreSQL", async () => {
  await withStore(async (store) => {
    const db = await store.readDb();
    const now = "2026-08-07T00:00:00.000Z";
    const document = {
      id: "leader-document-1",
      leaderId: "leader-1",
      version: 1,
      originalName: "leader-id.pdf",
      storedName: "leader-id-private.pdf",
      filePath: "/private/leader-id-private.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      uploadedAt: now,
      cleanedAt: null
    };
    const leader = {
      id: "leader-1",
      organizationId: db.organizations[0].id,
      name: "李领队",
      phone: "13800009999",
      email: "leader@example.com",
      notes: "校队领队",
      currentDocumentId: document.id,
      reviewStatus: "approved",
      rejectionReason: "",
      enabled: true,
      submissionVersion: 1,
      reviewedBy: db.users.at(-1).id,
      reviewedAt: now,
      createdAt: now,
      updatedAt: now
    };
    const review = {
      id: "leader-review-1",
      leaderId: leader.id,
      organizationId: leader.organizationId,
      submissionVersion: 1,
      action: "approved",
      actorId: leader.reviewedBy,
      reason: "",
      snapshot: { reviewStatus: "approved", enabled: true },
      documentId: document.id,
      createdAt: now
    };
    db.organizationLeaders.push(leader);
    db.organizationLeaderDocuments.push(document);
    db.organizationLeaderReviews.push(review);

    await store.writeDb(db);

    const persisted = await store.readDb();
    assert.deepEqual(persisted.organizationLeaders, [leader]);
    assert.deepEqual(persisted.organizationLeaderDocuments, [document]);
    assert.deepEqual(persisted.organizationLeaderReviews, [review]);
  });
});

test("leader storage upserts changes, removes omitted rows, and rolls back an invalid review", async () => {
  await withStore(async (store) => {
    const db = await store.readDb();
    const now = "2026-08-07T00:00:00.000Z";
    const leader = {
      id: "leader-update-1",
      organizationId: db.organizations[0].id,
      name: "初始领队",
      phone: "13800008888",
      email: "",
      notes: "",
      currentDocumentId: "leader-update-document-1",
      reviewStatus: "pending",
      rejectionReason: "",
      enabled: true,
      submissionVersion: 1,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now
    };
    const document = {
      id: "leader-update-document-1",
      leaderId: leader.id,
      version: 1,
      originalName: "leader-id.pdf",
      storedName: "leader-id-v1.pdf",
      filePath: "/private/leader-id-v1.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      uploadedAt: now,
      cleanedAt: null
    };
    const review = {
      id: "leader-update-review-1",
      leaderId: leader.id,
      organizationId: leader.organizationId,
      submissionVersion: 1,
      action: "submitted",
      actorId: null,
      reason: null,
      snapshot: { reviewStatus: "pending", enabled: true },
      documentId: document.id,
      createdAt: now
    };
    db.organizationLeaders.push(leader);
    db.organizationLeaderDocuments.push(document);
    db.organizationLeaderReviews.push(review);
    await store.writeDb(db);

    leader.name = "更新领队";
    leader.submissionVersion = 2;
    leader.updatedAt = "2026-08-07T01:00:00.000Z";
    document.storedName = "leader-id-v2.pdf";
    document.filePath = "/private/leader-id-v2.pdf";
    review.submissionVersion = 2;
    review.action = "approved";
    review.reason = "材料齐全";
    review.snapshot = { reviewStatus: "approved", enabled: true };
    await store.writeDb(db);
    let persisted = await store.readDb();
    assert.deepEqual(persisted.organizationLeaders, [leader]);
    assert.deepEqual(persisted.organizationLeaderDocuments, [document]);
    assert.deepEqual(persisted.organizationLeaderReviews, [review]);

    const invalid = structuredClone(db);
    invalid.organizationLeaders[0].name = "不应提交的领队";
    invalid.organizationLeaderDocuments[0].storedName = "should-not-commit.pdf";
    invalid.organizationLeaderReviews[0].reason = "不应提交的审核原因";
    invalid.organizationLeaderReviews.push({
      id: "invalid-review",
      leaderId: leader.id,
      organizationId: leader.organizationId,
      submissionVersion: 2,
      action: "invalid-action",
      actorId: null,
      reason: null,
      snapshot: {},
      documentId: null,
      createdAt: leader.updatedAt
    });
    await assert.rejects(store.writeDb(invalid), /leader review action/i);
    persisted = await store.readDb();
    assert.deepEqual(persisted.organizationLeaders, [leader]);
    assert.deepEqual(persisted.organizationLeaderDocuments, [document]);
    assert.deepEqual(persisted.organizationLeaderReviews, [review]);

    db.organizationLeaders = [];
    db.organizationLeaderDocuments = [];
    db.organizationLeaderReviews = [];
    await store.writeDb(db);
    persisted = await store.readDb();
    assert.deepEqual(persisted.organizationLeaders, []);
    assert.deepEqual(persisted.organizationLeaderDocuments, []);
    assert.deepEqual(persisted.organizationLeaderReviews, []);
  });
});
