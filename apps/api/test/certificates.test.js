import assert from "node:assert/strict";
import test from "node:test";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function withServer(fn) {
  await withTestServer(({ baseUrl, tempDir }) => fn(baseUrl, tempDir), { prefix: "wz-cert-api-" });
}

async function json(res) {
  return res.json();
}

test("published certificates are visible to the owner but drafts are hidden", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const draftRes = await fetch(`${baseUrl}/api/admin/registrations/R20260627002/certificate`, withSession(admin.cookie, {
      method: "POST",
      body: JSON.stringify({
        fileName: "zhou.pdf",
        fileContentBase64: Buffer.from("%PDF-1.4 draft").toString("base64"),
        certificateNo: "CERT-001"
      }),
      headers: { "Content-Type": "application/json" }
    }));
    assert.equal(draftRes.status, 201);

    const hiddenRes = await fetch(`${baseUrl}/api/me/certificates`, withSession(owner.cookie));
    assert.equal(hiddenRes.status, 200);
    assert.deepEqual((await json(hiddenRes)).rows, []);

    const certificate = (await json(draftRes)).row;
    const publishRes = await fetch(`${baseUrl}/api/admin/certificates/${certificate.id}/publish`, withSession(admin.cookie, {
      method: "PATCH",
      body: JSON.stringify({ status: "published" }),
      headers: { "Content-Type": "application/json" }
    }));
    assert.equal(publishRes.status, 200);

    const visibleRes = await fetch(`${baseUrl}/api/me/certificates`, withSession(owner.cookie));
    const visible = await json(visibleRes);
    assert.equal(visible.rows.length, 1);
    assert.equal(visible.rows[0].slot, 1);
    assert.equal(visible.rows[0].title, "获奖证书");
    assert.equal("filePath" in visible.rows[0], false);
    assert.equal("storedName" in visible.rows[0], false);
  });
});

test("organization certificate query includes active members and excludes pending members", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const pendingUserRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      body: JSON.stringify({ name: "待审核家长", phone: "13600000001", password: "Strong123" }),
      headers: { "Content-Type": "application/json" }
    });
    const pendingUser = (await json(pendingUserRes)).user;
    const pending = await loginAs(baseUrl, "13600000001", "Strong123");
    await fetch(`${baseUrl}/api/organizations/request`, withSession(pending.cookie, {
      method: "POST",
      body: JSON.stringify({ userId: pendingUser.id, organizationId: "O1001", note: "测试待审核成员" }),
      headers: { "Content-Type": "application/json" }
    }));

    const uploadRes = await fetch(`${baseUrl}/api/admin/registrations/R20260627001/certificate`, withSession(admin.cookie, {
      method: "POST",
      body: JSON.stringify({
        fileName: "chen.pdf",
        fileContentBase64: Buffer.from("%PDF-1.4 active").toString("base64"),
        certificateNo: "CERT-ACTIVE"
      }),
      headers: { "Content-Type": "application/json" }
    }));
    const certificate = (await json(uploadRes)).row;
    await fetch(`${baseUrl}/api/admin/certificates/${certificate.id}/publish`, withSession(admin.cookie, {
      method: "PATCH",
      body: JSON.stringify({ status: "published" }),
      headers: { "Content-Type": "application/json" }
    }));

    const orgRes = await fetch(`${baseUrl}/api/organizations/O1001/certificates`, withSession(owner.cookie));
    assert.equal(orgRes.status, 200);
    const rows = (await json(orgRes)).rows;
    assert.deepEqual(rows.map((row) => ({ slot: row.slot, title: row.title })), [{ slot: 1, title: "获奖证书" }]);
    assert.equal(rows.every((row) => !("filePath" in row) && !("storedName" in row)), true);
  });
});

test("certificate upload persists the first slot and a title", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const uploadRes = await fetch(`${baseUrl}/api/admin/registrations/R20260627001/certificate`, withSession(admin.cookie, {
      method: "POST",
      body: JSON.stringify({
        fileName: "slot-one.pdf",
        fileContentBase64: Buffer.from("%PDF-1.4 slot one").toString("base64")
      }),
      headers: { "Content-Type": "application/json" }
    }));
    assert.equal(uploadRes.status, 201);

    const certificates = await fetch(`${baseUrl}/api/admin/certificates`, withSession(admin.cookie));
    assert.equal(certificates.status, 200);
    assert.deepEqual((await json(certificates)).rows.map((row) => ({ slot: row.slot, title: row.title })), [{
      slot: 1,
      title: "获奖证书"
    }]);
  });
});
