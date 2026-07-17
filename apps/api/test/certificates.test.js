import assert from "node:assert/strict";
import test from "node:test";
import AdmZip from "adm-zip";
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
    assert.equal(visible.rows[0].certificateNo, "CERT-001");
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
    assert.deepEqual(rows.map((row) => row.certificateNo), ["CERT-ACTIVE"]);
    assert.equal(rows.every((row) => !("filePath" in row) && !("storedName" in row)), true);
  });
});

test("batch certificate upload reports matched, unmatched, and ambiguous files", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(admin.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationMode: "force_open" })
    }))).status, 200);
    const duplicateRegistration = {
      userId: "U1001",
      organizationId: "O1001",
      source: "普通用户",
      athlete: { name: "陈宇航", school: "温州市实验小学", grade: "五年级", phone: "13800000099" },
      group: "小学高段",
      projectId: "rocket-duration",
      instructor: "林老师"
    };
    const createRes = await fetch(`${baseUrl}/api/registrations`, withSession(ordinary.cookie, {
      method: "POST",
      body: JSON.stringify(duplicateRegistration),
      headers: { "Content-Type": "application/json" }
    }));
    assert.equal(createRes.status, 201);

    const zip = new AdmZip();
    zip.addFile("周星言_温州市第二实验中学_无人机竞速接力比赛.pdf", Buffer.from("%PDF matched"));
    zip.addFile("不存在_未知学校_无人机竞速接力比赛.pdf", Buffer.from("%PDF unmatched"));
    zip.addFile("陈宇航_温州市实验小学_比赛.pdf", Buffer.from("%PDF ambiguous"));
    const form = new FormData();
    form.append("zip", new Blob([zip.toBuffer()], { type: "application/zip" }), "certificates.zip");

    const batchRes = await fetch(`${baseUrl}/api/admin/certificates/batch`, withSession(admin.cookie, { method: "POST", body: form }));
    assert.equal(batchRes.status, 200);
    const result = await json(batchRes);
    assert.equal(result.matched.length, 1);
    assert.equal(result.unmatched.length, 1);
    assert.equal(result.ambiguous.length, 1);
  });
});
