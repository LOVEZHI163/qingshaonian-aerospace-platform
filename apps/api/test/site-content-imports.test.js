import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelContentImport,
  commitContentImport,
  deleteContentImportImage,
  expireContentImportBatches,
  inspectContentImport,
  retryContentImportImage
} from "../src/services/site-content-imports.js";

function baseDb() {
  return {
    events: [{ id: "E1", status: "published" }],
    users: [{ id: "ADMIN", name: "管理员", type: "admin" }],
    contentPosts: [], siteContentImportBatches: [], mediaAssets: [], contentAttachments: [],
    auditLogs: [], fileCleanupJournal: []
  };
}

function memoryStore(initial = baseDb()) {
  let data = structuredClone(initial);
  return {
    kind: "json",
    async readDb() { return structuredClone(data); },
    async writeDb(next) { data = structuredClone(next); },
    value() { return structuredClone(data); }
  };
}

function dependencies(overrides = {}) {
  const store = overrides.store || memoryStore();
  let sequence = 0;
  const staged = new Map();
  const deleted = [];
  const siteDeleted = [];
  return {
    store,
    makeId: (prefix) => `${prefix}-${++sequence}`,
    now: () => "2026-08-11T00:00:00.000Z",
    readStorageStatus: async () => ({ disk: { totalBytes: 100, usedBytes: 20 }, level: "normal", thresholds: { warningPercent: 80, criticalPercent: 90 } }),
    fetchResource: async (url, options) => ({ finalUrl: url, buffer: Buffer.from("<article>ok</article>"), headers: { "content-type": options.expected === "image" ? "image/png" : "text/html" } }),
    extractArticle: () => ({
      sourceType: "web", title: "原文标题", summary: "原文摘要", sourceName: "温州新闻网", sourceAuthor: "作者甲",
      sourcePublishedAt: "2026-08-10T00:00:00.000Z", canonicalUrl: "https://news.example.test/article",
      bodyTemplateHtml: '<p>正文<img src="@@SITE_IMPORT_IMAGE:IMG1@@"></p>',
      images: [{ id: "IMG1", url: "https://cdn.example.test/photo.png", alt: "现场" }]
    }),
    stageImages: async ({ batchId }) => {
      const stagePath = `/staging/${batchId}/IMG1.png`;
      staged.set(stagePath, Buffer.from("png"));
      return [{
        id: "IMG1", originalUrl: "https://cdn.example.test/photo.png", resolvedUrl: "https://cdn.example.test/photo.png",
        originalName: "photo.png", mimeType: "image/png", sizeBytes: 3, width: 1200, height: 800,
        stagePath, status: "ready", reasonCode: null, reason: "", coverCandidate: true, alt: "现场", title: ""
      }];
    },
    retryImage: async ({ batch, imageId }) => {
      const next = { ...batch.images.find((image) => image.id === imageId), status: "ready", reasonCode: null, reason: "" };
      batch.images[batch.images.findIndex((image) => image.id === imageId)] = next;
      return next;
    },
    stagedStorage: {
      save: async () => ({ stagePath: "/staging/image" }),
      read: async ({ stagePath }) => staged.get(stagePath) || Buffer.from("png"),
      deleteImage: async ({ stagePath }) => { deleted.push(stagePath); },
      deleteBatch: async ({ batchId }) => { deleted.push(`batch:${batchId}`); }
    },
    siteMediaStorage: {
      save: async ({ mediaId, purpose, file }) => ({
        originalName: file.originalname, storedName: `${mediaId}.png`, filePath: `/site-media/${mediaId}/original.png`,
        mimeType: "image/png", sizeBytes: file.buffer.length, width: 1200, height: 800, variants: {}, purpose
      }),
      delete: async ({ id }) => { siteDeleted.push(id); }
    },
    _staged: staged,
    _deleted: deleted,
    _siteDeleted: siteDeleted,
    ...overrides
  };
}

test("inspects a normalized source, persists an owned batch, and reports storage warnings", async () => {
  const deps = dependencies({
    readStorageStatus: async () => ({ disk: { totalBytes: 100, usedBytes: 80 }, level: "warning", thresholds: { warningPercent: 80, criticalPercent: 90 } })
  });
  const batch = await inspectContentImport(deps, {
    adminId: "ADMIN", sourceUrl: "https://news.example.test/article?utm_source=wechat"
  });

  assert.equal(batch.createdBy, "ADMIN");
  assert.equal(batch.normalizedSourceUrl, "https://news.example.test/article");
  assert.equal(batch.status, "ready");
  assert.equal(batch.images[0].status, "ready");
  assert.equal(batch.warnings.some((warning) => warning.code === "IMPORT_STORAGE_WARNING"), true);
  assert.equal(deps.store.value().siteContentImportBatches.length, 1);
  assert.equal(deps.store.value().auditLogs.at(-1).action, "content.import.inspect");
  assert.equal(deps.store.value().auditLogs.at(-1).actorUserId, "ADMIN");
});

test("rejects duplicate source fingerprints before and after fetching", async () => {
  const db = baseDb();
  db.contentPosts.push({ id: "POST-OLD", sourceUrlFingerprint: "4ef0b2f70d8f5ad1b38f910c3599e6a2dd1774e9904cc01d93f2b2bec7632ac5" });
  const deps = dependencies({ store: memoryStore(db) });
  await assert.rejects(
    inspectContentImport(deps, { adminId: "ADMIN", sourceUrl: "https://news.example.test/article" }),
    (error) => error?.code === "IMPORT_DUPLICATE_SOURCE" && error?.details?.contentId === "POST-OLD"
  );

  const canonicalDb = baseDb();
  canonicalDb.contentPosts.push({ id: "POST-CANONICAL", sourceUrlFingerprint: "4ef0b2f70d8f5ad1b38f910c3599e6a2dd1774e9904cc01d93f2b2bec7632ac5" });
  const redirected = dependencies({
    store: memoryStore(canonicalDb),
    fetchResource: async () => ({ finalUrl: "https://other.example.test/redirect", buffer: Buffer.from("html"), headers: {} })
  });
  await assert.rejects(
    inspectContentImport(redirected, { adminId: "ADMIN", sourceUrl: "https://fresh.example.test/start" }),
    (error) => error?.code === "IMPORT_DUPLICATE_SOURCE" && error?.details?.contentId === "POST-CANONICAL"
  );
});

test("limits each administrator to ten inspections per minute and blocks critical storage before images", async () => {
  const deps = dependencies();
  for (let index = 0; index < 10; index += 1) {
    await inspectContentImport(deps, { adminId: "ADMIN", sourceUrl: `https://news.example.test/${index}` });
  }
  await assert.rejects(
    inspectContentImport(deps, { adminId: "ADMIN", sourceUrl: "https://news.example.test/11" }),
    (error) => error?.status === 429 && error?.code === "IMPORT_RATE_LIMITED"
  );

  let fetched = false;
  const critical = dependencies({
    readStorageStatus: async () => ({ disk: { totalBytes: 100, usedBytes: 90 }, level: "critical", thresholds: { warningPercent: 80, criticalPercent: 90 } }),
    fetchResource: async () => { fetched = true; throw new Error("should not fetch"); }
  });
  await assert.rejects(
    inspectContentImport(critical, { adminId: "ADMIN-2", sourceUrl: "https://news.example.test/critical" }),
    (error) => error?.code === "IMPORT_STORAGE_CRITICAL"
  );
  assert.equal(fetched, false);
});

test("enforces batch ownership and expiry while deleting or retrying only the selected image", async () => {
  const db = baseDb();
  db.siteContentImportBatches.push({
    id: "SCI-1", createdBy: "ADMIN", status: "ready", expiresAt: "2026-08-11T00:30:00.000Z",
    images: [
      { id: "IMG1", originalUrl: "https://cdn.example.test/1.png", stagePath: "/staging/1.png", status: "ready", sizeBytes: 1 },
      { id: "IMG2", originalUrl: "https://cdn.example.test/2.png", stagePath: null, status: "failed", sizeBytes: null }
    ]
  });
  const deps = dependencies({ store: memoryStore(db) });
  await assert.rejects(
    deleteContentImportImage(deps, { adminId: "OTHER", batchId: "SCI-1", imageId: "IMG1" }),
    (error) => error?.status === 404
  );
  await deleteContentImportImage(deps, { adminId: "ADMIN", batchId: "SCI-1", imageId: "IMG1" });
  assert.equal(deps.store.value().siteContentImportBatches[0].images[0].status, "deleted");
  assert.equal(deps.store.value().siteContentImportBatches[0].images[1].status, "failed");
  await retryContentImportImage(deps, { adminId: "ADMIN", batchId: "SCI-1", imageId: "IMG2" });
  assert.equal(deps.store.value().siteContentImportBatches[0].images[1].status, "ready");
  assert.deepEqual(deps.store.value().auditLogs.map((row) => row.action), ["content.import.image-retry", "content.import.image-delete"]);

  const expiredDb = deps.store.value();
  expiredDb.siteContentImportBatches[0].expiresAt = "2026-08-10T23:59:00.000Z";
  const expired = dependencies({ store: memoryStore(expiredDb) });
  await assert.rejects(
    cancelContentImport(expired, { adminId: "ADMIN", batchId: "SCI-1" }),
    (error) => error?.code === "IMPORT_BATCH_EXPIRED"
  );
});

test("commits selected staged images, source attribution, audit, and a draft in one snapshot", async () => {
  const deps = dependencies();
  const batch = await inspectContentImport(deps, { adminId: "ADMIN", sourceUrl: "https://news.example.test/article" });
  const post = await commitContentImport(deps, {
    adminId: "ADMIN", batchId: batch.id, eventId: "E1", type: "news", title: "自定义标题", summary: "自定义摘要",
    slug: "reposted-news", selectedImageIds: ["IMG1"], coverImageId: "IMG1", status: "published"
  });
  const db = deps.store.value();

  assert.equal(post.status, "draft");
  assert.equal(post.sourceName, "温州新闻网");
  assert.equal(post.sourceUrl, "https://news.example.test/article");
  assert.match(post.bodyHtml, /\/api\/public\/media\/M-/);
  assert.doesNotMatch(post.bodyHtml, /SITE_IMPORT_IMAGE/);
  assert.equal(db.mediaAssets.length, 2);
  assert.deepEqual(new Set(db.mediaAssets.map((media) => media.purpose)), new Set(["content-body", "content-cover"]));
  assert.equal(db.contentAttachments.length, 1);
  assert.equal(db.siteContentImportBatches[0].status, "committed");
  assert.equal(db.auditLogs[0].action, "content.import");
  assert.equal(deps._deleted.includes(`batch:${batch.id}`), true);
});

test("expires ready batches and removes their staging directories", async () => {
  const db = baseDb();
  db.siteContentImportBatches.push(
    { id: "OLD", createdBy: "ADMIN", status: "ready", expiresAt: "2026-08-10T23:00:00.000Z", images: [] },
    { id: "NEW", createdBy: "ADMIN", status: "ready", expiresAt: "2026-08-11T01:00:00.000Z", images: [] }
  );
  const deps = dependencies({ store: memoryStore(db) });
  assert.deepEqual(await expireContentImportBatches(deps), ["OLD"]);
  assert.equal(deps.store.value().siteContentImportBatches.some((batch) => batch.id === "OLD"), false);
  assert.equal(deps.store.value().auditLogs.at(-1).action, "content.import.expire");
  assert.equal(deps.store.value().auditLogs.at(-1).actorUserId, "system");
  assert.deepEqual(deps._deleted, ["batch:OLD"]);
});

test("cancel audits the administrator and journals staging cleanup failures", async () => {
  const deps = dependencies({
    stagedStorage: {
      save: async () => ({ stagePath: "/staging/image" }),
      read: async () => Buffer.from("png"),
      deleteImage: async () => {},
      deleteBatch: async ({ batchId }) => {
        const error = new Error("disk busy");
        error.cleanupTarget = { filePath: `/uploads/site-content-import-staging/${batchId}` };
        throw error;
      }
    }
  });
  const batch = await inspectContentImport(deps, { adminId: "ADMIN", sourceUrl: "https://news.example.test/cancel" });
  const cancelled = await cancelContentImport(deps, { adminId: "ADMIN", batchId: batch.id });
  const snapshot = deps.store.value();

  assert.equal(cancelled.status, "cancelled");
  assert.equal(snapshot.auditLogs[0].action, "content.import.cancel");
  assert.equal(snapshot.auditLogs[0].actorUserId, "ADMIN");
  assert.equal(snapshot.fileCleanupJournal[0].category, "site-content-import-staging");
});

test("a committed draft remains saved when final staging cleanup fails", async () => {
  const deps = dependencies();
  const originalDeleteBatch = deps.stagedStorage.deleteBatch;
  const batch = await inspectContentImport(deps, { adminId: "ADMIN", sourceUrl: "https://news.example.test/cleanup-after-commit" });
  deps.stagedStorage.deleteBatch = async ({ batchId }) => {
    const error = new Error("staging cleanup failed");
    error.cleanupTarget = { filePath: `/uploads/site-content-import-staging/${batchId}` };
    throw error;
  };

  const post = await commitContentImport(deps, {
    adminId: "ADMIN", batchId: batch.id, eventId: null, type: "news", title: "保留的草稿", summary: "",
    slug: "saved-despite-cleanup", selectedImageIds: [], coverImageId: null
  });
  const snapshot = deps.store.value();
  assert.equal(post.status, "draft");
  assert.equal(snapshot.contentPosts.some((row) => row.id === post.id), true);
  assert.equal(snapshot.fileCleanupJournal[0].category, "site-content-import-staging");
  deps.stagedStorage.deleteBatch = originalDeleteBatch;
});
