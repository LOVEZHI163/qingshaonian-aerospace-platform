import assert from "node:assert/strict";
import test from "node:test";
import { withTestServer } from "../test-support/server.js";

test("system version returns the injected immutable release identity", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/system/version`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      releaseSha: "release-test-123",
      apiVersion: 1
    });
  }, { env: { RELEASE_SHA: "release-test-123" } });
});
