import assert from "node:assert/strict";
import test from "node:test";
import { withTestServer } from "../test-support/server.js";

async function withServer(fn) {
  await withTestServer(({ baseUrl }) => fn(baseUrl), { prefix: "wz-admin-users-" });
}

const asJson = (res) => res.json();

test("admin can create, update, and delete an ordinary user", async () => {
  await withServer(async (baseUrl) => {
    const createRes = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorUserId: "U9001", name: "测试家长", phone: "13600001111", password: "Strong123", type: "ordinary" })
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
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900000000", password: "admin123" })
    });
    const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
    const usersRes = await fetch(`${baseUrl}/api/users`, { headers: { Cookie: cookie } });
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
        password: "Strong123",
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
