import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";

const rootDir = path.resolve(import.meta.dirname, "../../..");
const serverPath = path.resolve(import.meta.dirname, "../src/server.js");

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (child.exitCode !== null) throw new Error("API server exited before becoming ready");
    try {
      const res = await fetch(`${baseUrl}/api/public/event`);
      if (res.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("API server did not start in time");
}

async function withServer(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wz-cert-api-"));
  const port = 4600 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DB_PATH: path.join(tempDir, "db.json"),
      UPLOAD_ROOT: path.join(tempDir, "uploads")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForServer(baseUrl, child);
    await fn(baseUrl, tempDir);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function json(res) {
  return res.json();
}

test("published certificates are visible to the owner but drafts are hidden", async () => {
  await withServer(async (baseUrl) => {
    const draftRes = await fetch(`${baseUrl}/api/admin/registrations/R20260627002/certificate`, {
      method: "POST",
      body: JSON.stringify({
        actorUserId: "U9001",
        fileName: "zhou.pdf",
        fileContentBase64: Buffer.from("%PDF-1.4 draft").toString("base64"),
        certificateNo: "CERT-001"
      }),
      headers: { "Content-Type": "application/json" }
    });
    assert.equal(draftRes.status, 201);

    const hiddenRes = await fetch(`${baseUrl}/api/me/certificates?userId=U2001`);
    assert.equal(hiddenRes.status, 200);
    assert.deepEqual((await json(hiddenRes)).rows, []);

    const certificate = (await json(draftRes)).row;
    const publishRes = await fetch(`${baseUrl}/api/admin/certificates/${certificate.id}/publish`, {
      method: "PATCH",
      body: JSON.stringify({ actorUserId: "U9001", status: "published" }),
      headers: { "Content-Type": "application/json" }
    });
    assert.equal(publishRes.status, 200);

    const visibleRes = await fetch(`${baseUrl}/api/me/certificates?userId=U2001`);
    const visible = await json(visibleRes);
    assert.equal(visible.rows.length, 1);
    assert.equal(visible.rows[0].certificateNo, "CERT-001");
  });
});

test("organization certificate query includes active members and excludes pending members", async () => {
  await withServer(async (baseUrl) => {
    const pendingUserRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      body: JSON.stringify({ name: "待审核家长", phone: "13600000001", password: "Strong123" }),
      headers: { "Content-Type": "application/json" }
    });
    const pendingUser = (await json(pendingUserRes)).user;
    await fetch(`${baseUrl}/api/organizations/request`, {
      method: "POST",
      body: JSON.stringify({ userId: pendingUser.id, organizationId: "O1001", note: "测试待审核成员" }),
      headers: { "Content-Type": "application/json" }
    });

    const uploadRes = await fetch(`${baseUrl}/api/admin/registrations/R20260627001/certificate`, {
      method: "POST",
      body: JSON.stringify({
        actorUserId: "U9001",
        fileName: "chen.pdf",
        fileContentBase64: Buffer.from("%PDF-1.4 active").toString("base64"),
        certificateNo: "CERT-ACTIVE"
      }),
      headers: { "Content-Type": "application/json" }
    });
    const certificate = (await json(uploadRes)).row;
    await fetch(`${baseUrl}/api/admin/certificates/${certificate.id}/publish`, {
      method: "PATCH",
      body: JSON.stringify({ actorUserId: "U9001", status: "published" }),
      headers: { "Content-Type": "application/json" }
    });

    const orgRes = await fetch(`${baseUrl}/api/organizations/O1001/certificates?actorUserId=U2001`);
    assert.equal(orgRes.status, 200);
    const rows = (await json(orgRes)).rows;
    assert.deepEqual(rows.map((row) => row.certificateNo), ["CERT-ACTIVE"]);
  });
});

test("batch certificate upload reports matched, unmatched, and ambiguous files", async () => {
  await withServer(async (baseUrl) => {
    const duplicateRegistration = {
      userId: "U1001",
      organizationId: "O1001",
      source: "普通用户",
      athlete: { name: "陈宇航", school: "温州市实验小学", grade: "五年级", phone: "13800000099" },
      group: "小学中高组（4-6年级）",
      projectId: "rocket-duration",
      instructor: "林老师"
    };
    const createRes = await fetch(`${baseUrl}/api/registrations`, {
      method: "POST",
      body: JSON.stringify(duplicateRegistration),
      headers: { "Content-Type": "application/json" }
    });
    assert.equal(createRes.status, 201);

    const zip = new AdmZip();
    zip.addFile("周星言_温州市第二实验中学_无人机竞速接力比赛.pdf", Buffer.from("%PDF matched"));
    zip.addFile("不存在_未知学校_无人机竞速接力比赛.pdf", Buffer.from("%PDF unmatched"));
    zip.addFile("陈宇航_温州市实验小学_比赛.pdf", Buffer.from("%PDF ambiguous"));
    const form = new FormData();
    form.append("actorUserId", "U9001");
    form.append("zip", new Blob([zip.toBuffer()], { type: "application/zip" }), "certificates.zip");

    const batchRes = await fetch(`${baseUrl}/api/admin/certificates/batch`, { method: "POST", body: form });
    assert.equal(batchRes.status, 200);
    const result = await json(batchRes);
    assert.equal(result.matched.length, 1);
    assert.equal(result.unmatched.length, 1);
    assert.equal(result.ambiguous.length, 1);
  });
});
