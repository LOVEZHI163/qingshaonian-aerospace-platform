import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wz-admin-users-"));
  const port = 5600 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], {
    cwd: rootDir,
    env: { ...process.env, NODE_ENV: "test", PORT: String(port), DB_PATH: path.join(tempDir, "db.json"), UPLOAD_ROOT: path.join(tempDir, "uploads") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForServer(baseUrl, child);
    await fn(baseUrl);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const asJson = (res) => res.json();

test("admin can create, update, and delete an ordinary user", async () => {
  await withServer(async (baseUrl) => {
    const createRes = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorUserId: "U9001", name: "测试家长", phone: "13600001111", password: "123456", type: "ordinary" })
    });
    assert.equal(createRes.status, 201);
    const created = (await asJson(createRes)).row;
    assert.equal(created.type, "ordinary");

    const updateRes = await fetch(`${baseUrl}/api/admin/users/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorUserId: "U9001", name: "测试家长改", phone: "13600002222", status: "disabled" })
    });
    assert.equal(updateRes.status, 200);
    assert.equal((await asJson(updateRes)).row.status, "disabled");

    const deleteRes = await fetch(`${baseUrl}/api/admin/users/${created.id}?actorUserId=U9001`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    const usersRes = await fetch(`${baseUrl}/api/users`);
    const users = (await asJson(usersRes)).rows;
    assert.equal(users.some((user) => user.id === created.id), false);
  });
});

test("admin organization user CRUD creates and updates owned organization", async () => {
  await withServer(async (baseUrl) => {
    const createRes = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actorUserId: "U9001",
        name: "领队老师",
        phone: "13600003333",
        password: "123456",
        type: "organization",
        organizationName: "测试学校",
        organizationCode: "TEST-SCHOOL"
      })
    });
    assert.equal(createRes.status, 201);
    const created = await asJson(createRes);
    assert.equal(created.organization.name, "测试学校");

    const updateRes = await fetch(`${baseUrl}/api/admin/users/${created.row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorUserId: "U9001", organizationName: "测试学校改", organizationCode: "TEST-NEW" })
    });
    assert.equal(updateRes.status, 200);
    const updated = await asJson(updateRes);
    assert.equal(updated.organization.name, "测试学校改");

    const deleteRes = await fetch(`${baseUrl}/api/admin/users/${created.row.id}?actorUserId=U9001`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    const orgs = await asJson(await fetch(`${baseUrl}/api/organizations`));
    assert.equal(orgs.rows.some((org) => org.ownerUserId === created.row.id), false);
  });
});
