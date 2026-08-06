import assert from "node:assert/strict";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function jsonRequest(url, cookie, method, body) {
  return fetch(url, withSession(cookie, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }));
}

test("a content slug is permanently immutable after its first publication", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const createResponse = await jsonRequest(`${baseUrl}/api/admin/content`, admin.cookie, "POST", {
      slug: "permanent-content-link",
      eventId: null,
      type: "news",
      title: "Permanent link",
      summary: "",
      bodyHtml: "<p>content</p>",
      pinned: false,
      sortOrder: 0,
      coverMediaId: null,
      attachments: []
    });
    const draft = (await createResponse.json()).row;
    assert.equal(createResponse.status, 201);

    const publishResponse = await jsonRequest(`${baseUrl}/api/admin/content/${draft.id}/publish`, admin.cookie, "POST", {
      version: draft.version
    });
    const published = (await publishResponse.json()).row;
    assert.equal(publishResponse.status, 200);

    const offlineResponse = await jsonRequest(`${baseUrl}/api/admin/content/${draft.id}/offline`, admin.cookie, "POST", {
      version: published.version
    });
    const offline = (await offlineResponse.json()).row;
    assert.equal(offlineResponse.status, 200);

    const renamed = await jsonRequest(`${baseUrl}/api/admin/content/${draft.id}`, admin.cookie, "PATCH", {
      version: offline.version,
      slug: "changed-content-link"
    });
    assert.equal(renamed.status, 409);
    assert.equal((await renamed.json()).code, "CONTENT_SLUG_STABLE");

    const titleOnly = await jsonRequest(`${baseUrl}/api/admin/content/${draft.id}`, admin.cookie, "PATCH", {
      version: offline.version,
      slug: "permanent-content-link",
      title: "Updated title"
    });
    assert.equal(titleOnly.status, 200);
    assert.equal((await titleOnly.json()).row.slug, "permanent-content-link");
  }, { prefix: "content-slug-stability-" });
});
