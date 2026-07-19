import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import express from "express";
import sharp from "sharp";

import { readSiteMedia } from "../src/files/storage.js";
import { createSiteMediaRouter } from "../src/routes/site-media.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

function fileError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function controlledFileSystem({ links = [], missing = [], readErrors = new Map(), realpathSequences = new Map() } = {}) {
  const linked = new Set(links.map((value) => path.resolve(value)));
  const absent = new Set(missing.map((value) => path.resolve(value)));
  const calls = new Map();
  return {
    async lstat(value) {
      const resolved = path.resolve(value);
      if (absent.has(resolved)) throw fileError("ENOENT");
      return { isSymbolicLink: () => linked.has(resolved) };
    },
    async realpath(value) {
      const resolved = path.resolve(value);
      if (absent.has(resolved)) throw fileError("ENOENT");
      const sequence = realpathSequences.get(resolved);
      if (!sequence) return resolved;
      const index = calls.get(resolved) || 0;
      calls.set(resolved, index + 1);
      return path.resolve(sequence[Math.min(index, sequence.length - 1)]);
    },
    async readFile(value) {
      const resolved = path.resolve(value);
      if (absent.has(resolved)) throw fileError("ENOENT");
      if (readErrors.has(resolved)) throw readErrors.get(resolved);
      return Buffer.from(`contents:${path.basename(resolved)}`);
    }
  };
}

function siteMediaRecord(id = "MEDIA-SECURE") {
  const root = path.resolve(process.env.UPLOAD_ROOT || "/data/uploads");
  const directory = path.resolve(root, "site-media", id);
  return {
    id,
    filePath: path.resolve(directory, "original.png"),
    mimeType: "image/png",
    variants: {
      mobile: { filePath: path.resolve(directory, "mobile.webp"), mimeType: "image/webp" }
    }
  };
}

function mediaForm(buffer, { name = "upload.png", type = "image/png", purpose = "cover" } = {}) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type }), name);
  form.append("purpose", purpose);
  return form;
}

async function setMediaVisibility(dbPath, mediaId, visibility) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  const media = db.mediaAssets.find((row) => row.id === mediaId);
  assert.ok(media);
  media.visibility = visibility;
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`);
}

async function mutateDb(dbPath, mutate) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  mutate(db);
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`);
  return db;
}

async function withRouter(router, fn) {
  const app = express();
  app.use("/api", router);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("site media policies allow only approved image and attachment signatures", async () => {
  const policy = await import("../src/files/policy.js");

  assert.ok(policy.SITE_IMAGE_POLICY, "SITE_IMAGE_POLICY should be exported");
  assert.ok(policy.SITE_ATTACHMENT_POLICY, "SITE_ATTACHMENT_POLICY should be exported");
  assert.deepEqual([...policy.SITE_IMAGE_POLICY.extensions].sort(), ["jpeg", "jpg", "png", "webp"]);
  assert.deepEqual([...policy.SITE_ATTACHMENT_POLICY.extensions].sort(), ["jpeg", "jpg", "pdf", "png", "webp"]);
  assert.equal(policy.SITE_IMAGE_POLICY.maxBytes, 10 * 1024 * 1024);
  assert.equal(policy.SITE_ATTACHMENT_POLICY.maxBytes, 20 * 1024 * 1024);
  assert.equal(policy.SITE_IMAGE_POLICY.extensions.has("svg"), false);
  assert.equal(policy.SITE_ATTACHMENT_POLICY.extensions.has("svg"), false);
});

test("site media validation rejects spoofed, empty, oversized, and SVG uploads", async () => {
  const { SITE_ATTACHMENT_POLICY, SITE_IMAGE_POLICY, validateUpload } = await import("../src/files/policy.js");
  const fakePng = { buffer: Buffer.from("MZ executable"), originalname: "photo.png", mimetype: "image/png" };
  const maliciousSvg = {
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    originalname: "brand.svg",
    mimetype: "image/svg+xml"
  };

  await assert.rejects(() => validateUpload(fakePng, SITE_IMAGE_POLICY), /Unsupported file signature/);
  await assert.rejects(() => validateUpload({ buffer: Buffer.alloc(0) }, SITE_IMAGE_POLICY), /non-empty/);
  await assert.rejects(
    () => validateUpload({ buffer: Buffer.concat([PNG, Buffer.alloc(SITE_IMAGE_POLICY.maxBytes)]) }, SITE_IMAGE_POLICY),
    /exceeds/
  );
  await assert.rejects(() => validateUpload(maliciousSvg, SITE_IMAGE_POLICY), /Unsupported file signature/);
  await assert.rejects(() => validateUpload(maliciousSvg, SITE_ATTACHMENT_POLICY), /Unsupported file signature/);
  await assert.doesNotReject(() => validateUpload({ buffer: PDF }, SITE_ATTACHMENT_POLICY));
  await assert.rejects(() => validateUpload({ buffer: PDF }, SITE_IMAGE_POLICY), /Unsupported file signature/);
});

test("site media upload is admin-only, draft-private, and serves public derivatives safely", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");

    const forbidden = await fetch(`${baseUrl}/api/admin/site-media`, withSession(ordinary.cookie, {
      method: "POST",
      body: mediaForm(PNG)
    }));
    assert.equal(forbidden.status, 403);

    const upload = await fetch(`${baseUrl}/api/admin/site-media`, withSession(admin.cookie, {
      method: "POST",
      body: mediaForm(PNG)
    }));
    const uploadPayload = await upload.json();
    assert.equal(upload.status, 201, uploadPayload.error);
    const { row } = uploadPayload;
    assert.equal(row.visibility, "draft");
    assert.equal(row.mimeType, "image/png");
    assert.equal(row.width, 1);
    assert.equal(row.height, 1);
    assert.deepEqual(Object.keys(row.variants).sort(), ["desktop", "mobile"]);

    assert.equal((await fetch(`${baseUrl}/api/public/media/${row.id}`)).status, 404);
    await setMediaVisibility(dbPath, row.id, "public");

    const mobile = await fetch(`${baseUrl}/api/public/media/${row.id}?variant=mobile`);
    assert.equal(mobile.status, 200);
    assert.equal(mobile.headers.get("content-type"), "image/webp");
    assert.equal(mobile.headers.get("x-content-type-options"), "nosniff");
    assert.equal(mobile.headers.get("cache-control"), "public, max-age=604800");
    assert.ok((await mobile.arrayBuffer()).byteLength > 0);
  }, { prefix: "site-media-api-" });
});

test("site media attachments keep only the original and dangerous API uploads return 422", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    for (const form of [
      mediaForm(Buffer.alloc(0)),
      mediaForm(Buffer.from("MZ executable")),
      mediaForm(PNG.subarray(0, 33)),
      mediaForm(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), {
        name: "brand.svg",
        type: "image/svg+xml"
      })
    ]) {
      const response = await fetch(`${baseUrl}/api/admin/site-media`, withSession(admin.cookie, { method: "POST", body: form }));
      assert.equal(response.status, 422);
    }

    const upload = await fetch(`${baseUrl}/api/admin/site-media`, withSession(admin.cookie, {
      method: "POST",
      body: mediaForm(PDF, { name: "guide.pdf", type: "application/pdf", purpose: "attachment" })
    }));
    const payload = await upload.json();
    assert.equal(upload.status, 201, payload.error);
    assert.equal(payload.row.mimeType, "application/pdf");
    assert.equal(payload.row.width, null);
    assert.equal(payload.row.height, null);
    assert.deepEqual(payload.row.variants, {});

    await setMediaVisibility(dbPath, payload.row.id, "public");
    const fallback = await fetch(`${baseUrl}/api/public/media/${payload.row.id}?variant=mobile`);
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers.get("content-type"), "application/pdf");
    assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), PDF);
  }, { prefix: "site-media-attachment-" });
});

test("site media deletion blocks every managed reference before creating cleanup journal", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const upload = await fetch(`${baseUrl}/api/admin/site-media`, withSession(admin.cookie, {
      method: "POST",
      body: mediaForm(PNG)
    }));
    const media = (await upload.json()).row;
    assert.equal(upload.status, 201);

    const references = [
      (db) => { db.siteSettings.defaultHeroMediaId = media.id; },
      (db) => { db.siteSettings.defaultHeroMediaId = null; db.siteSettings.shareMediaId = media.id; },
      (db) => {
        db.siteSettings.shareMediaId = null;
        db.eventPublicProfiles.push({ eventId: "wz-aerospace-2026", slug: "current", heroMediaId: media.id });
      },
      (db) => {
        db.eventPublicProfiles = [];
        db.contentPosts.push({ id: "POST-REF", coverMediaId: media.id });
      },
      (db) => {
        db.contentPosts = [];
        db.contentAttachments.push({ contentId: "POST-REF", mediaId: media.id, label: "附件", displayOrder: 0 });
      }
    ];

    for (const reference of references) {
      await mutateDb(dbPath, reference);
      const blocked = await fetch(`${baseUrl}/api/admin/site-media/${media.id}`, withSession(admin.cookie, { method: "DELETE" }));
      assert.equal(blocked.status, 409);
      const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
      assert.ok(persisted.mediaAssets.some((row) => row.id === media.id));
      assert.equal(persisted.fileCleanupJournal.length, 0);
    }

    await mutateDb(dbPath, (db) => { db.contentAttachments = []; });
    const removed = await fetch(`${baseUrl}/api/admin/site-media/${media.id}`, withSession(admin.cookie, { method: "DELETE" }));
    assert.equal(removed.status, 204);
    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(persisted.mediaAssets.some((row) => row.id === media.id), false);
    assert.equal(persisted.fileCleanupJournal.length, 0);
  }, { prefix: "site-media-delete-" });
});

test("site media physical deletion failure preserves metadata and journals the managed directory", async () => {
  let persisted = {
    mediaAssets: [{
      id: "MEDIA-FAIL",
      purpose: "cover",
      visibility: "draft",
      filePath: "/data/uploads/site-media/MEDIA-FAIL/original.png",
      variants: {},
      cleanedAt: null
    }],
    siteSettings: {},
    eventPublicProfiles: [],
    contentPosts: [],
    contentAttachments: [],
    fileCleanupJournal: []
  };
  const store = {
    readDb: async () => structuredClone(persisted),
    writeDb: async (db) => { persisted = structuredClone(db); }
  };
  const pass = (req, _res, next) => { req.user = { id: "ADMIN", type: "admin" }; next(); };
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const router = createSiteMediaRouter({
    store,
    requireAdmin: pass,
    requirePasswordReady: pass,
    asyncRoute: wrap,
    mutationAsyncRoute: wrap,
    makeId: () => "CLN-FAIL",
    now: () => "2026-07-19T12:00:00.000Z",
    storage: {
      save: async () => { throw new Error("not used"); },
      read: async () => { throw new Error("not used"); },
      delete: async () => { throw new Error("disk unavailable"); }
    }
  });

  await withRouter(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/site-media/MEDIA-FAIL`, { method: "DELETE" });
    assert.equal(response.status, 500);
  });
  assert.equal(persisted.mediaAssets.length, 1);
  assert.equal(persisted.mediaAssets[0].cleanedAt, "2026-07-19T12:00:00.000Z");
  assert.equal(persisted.fileCleanupJournal.length, 1);
  assert.equal(persisted.fileCleanupJournal[0].filePath, "/data/uploads/site-media/MEDIA-FAIL");
  assert.equal(persisted.fileCleanupJournal[0].attempts, 1);
  assert.equal(persisted.fileCleanupJournal[0].lastError, "disk unavailable");
});

test("site media publishing promotes referenced assets without deleting them when content goes offline", async () => {
  const service = await import("../src/services/site-media.js");
  assert.equal(typeof service.promoteMedia, "function");
  assert.equal(typeof service.promoteContentMedia, "function");
  const db = {
    mediaAssets: [
      { id: "COVER", visibility: "draft", cleanedAt: null },
      { id: "ATTACHMENT", visibility: "draft", cleanedAt: null },
      { id: "HERO", visibility: "draft", cleanedAt: null },
      { id: "CLEANED", visibility: "draft", cleanedAt: "2026-07-19T00:00:00.000Z" }
    ],
    contentPosts: [{ id: "POST", status: "published", coverMediaId: "COVER" }],
    contentAttachments: [{ contentId: "POST", mediaId: "ATTACHMENT" }]
  };

  assert.deepEqual(service.promoteContentMedia(db, "POST").map((row) => row.id).sort(), ["ATTACHMENT", "COVER"]);
  assert.equal(db.mediaAssets.find((row) => row.id === "COVER").visibility, "public");
  assert.equal(db.mediaAssets.find((row) => row.id === "ATTACHMENT").visibility, "public");
  assert.deepEqual(service.promoteMedia(db, ["HERO", "CLEANED"]).map((row) => row.id), ["HERO"]);
  assert.equal(db.mediaAssets.find((row) => row.id === "CLEANED").visibility, "draft");

  db.contentPosts[0].status = "offline";
  assert.deepEqual(service.promoteContentMedia(db, "POST"), []);
  assert.equal(db.mediaAssets.find((row) => row.id === "COVER").visibility, "public");
  assert.equal(db.mediaAssets.length, 4);
});

test("site media upload persistence failure journals an orphan when physical rollback also fails", async () => {
  let persisted = {
    mediaAssets: [],
    fileCleanupJournal: [],
    siteSettings: {},
    eventPublicProfiles: [],
    contentPosts: [],
    contentAttachments: []
  };
  let writes = 0;
  const store = {
    readDb: async () => structuredClone(persisted),
    writeDb: async (db) => {
      writes += 1;
      if (writes === 1) throw new Error("database unavailable");
      persisted = structuredClone(db);
    }
  };
  const pass = (req, _res, next) => { req.user = { id: "ADMIN", type: "admin" }; next(); };
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const router = createSiteMediaRouter({
    store,
    requireAdmin: pass,
    requirePasswordReady: pass,
    asyncRoute: wrap,
    mutationAsyncRoute: wrap,
    makeId: (prefix) => `${prefix}-ORPHAN`,
    now: () => "2026-07-19T12:30:00.000Z",
    storage: {
      save: async () => ({
        originalName: "upload.png",
        storedName: "original.png",
        filePath: "C:\\uploads\\site-media\\M-ORPHAN\\original.png",
        mimeType: "image/png",
        sizeBytes: PNG.length,
        width: 1,
        height: 1,
        variants: {}
      }),
      read: async () => { throw new Error("not used"); },
      delete: async () => { throw new Error("rollback denied"); }
    }
  });

  await withRouter(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/site-media`, { method: "POST", body: mediaForm(PNG) });
    assert.equal(response.status, 500);
  });
  assert.equal(persisted.mediaAssets.length, 0);
  assert.equal(persisted.fileCleanupJournal.length, 1);
  assert.equal(persisted.fileCleanupJournal[0].filePath, "C:\\uploads\\site-media\\M-ORPHAN");
  assert.equal(persisted.fileCleanupJournal[0].attempts, 1);
  assert.equal(persisted.fileCleanupJournal[0].lastError, "rollback denied");
});

test("site media image processing corrects orientation and caps derivative widths without enlargement", async () => {
  const large = await sharp({
    create: { width: 2000, height: 100, channels: 3, background: { r: 20, g: 80, b: 160 } }
  }).png().toBuffer();
  const oriented = await sharp({
    create: { width: 20, height: 10, channels: 3, background: { r: 160, g: 80, b: 20 } }
  }).jpeg().withMetadata({ orientation: 6 }).toBuffer();

  await withTestServer(async ({ baseUrl }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const upload = async (buffer, options) => {
      const response = await fetch(`${baseUrl}/api/admin/site-media`, withSession(admin.cookie, {
        method: "POST",
        body: mediaForm(buffer, options)
      }));
      const payload = await response.json();
      assert.equal(response.status, 201, payload.error);
      return payload.row;
    };

    const largeRow = await upload(large, { name: "large.png", type: "image/png" });
    assert.equal(largeRow.width, 2000);
    assert.equal(largeRow.height, 100);
    assert.equal(largeRow.variants.mobile.width, 768);
    assert.equal(largeRow.variants.desktop.width, 1600);

    const orientedRow = await upload(oriented, { name: "oriented.jpg", type: "image/jpeg" });
    assert.equal(orientedRow.width, 10);
    assert.equal(orientedRow.height, 20);
    assert.equal(orientedRow.variants.mobile.width, 10);
    assert.equal(orientedRow.variants.desktop.width, 10);
  }, { prefix: "site-media-sizing-" });
});

test("site media reading rejects a linked file inside its managed directory", async () => {
  const record = siteMediaRecord("MEDIA-FILE-LINK");
  await assert.rejects(
    () => readSiteMedia(record, "original", controlledFileSystem({ links: [record.filePath] })),
    /symbolic link/i
  );
});

test("site media reading rejects a linked or junction media directory", async () => {
  const record = siteMediaRecord("MEDIA-DIR-LINK");
  await assert.rejects(
    () => readSiteMedia(record, "original", controlledFileSystem({ links: [path.dirname(record.filePath)] })),
    /symbolic link/i
  );
});

test("site media reading rejects a path outside the record media directory even within upload root", async () => {
  const record = siteMediaRecord("MEDIA-SCOPED");
  const root = path.resolve(process.env.UPLOAD_ROOT || "/data/uploads");
  record.filePath = path.resolve(root, "certificates", "private.png");
  await assert.rejects(
    () => readSiteMedia(record, "original", controlledFileSystem()),
    /media directory/i
  );
});

test("site media public route conceals a cross-directory media path", async () => {
  const record = { ...siteMediaRecord("MEDIA-ROUTE-SCOPED"), visibility: "public", cleanedAt: null };
  const root = path.resolve(process.env.UPLOAD_ROOT || "/data/uploads");
  record.filePath = path.resolve(root, "certificates", "private.png");
  const pass = (_req, _res, next) => next();
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const router = createSiteMediaRouter({
    store: { readDb: async () => ({ mediaAssets: [record] }) },
    requireAdmin: pass,
    requirePasswordReady: pass,
    asyncRoute: wrap,
    mutationAsyncRoute: wrap,
    makeId: () => "unused",
    now: () => "2026-07-19T13:00:00.000Z",
    storage: {
      save: async () => { throw new Error("not used"); },
      delete: async () => { throw new Error("not used"); },
      read: (media, variant) => readSiteMedia(media, variant, controlledFileSystem())
    }
  });

  await withRouter(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/public/media/${record.id}`);
    assert.equal(response.status, 404);
  });
});

test("site media reading rejects a path that changes during realpath validation", async () => {
  const record = siteMediaRecord("MEDIA-RACE");
  const root = path.resolve(process.env.UPLOAD_ROOT || "/data/uploads");
  const fileSystem = controlledFileSystem({
    realpathSequences: new Map([[record.filePath, [record.filePath, path.resolve(root, "certificates", "private.png")]]])
  });
  await assert.rejects(() => readSiteMedia(record, "original", fileSystem), /changed during validation/i);
});

test("site media reading falls back to original only when a registered variant is missing", async () => {
  const record = siteMediaRecord("MEDIA-FALLBACK");
  const mobilePath = record.variants.mobile.filePath;
  const missingVariantFs = controlledFileSystem({ missing: [mobilePath] });
  await assert.doesNotReject(async () => {
    const result = await readSiteMedia(record, "mobile", missingVariantFs);
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.buffer.toString(), "contents:original.png");
  });

  const denied = fileError("EACCES", "variant read denied");
  await assert.rejects(
    () => readSiteMedia(record, "mobile", controlledFileSystem({ readErrors: new Map([[mobilePath, denied]]) })),
    (error) => error === denied
  );
});

test("site media attachment API accepts exactly 20 MB and rejects a larger multipart file", async () => {
  const atLimit = Buffer.alloc(20 * 1024 * 1024);
  PDF.copy(atLimit);
  const overLimit = Buffer.alloc(atLimit.length + 1);
  PDF.copy(overLimit);

  await withTestServer(async ({ baseUrl }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const accepted = await fetch(`${baseUrl}/api/admin/site-media`, withSession(admin.cookie, {
      method: "POST",
      body: mediaForm(atLimit, { name: "limit.pdf", type: "application/pdf", purpose: "attachment" })
    }));
    assert.equal(accepted.status, 201, await accepted.text());

    const rejected = await fetch(`${baseUrl}/api/admin/site-media`, withSession(admin.cookie, {
      method: "POST",
      body: mediaForm(overLimit, { name: "too-large.pdf", type: "application/pdf", purpose: "attachment" })
    }));
    assert.equal(rejected.status, 413);
  }, { prefix: "site-media-attachment-limit-" });
});
