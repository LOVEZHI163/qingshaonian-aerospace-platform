import fs from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function withServer(fn) {
  await withTestServer((context) => fn(context.baseUrl, context), { prefix: "wz-admin-users-" });
}

const asJson = (res) => res.json();

test("admin global user and organization DTOs never expose storage or session internals", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.users.find((user) => user.id === "U1001").privateAuditToken = "do-not-leak";
    db.organizations[0].privateStorageMarker = "do-not-leak";
    await fs.writeFile(dbPath, JSON.stringify(db), "utf8");

    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const users = (await asJson(await fetch(`${baseUrl}/api/users`, withSession(admin.cookie)))).rows;
    const organizations = (await asJson(await fetch(`${baseUrl}/api/admin/organizations?eventId=wz-aerospace-2026`, withSession(admin.cookie)))).rows;

    assert.equal(Object.hasOwn(users.find((user) => user.id === "U1001"), "privateAuditToken"), false);
    assert.equal(Object.hasOwn(users.find((user) => user.id === "U1001"), "password"), false);
    assert.equal(Object.hasOwn(organizations[0], "privateStorageMarker"), false);
    assert.equal(Object.hasOwn(organizations[0], "filePath"), false);
  });
});

test("admin can create, update, and delete an ordinary user", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const createRes = await fetch(`${baseUrl}/api/admin/users`, withSession(admin.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "测试家长", phone: "13600001111", password: "Strong123", type: "ordinary" })
    }));
    assert.equal(createRes.status, 201);
    const created = (await asJson(createRes)).row;
    assert.equal(created.type, "ordinary");

    const updateRes = await fetch(`${baseUrl}/api/admin/users/${created.id}`, {
      ...withSession(admin.cookie),
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie },
      body: JSON.stringify({ name: "测试家长改", phone: "13600002222", status: "disabled" })
    });
    assert.equal(updateRes.status, 200);
    assert.equal((await asJson(updateRes)).row.status, "disabled");

    const deleteRes = await fetch(`${baseUrl}/api/admin/users/${created.id}`, withSession(admin.cookie, { method: "DELETE" }));
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

test("admin user management rejects organization creation and conversion without credential review", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const createRes = await fetch(`${baseUrl}/api/admin/users`, withSession(admin.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "领队老师",
        phone: "13600003333",
        password: "Strong123",
        type: "organization",
        organizationName: "测试学校",
        organizationCode: "TEST-SCHOOL"
      })
    }));
    assert.equal(createRes.status, 422);

    const ordinaryRes = await fetch(`${baseUrl}/api/admin/users`, withSession(admin.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "待转换家长", phone: "13600003334", password: "Strong123", type: "ordinary" })
    }));
    assert.equal(ordinaryRes.status, 201);
    const ordinary = await asJson(ordinaryRes);
    const updateRes = await fetch(`${baseUrl}/api/admin/users/${ordinary.row.id}`, withSession(admin.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "organization", organizationName: "测试学校改", organizationCode: "TEST-NEW" })
    }));
    assert.equal(updateRes.status, 422);

    const orgs = await asJson(await fetch(`${baseUrl}/api/organizations`, withSession(admin.cookie)));
    assert.equal(orgs.rows.some((org) => org.code === "TEST-NEW" || org.code === "TEST-SCHOOL"), false);
  });
});

test("admin patch rejects a historical organization user whose owned organization is missing", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.organizations = db.organizations.filter((organization) => organization.ownerUserId !== "U2001");
    db.memberships = db.memberships.filter((membership) => membership.userId !== "U2001");
    await fs.writeFile(dbPath, JSON.stringify(db), "utf8");

    const update = await fetch(`${baseUrl}/api/admin/users/U2001`, withSession(admin.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationName: "不得补建的历史组织" })
    }));
    assert.equal(update.status, 422);
    assert.match((await update.json()).error, /资质|组织|重新注册/);
  });
});
