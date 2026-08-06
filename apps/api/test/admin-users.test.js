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
    assert.equal(Object.hasOwn(users.find((user) => user.id === "U1001"), "temporaryPasswordCiphertext"), false);
    assert.equal(Object.hasOwn(organizations[0], "privateStorageMarker"), false);
    assert.equal(Object.hasOwn(organizations[0], "filePath"), false);
  });
});

test("administrator temporary-password reset and read audits contain no secret material", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const reset = await fetch(`${baseUrl}/api/admin/users/U1001/reset-password`, withSession(admin.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
    }));
    assert.equal(reset.status, 200);
    assert.equal(reset.headers.get("cache-control"), "no-store, private");
    assert.equal(reset.headers.get("pragma"), "no-cache");
    assert.equal(reset.headers.get("expires"), "0");
    const temporaryPassword = (await reset.json()).temporaryPassword;
    const viewed = await fetch(`${baseUrl}/api/admin/users/U1001/temporary-password`, withSession(admin.cookie));
    assert.equal(viewed.status, 200);
    assert.equal(viewed.headers.get("cache-control"), "no-store, private");
    assert.equal(viewed.headers.get("pragma"), "no-cache");
    assert.equal(viewed.headers.get("expires"), "0");
    assert.equal((await viewed.json()).temporaryPassword, temporaryPassword);

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const auditText = JSON.stringify(persisted.auditLogs.filter((row) => row.targetId === "U1001"));
    assert.match(auditText, /user\.password-reset/);
    assert.match(auditText, /user\.temporary-password-view/);
    assert.doesNotMatch(auditText, new RegExp(temporaryPassword));
    assert.doesNotMatch(auditText, /temporaryPasswordCiphertext|passwordHash|\$2[aby]\$/i);
  });
});

test("admin creates an ordinary user with a system-generated repeat-viewable temporary password", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const createRes = await fetch(`${baseUrl}/api/admin/users`, withSession(admin.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "测试家长", phone: "13600001111", password: "CallerChosen9", type: "ordinary" })
    }));
    assert.equal(createRes.status, 201);
    assert.equal(createRes.headers.get("cache-control"), "no-store, private");
    assert.equal(createRes.headers.get("pragma"), "no-cache");
    assert.equal(createRes.headers.get("expires"), "0");
    const createPayload = await asJson(createRes);
    const created = createPayload.row;
    assert.equal(created.type, "ordinary");
    assert.equal(created.mustChangePassword, true);
    assert.match(createPayload.temporaryPassword, /[A-Za-z]/);
    assert.notEqual(createPayload.temporaryPassword, "CallerChosen9");

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8")).users.find((row) => row.id === created.id);
    assert.equal(persisted.sessionVersion, 1);
    assert.equal(persisted.mustChangePassword, true);
    assert.match(persisted.password, /^\$2/);
    assert.ok(persisted.temporaryPasswordCiphertext);

    const callerChosenLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13600001111", password: "CallerChosen9" })
    });
    assert.equal(callerChosenLogin.status, 401);
    const temporaryLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13600001111", password: createPayload.temporaryPassword })
    });
    assert.equal(temporaryLogin.status, 200);
    const temporaryCookie = temporaryLogin.headers.get("set-cookie")?.split(";")[0];
    assert.equal((await temporaryLogin.json()).user.mustChangePassword, true);

    const changed = await fetch(`${baseUrl}/api/auth/change-password`, withSession(temporaryCookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: createPayload.temporaryPassword, newPassword: "NextGeneratedPass2" })
    }));
    assert.equal(changed.status, 200);
    const opened = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(admin.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationMode: "force_open" })
    }));
    assert.equal(opened.status, 200);
    const unaffiliated = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(temporaryCookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "paper-plane-gate",
        athlete: { name: "Unaffiliated", school: "Test school", grade: "五年级", phone: "13600001111" }
      })
    }));
    assert.equal(unaffiliated.status, 403);
    assert.equal((await unaffiliated.json()).code, "ACTIVE_ORGANIZATION_REQUIRED");

    const viewed = await fetch(`${baseUrl}/api/admin/users/${created.id}/temporary-password`, withSession(admin.cookie));
    assert.equal(viewed.status, 404);

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

test("admin user creation fails closed without a temporary-password key and creates no partial user", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const response = await fetch(`${baseUrl}/api/admin/users`, withSession(admin.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "不得创建", phone: "13600009999", type: "ordinary" })
    }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "TEMP_PASSWORD_KEY_UNAVAILABLE");
    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(persisted.users.some((row) => row.phone === "13600009999"), false);
  }, { prefix: "wz-admin-create-no-key-", env: { TEMP_PASSWORD_ENCRYPTION_KEY: "" } });
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

test("admin cannot downgrade an organization owner to ordinary", async () => {
  await withServer(async (baseUrl, { dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const response = await fetch(`${baseUrl}/api/admin/users/U2001`, withSession(admin.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ordinary" })
    }));
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "ORGANIZATION_OWNER_TYPE_IMMUTABLE");
    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(persisted.users.find((user) => user.id === "U2001").type, "organization");
    assert.equal(persisted.organizations.some((organization) => organization.ownerUserId === "U2001"), true);
  });
});
