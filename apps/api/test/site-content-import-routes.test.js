import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createSiteContentImportRouter } from "../src/routes/site-content-imports.js";

async function withApp(factory, run) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: "ADMIN", type: "admin", mustChangePassword: false }; next(); });
  const pass = (_req, _res, next) => next();
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  app.use("/api", factory({ requireAdmin: pass, requirePasswordReady: pass, asyncRoute: wrap, mutationAsyncRoute: wrap }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({
    error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {})
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function batch() {
  return {
    id: "SCI-1", createdBy: "ADMIN", sourceUrl: "https://news.example.test/article", sourceType: "web",
    sourceName: "温州新闻网", sourceAuthor: "作者", sourcePublishedAt: null, title: "原文", summary: "摘要",
    bodyTemplateHtml: '<p>正文<img src="@@SITE_IMPORT_IMAGE:IMG1@@"></p>', warnings: [], status: "ready",
    createdAt: "2026-08-11T00:00:00.000Z", expiresAt: "2026-08-11T00:30:00.000Z",
    images: [{ id: "IMG1", status: "ready", mimeType: "image/png", stagePath: "/private/staging.png", originalName: "photo.png" }]
  };
}

test("content import routes expose the complete admin workflow without leaking private paths", async () => {
  const calls = [];
  const row = batch();
  const services = {
    inspect: async (_deps, input) => { calls.push(["inspect", input]); return row; },
    batchForAdmin: (_db, input) => { calls.push(["batch", input]); return row; },
    retry: async (_deps, input) => { calls.push(["retry", input]); return row.images[0]; },
    deleteImage: async (_deps, input) => { calls.push(["deleteImage", input]); return { ...row.images[0], status: "deleted" }; },
    commit: async (_deps, input) => { calls.push(["commit", input]); return { id: "POST-1", status: "draft" }; },
    cancel: async (_deps, input) => { calls.push(["cancel", input]); return { ...row, status: "cancelled" }; }
  };
  const store = { readDb: async () => ({ siteContentImportBatches: [row] }) };
  const stagedStorage = { read: async () => Buffer.from("png") };

  await withApp((middleware) => createSiteContentImportRouter({
    store, ...middleware, makeId: () => "ID", now: () => "2026-08-11T00:00:00.000Z", services, stagedStorage
  }), async (baseUrl) => {
    const inspect = await fetch(`${baseUrl}/api/admin/content-imports/inspect`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceUrl: row.sourceUrl })
    });
    assert.equal(inspect.status, 201);
    const inspected = (await inspect.json()).row;
    assert.equal("stagePath" in inspected.images[0], false);
    assert.equal("bodyTemplateHtml" in inspected, false);

    const status = await fetch(`${baseUrl}/api/admin/content-imports/SCI-1`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).row.id, "SCI-1");

    const preview = await fetch(`${baseUrl}/api/admin/content-imports/SCI-1/images/IMG1`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "image/png");
    assert.equal(preview.headers.get("cache-control"), "private, no-store");
    assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
    assert.match(preview.headers.get("content-disposition"), /^inline/);
    assert.equal(await preview.text(), "png");

    assert.equal((await fetch(`${baseUrl}/api/admin/content-imports/SCI-1/images/IMG1/retry`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/admin/content-imports/SCI-1/images/IMG1`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/admin/content-imports/SCI-1/commit`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "标题" })
    })).status, 201);
    assert.equal((await fetch(`${baseUrl}/api/admin/content-imports/SCI-1`, { method: "DELETE" })).status, 200);
  });

  for (const [, input] of calls) assert.equal(input.adminId, "ADMIN");
  assert.equal(calls.find(([name]) => name === "commit")[1].batchId, "SCI-1");
});

test("duplicate-source route errors preserve the existing content id", async () => {
  const duplicate = Object.assign(new Error("该来源链接已经转载过"), {
    status: 409, code: "IMPORT_DUPLICATE_SOURCE", details: { contentId: "POST-OLD" }
  });
  await withApp((middleware) => createSiteContentImportRouter({
    store: { readDb: async () => ({}) }, ...middleware,
    makeId: () => "ID", now: () => "2026-08-11T00:00:00.000Z",
    services: { inspect: async () => { throw duplicate; } }
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/content-imports/inspect`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceUrl: "https://news.example.test" })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "该来源链接已经转载过", code: "IMPORT_DUPLICATE_SOURCE", details: { contentId: "POST-OLD" }
    });
  });
});
