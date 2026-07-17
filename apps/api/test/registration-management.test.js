import assert from "node:assert/strict";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function json(response) {
  return response.json();
}

async function withServer(fn) {
  await withTestServer(({ baseUrl }) => fn(baseUrl), { prefix: "wz-registration-api-" });
}

async function openRegistration(baseUrl, cookie) {
  const response = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(cookie, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ registrationMode: "force_open" })
  }));
  assert.equal(response.status, 200);
}

test("registration context defaults exactly one active organization and school search deduplicates approved sources", async () => {
  await withServer(async (baseUrl) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const contextResponse = await fetch(`${baseUrl}/api/me/registration-context`, withSession(ordinary.cookie));
    assert.equal(contextResponse.status, 200);
    const context = await json(contextResponse);
    assert.equal(context.defaultOrganizationId, "O1001");
    assert.deepEqual(context.organizations.map((organization) => organization.id), ["O1001"]);
    assert.deepEqual(context.grades.map((group) => group.name), ["小学低段", "小学高段", "中学组", "职高/高中组"]);

    const schoolsResponse = await fetch(`${baseUrl}/api/schools?q=%E5%AE%9E%E9%AA%8C`, withSession(ordinary.cookie));
    assert.equal(schoolsResponse.status, 200);
    const schools = await json(schoolsResponse);
    assert.deepEqual(schools.rows, ["温州市实验小学", "温州市第二实验中学"]);
  });
});

test("registration derives the group from actual grade and rejects a project outside that group", async () => {
  await withServer(async (baseUrl) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await openRegistration(baseUrl, admin.cookie);

    const checkResponse = await fetch(`${baseUrl}/api/registrations/check`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        athlete: { name: "派生组别学生", school: "温州市实验小学", grade: "五年级", phone: "13800000031" },
        group: "伪造组别", projectId: "paper-plane-gate"
      })
    }));
    assert.equal(checkResponse.status, 200);

    const createdResponse = await fetch(`${baseUrl}/api/registrations`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId: "O1001",
        athlete: { name: "派生组别学生", school: "温州市实验小学", grade: "五年级", phone: "13800000031" },
        group: "中学组",
        projectId: "paper-plane-gate",
        instructor: "林老师"
      })
    }));
    assert.equal(createdResponse.status, 201);
    assert.equal((await json(createdResponse)).row.group, "小学高段");

    const projectResponse = await fetch(`${baseUrl}/api/admin/projects/rocket-duration`, withSession(admin.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "带降航天火箭留空比赛", type: "individual", category: "青少年航模比赛", enabled: true,
        instructorRequired: false, displayOrder: 1, allowedGroups: ["小学低段"]
      })
    }));
    assert.equal(projectResponse.status, 200);
    const deniedResponse = await fetch(`${baseUrl}/api/registrations`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        athlete: { name: "不适用学生", school: "自定义学校", grade: "五年级", phone: "13800000032" },
        group: "小学低段", projectId: "rocket-duration"
      })
    }));
    assert.equal(deniedResponse.status, 422);
  });
});

test("admin registration listing filters and paginates rows with actual grade and result fields", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const response = await fetch(`${baseUrl}/api/admin/registrations?group=%E4%B8%AD%E5%AD%A6%E7%BB%84&q=%E7%8E%8B%E8%80%81%E5%B8%88&page=1&pageSize=10`, withSession(admin.cookie));
    assert.equal(response.status, 200);
    const payload = await json(response);
    assert.equal(payload.total, 1);
    assert.equal(payload.page, 1);
    assert.equal(payload.pageSize, 10);
    assert.match(payload.refreshedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(payload.rows[0].instructor, "王老师");
    assert.equal(payload.rows[0].athlete.grade, "初二");
    assert.equal(payload.rows[0].awardName, "");
    assert.equal(payload.rows[0].score, "");

    const legacyResponse = await fetch(`${baseUrl}/api/registrations?q=%E7%8E%8B%E8%80%81%E5%B8%88&pageSize=10`, withSession(admin.cookie));
    assert.equal(legacyResponse.status, 200);
    const legacyPayload = await json(legacyResponse);
    assert.equal(legacyPayload.total, 1);
    assert.equal(legacyPayload.pageSize, 10);
    assert.match(legacyPayload.refreshedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("registration status changes enforce the owner's event window while administrators bypass it", async () => {
  await withServer(async (baseUrl) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const status = (id, payload, cookie) => fetch(`${baseUrl}/api/registrations/${id}/status`, withSession(cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    }));

    assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationMode: "force_closed" })
    }))).status, 200);
    assert.equal((await status("R20260627001", { status: "cancelled" }, ordinary.cookie)).status, 409);
    assert.equal((await status("R20260627002", { status: "rejected" }, admin.cookie)).status, 200);

    assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationMode: "automatic" })
    }))).status, 200);
    assert.equal((await status("R20260627001", { status: "cancelled" }, ordinary.cookie)).status, 409);

    await openRegistration(baseUrl, admin.cookie);
    assert.equal((await status("R20260627002", { status: "cancelled" }, ordinary.cookie)).status, 403);
    assert.equal((await status("R20260627001", { status: "approved" }, ordinary.cookie)).status, 403);
    assert.equal((await status("R20260627001", { status: "cancelled" }, ordinary.cookie)).status, 200);
  });
});

test("ordinary registration edits require an active membership while administrators may use any operational organization", async () => {
  await withServer(async (baseUrl) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await openRegistration(baseUrl, admin.cookie);
    const patch = (path, payload, cookie) => fetch(`${baseUrl}${path}`, withSession(cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    }));

    assert.equal((await patch("/api/registrations/R20260627001", { organizationId: "O1002" }, ordinary.cookie)).status, 403);
    const adminResponse = await patch("/api/admin/registrations/R20260627001", { organizationId: "O1002" }, admin.cookie);
    assert.equal(adminResponse.status, 200);
    assert.equal((await json(adminResponse)).row.organizationId, "O1002");
  });
});
