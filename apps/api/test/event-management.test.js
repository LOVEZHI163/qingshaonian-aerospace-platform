import assert from "node:assert/strict";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function withServer(fn) {
  await withTestServer(({ baseUrl, dbPath }) => fn(baseUrl, dbPath), { prefix: "aerogp-events-" });
}

function jsonOptions(method, body, cookie) {
  return withSession(cookie, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function json(response) {
  return response.json();
}

const eventInput = {
  name: "2027年温州市青少年航空航天创新比赛",
  theme: "飞向未来",
  dateLabel: "2027年10月1-2日",
  venue: "温州科技馆",
  contact: "组委会 0577-12345678",
  registrationStartAt: "2027-08-01T00:00:00.000Z",
  registrationEndAt: "2027-09-20T15:59:59.000Z",
  registrationMode: "automatic"
};

test("event management routes enforce admin sessions and temporary-password readiness", async () => {
  await withServer(async (baseUrl) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const protectedRequests = [
      ["GET", "/api/admin/events"],
      ["POST", "/api/admin/events", eventInput],
      ["PATCH", "/api/admin/events/missing", { theme: "x" }],
      ["POST", "/api/admin/events/missing/copy", { name: "x" }],
      ["POST", "/api/admin/events/missing/current", {}],
      ["POST", "/api/admin/events/missing/archive", {}],
      ["POST", "/api/admin/events/missing/projects", {}],
      ["PATCH", "/api/admin/projects/missing", {}],
      ["DELETE", "/api/admin/projects/missing"]
    ];
    for (const [method, route, body] of protectedRequests) {
      const options = body === undefined ? { method } : jsonOptions(method, body);
      assert.equal((await fetch(`${baseUrl}${route}`, options)).status, 401, `${method} ${route}`);
      const ordinaryOptions = body === undefined
        ? withSession(ordinary.cookie, { method })
        : jsonOptions(method, body, ordinary.cookie);
      assert.equal((await fetch(`${baseUrl}${route}`, ordinaryOptions)).status, 403, `${method} ${route}`);
    }

    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const reset = await fetch(`${baseUrl}/api/admin/users/U9001/reset-password`, jsonOptions("POST", {
      password: "Temporary9"
    }, admin.cookie));
    assert.equal(reset.status, 200);
    const temporaryAdmin = await loginAs(baseUrl, "13900000000", "Temporary9");
    const blocked = await fetch(`${baseUrl}/api/admin/events`, withSession(temporaryAdmin.cookie));
    assert.equal(blocked.status, 428);
    assert.equal((await json(blocked)).code, "PASSWORD_CHANGE_REQUIRED");
  });
});

test("public event compatibility endpoint keeps the current event payload", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/public/event`);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.event.isCurrent, true);
    assert.equal(body.event.status, "published");
    assert.equal(body.projects.every((row) => row.eventId === body.event.id && row.enabled), true);
    assert.deepEqual(body.groups, body.grades);
    assert.equal(typeof body.registrationWindow.open, "boolean");
  });
});

test("event management creates, validates, copies, publishes, and archives events transactionally", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");

    const forged = await fetch(`${baseUrl}/api/admin/events`, jsonOptions("POST", {
      ...eventInput,
      id: "client-id",
      status: "published",
      isCurrent: true
    }, admin.cookie));
    assert.equal(forged.status, 422);

    const invalidDates = await fetch(`${baseUrl}/api/admin/events`, jsonOptions("POST", {
      ...eventInput,
      registrationStartAt: "not-a-date"
    }, admin.cookie));
    assert.equal(invalidDates.status, 422);
    for (const registrationStartAt of [
      "2027/08/01",
      "2027-08-01",
      "2027-08-01T00:00:00",
      "2027-02-30T00:00:00.000Z"
    ]) {
      const looseDate = await fetch(`${baseUrl}/api/admin/events`, jsonOptions("POST", {
        ...eventInput,
        registrationStartAt
      }, admin.cookie));
      assert.equal(looseDate.status, 422, registrationStartAt);
    }
    const invalidOrder = await fetch(`${baseUrl}/api/admin/events`, jsonOptions("POST", {
      ...eventInput,
      registrationStartAt: eventInput.registrationEndAt
    }, admin.cookie));
    assert.equal(invalidOrder.status, 422);
    const invalidMode = await fetch(`${baseUrl}/api/admin/events`, jsonOptions("POST", {
      ...eventInput,
      registrationMode: "sometimes"
    }, admin.cookie));
    assert.equal(invalidMode.status, 422);

    const create = await fetch(`${baseUrl}/api/admin/events`, jsonOptions("POST", eventInput, admin.cookie));
    assert.equal(create.status, 201);
    const created = (await json(create)).row;
    assert.equal(created.status, "draft");
    assert.equal(created.isCurrent, false);
    assert.equal(created.dateLabel, eventInput.dateLabel);
    assert.equal(created.archivedAt, null);

    const patched = await fetch(`${baseUrl}/api/admin/events/${created.id}`, jsonOptions("PATCH", {
      theme: "新主题",
      status: "archived",
      unknownField: "ignored"
    }, admin.cookie));
    assert.equal(patched.status, 200);
    const patchedRow = (await json(patched)).row;
    assert.equal(patchedRow.theme, "新主题");
    assert.equal(patchedRow.status, "draft");
    assert.equal("unknownField" in patchedRow, false);
    const invalidPatch = await fetch(`${baseUrl}/api/admin/events/${created.id}`, jsonOptions("PATCH", {
      registrationEndAt: created.registrationStartAt
    }, admin.cookie));
    assert.equal(invalidPatch.status, 422);
    assert.equal((await json(await fetch(`${baseUrl}/api/admin/events`, withSession(admin.cookie)))).rows
      .find((row) => row.id === created.id).registrationEndAt, created.registrationEndAt);

    const source = await fetch(`${baseUrl}/api/admin/events`, withSession(admin.cookie));
    const sourcePayload = await json(source);
    const current = sourcePayload.rows.find((row) => row.isCurrent);
    const sourceProjects = sourcePayload.projects.filter((row) => row.eventId === current.id);
    assert.equal(sourceProjects.length > 0, true);

    const copied = await fetch(`${baseUrl}/api/admin/events/${current.id}/copy`, jsonOptions("POST", {
      name: "2026年温州市青少年航空航天创新比赛（副本）"
    }, admin.cookie));
    assert.equal(copied.status, 201);
    const copy = await json(copied);
    assert.equal(copy.event.status, "draft");
    assert.equal(copy.event.isCurrent, false);
    assert.equal(copy.projects.length, sourceProjects.length);
    assert.equal(copy.projects.every((row) => row.eventId === copy.event.id), true);
    assert.equal(copy.projects.every((row) => !sourceProjects.some((sourceRow) => sourceRow.id === row.id)), true);
    assert.equal(copy.projects.every((row) => row.allowedGroups.length === 4), true);
    assert.equal(copy.registrationCount, 0);
    const registrations = await json(await fetch(`${baseUrl}/api/admin/events/${current.id}/registrations`, withSession(admin.cookie)));
    assert.equal(registrations.rows.some((row) => row.eventId === copy.event.id), false);

    const setCurrent = await fetch(`${baseUrl}/api/admin/events/${copy.event.id}/current`, jsonOptions("POST", {}, admin.cookie));
    assert.equal(setCurrent.status, 200);
    const afterCurrent = await json(await fetch(`${baseUrl}/api/admin/events`, withSession(admin.cookie)));
    assert.equal(afterCurrent.rows.filter((row) => row.isCurrent).length, 1);
    assert.equal(afterCurrent.rows.find((row) => row.id === copy.event.id).status, "published");

    const archived = await fetch(`${baseUrl}/api/admin/events/${copy.event.id}/archive`, jsonOptions("POST", {}, admin.cookie));
    assert.equal(archived.status, 200);
    assert.equal((await json(archived)).row.status, "archived");
    const cannotRestoreImplicitly = await fetch(`${baseUrl}/api/admin/events/${copy.event.id}/current`, jsonOptions("POST", {}, admin.cookie));
    assert.equal(cannotRestoreImplicitly.status, 409);
    assert.equal((await fetch(`${baseUrl}/api/admin/events/missing/archive`, jsonOptions("POST", {}, admin.cookie))).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/admin/events/missing/copy`, jsonOptions("POST", { name: "不存在" }, admin.cookie))).status, 404);
  });
});

test("event management rejects non-object JSON bodies with validation errors", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    for (const body of [null, [], "invalid"]) {
      assert.equal((await fetch(`${baseUrl}/api/admin/events`, jsonOptions("POST", body, admin.cookie))).status, 422);
      assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, jsonOptions("PATCH", body, admin.cookie))).status, 422);
      assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/copy`, jsonOptions("POST", body, admin.cookie))).status, 422);
      assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/projects`, jsonOptions("POST", body, admin.cookie))).status, 422);
      assert.equal((await fetch(`${baseUrl}/api/admin/projects/rocket-duration`, jsonOptions("PATCH", body, admin.cookie))).status, 422);
      assert.equal((await fetch(`${baseUrl}/api/auth/login`, jsonOptions("POST", body))).status, 422);
      assert.equal((await fetch(`${baseUrl}/api/auth/register`, jsonOptions("POST", body))).status, 422);
    }
  });
});

test("project management validates fixed groups and prevents deleting historical registrations", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const events = await json(await fetch(`${baseUrl}/api/admin/events`, withSession(admin.cookie)));
    const current = events.rows.find((row) => row.isCurrent);
    assert.equal((await fetch(`${baseUrl}/api/admin/events/missing/projects`, jsonOptions("POST", {
      name: "未知赛事项目", type: "individual", category: "测试", enabled: true,
      instructorRequired: false, displayOrder: 0, allowedGroups: ["小学低段"]
    }, admin.cookie))).status, 404);

    for (const body of [
      { name: "", type: "individual", category: "航模", enabled: true, instructorRequired: false, displayOrder: 0, allowedGroups: ["小学低段"] },
      { name: "测试赛项", type: "solo", category: "航模", enabled: true, instructorRequired: false, displayOrder: 0, allowedGroups: ["小学低段"] },
      { name: "测试赛项", type: "individual", category: "航模", enabled: "yes", instructorRequired: false, displayOrder: 0, allowedGroups: ["小学低段"] },
      { name: "测试赛项", type: "individual", category: "航模", enabled: true, instructorRequired: false, displayOrder: -1, allowedGroups: ["小学低段"] },
      { name: "测试赛项", type: "individual", category: "航模", enabled: true, instructorRequired: false, displayOrder: 0, allowedGroups: [] },
      { name: "测试赛项", type: "individual", category: "航模", enabled: true, instructorRequired: false, displayOrder: 0, allowedGroups: ["大学组"] }
    ]) {
      const response = await fetch(`${baseUrl}/api/admin/events/${current.id}/projects`, jsonOptions("POST", body, admin.cookie));
      assert.equal(response.status, 422, JSON.stringify(body));
    }

    const create = await fetch(`${baseUrl}/api/admin/events/${current.id}/projects`, jsonOptions("POST", {
      name: "创新飞行测试赛",
      type: "individual",
      category: "航空创新",
      enabled: true,
      instructorRequired: true,
      displayOrder: 99,
      allowedGroups: ["小学低段", "小学低段", "中学组"]
    }, admin.cookie));
    assert.equal(create.status, 201);
    const project = (await json(create)).row;
    assert.deepEqual(project.allowedGroups, ["小学低段", "中学组"]);

    const immovable = await fetch(`${baseUrl}/api/admin/projects/${project.id}`, jsonOptions("PATCH", {
      eventId: "another-event",
      id: "another-id",
      enabled: false
    }, admin.cookie));
    assert.equal(immovable.status, 422);

    const updated = await fetch(`${baseUrl}/api/admin/projects/${project.id}`, jsonOptions("PATCH", {
      enabled: false,
      allowedGroups: ["职高/高中组"]
    }, admin.cookie));
    assert.equal(updated.status, 200);
    assert.deepEqual((await json(updated)).row.allowedGroups, ["职高/高中组"]);

    assert.equal((await fetch(`${baseUrl}/api/admin/projects/${project.id}`, withSession(admin.cookie, { method: "DELETE" }))).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/admin/projects/paper-plane-gate`, withSession(admin.cookie, { method: "DELETE" }))).status, 409);
    const disabledHistorical = await fetch(`${baseUrl}/api/admin/projects/paper-plane-gate`, jsonOptions("PATCH", { enabled: false }, admin.cookie));
    assert.equal(disabledHistorical.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/admin/projects/missing`, jsonOptions("PATCH", { enabled: false }, admin.cookie))).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/admin/projects/missing`, withSession(admin.cookie, { method: "DELETE" }))).status, 404);

    const createOnArchived = await fetch(`${baseUrl}/api/admin/events/${current.id}/archive`, jsonOptions("POST", {}, admin.cookie));
    assert.equal(createOnArchived.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/admin/events/${current.id}/projects`, jsonOptions("POST", {
      name: "归档后赛项", type: "team", category: "测试", enabled: true,
      instructorRequired: false, displayOrder: 1, allowedGroups: ["小学低段"]
    }, admin.cookie))).status, 409);
  });
});

test("project submission mode is validated, defaults to none, and is returned by registration context", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const events = await json(await fetch(`${baseUrl}/api/admin/events`, withSession(admin.cookie)));
    const current = events.rows.find((row) => row.isCurrent);
    assert.equal((await fetch(`${baseUrl}/api/admin/events/${current.id}`, jsonOptions("PATCH", {
      registrationMode: "force_open"
    }, admin.cookie))).status, 200);

    const imageVideoResponse = await fetch(`${baseUrl}/api/admin/events/${current.id}/projects`, jsonOptions("POST", {
      name: "绘画赛",
      type: "individual",
      category: "美术",
      enabled: true,
      instructorRequired: false,
      displayOrder: 90,
      allowedGroups: ["小学低段"],
      submissionMode: "image_video"
    }, admin.cookie));
    assert.equal(imageVideoResponse.status, 201);
    const imageVideoProject = (await json(imageVideoResponse)).row;
    assert.equal(imageVideoProject.submissionMode, "image_video");

    const adminProjects = await json(await fetch(`${baseUrl}/api/admin/events`, withSession(admin.cookie)));
    assert.equal(adminProjects.projects.find((row) => row.id === imageVideoProject.id).submissionMode, "image_video");

    const contextResponse = await fetch(
      `${baseUrl}/api/me/registration-context?eventId=${encodeURIComponent(current.id)}`,
      withSession(ordinary.cookie)
    );
    assert.equal(contextResponse.status, 200);
    const context = await json(contextResponse);
    assert.equal(context.projects.find((row) => row.id === imageVideoProject.id).submissionMode, "image_video");

    const invalid = await fetch(`${baseUrl}/api/admin/events/${current.id}/projects`, jsonOptions("POST", {
      name: "无效作品类型赛项",
      type: "individual",
      category: "美术",
      enabled: true,
      instructorRequired: false,
      displayOrder: 91,
      allowedGroups: ["小学低段"],
      submissionMode: "video_only"
    }, admin.cookie));
    assert.equal(invalid.status, 422);

    const defaultResponse = await fetch(`${baseUrl}/api/admin/events/${current.id}/projects`, jsonOptions("POST", {
      name: "默认作品类型赛项",
      type: "individual",
      category: "美术",
      enabled: true,
      instructorRequired: false,
      displayOrder: 92,
      allowedGroups: ["小学低段"]
    }, admin.cookie));
    assert.equal(defaultResponse.status, 201);
    assert.equal((await json(defaultResponse)).row.submissionMode, "none");
  });
});

test("archived events reject event and project mutations without changing stored data", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const createEventResponse = await fetch(`${baseUrl}/api/admin/events`, jsonOptions("POST", eventInput, admin.cookie));
    assert.equal(createEventResponse.status, 201);
    const archivedEvent = (await json(createEventResponse)).row;
    const createProjectResponse = await fetch(`${baseUrl}/api/admin/events/${archivedEvent.id}/projects`, jsonOptions("POST", {
      name: "归档保护赛项",
      type: "individual",
      category: "航空创新",
      enabled: true,
      instructorRequired: false,
      displayOrder: 7,
      allowedGroups: ["小学低段"]
    }, admin.cookie));
    assert.equal(createProjectResponse.status, 201);
    const archivedProject = (await json(createProjectResponse)).row;
    assert.equal((await fetch(`${baseUrl}/api/admin/events/${archivedEvent.id}/archive`, jsonOptions("POST", {}, admin.cookie))).status, 200);

    const before = await json(await fetch(`${baseUrl}/api/admin/events`, withSession(admin.cookie)));
    const beforeEvent = before.rows.find((row) => row.id === archivedEvent.id);
    const beforeProject = before.projects.find((row) => row.id === archivedProject.id);

    assert.equal((await fetch(`${baseUrl}/api/admin/events/${archivedEvent.id}`, jsonOptions("PATCH", {
      theme: "不应写入的新主题"
    }, admin.cookie))).status, 409);
    assert.equal((await fetch(`${baseUrl}/api/admin/projects/${archivedProject.id}`, jsonOptions("PATCH", {
      enabled: false
    }, admin.cookie))).status, 409);
    assert.equal((await fetch(`${baseUrl}/api/admin/projects/${archivedProject.id}`, withSession(admin.cookie, {
      method: "DELETE"
    }))).status, 409);

    const after = await json(await fetch(`${baseUrl}/api/admin/events`, withSession(admin.cookie)));
    assert.deepEqual(after.rows.find((row) => row.id === archivedEvent.id), beforeEvent);
    assert.deepEqual(after.projects.find((row) => row.id === archivedProject.id), beforeProject);
  });
});

test("public event and registration APIs use the current database event in real time", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const events = await json(await fetch(`${baseUrl}/api/admin/events`, withSession(admin.cookie)));
    const current = events.rows.find((row) => row.isCurrent);

    const close = await fetch(`${baseUrl}/api/admin/events/${current.id}`, jsonOptions("PATCH", {
      registrationMode: "force_closed"
    }, admin.cookie));
    assert.equal(close.status, 200);
    const publicClosed = await json(await fetch(`${baseUrl}/api/public/event`));
    assert.equal(publicClosed.event.date, current.dateLabel);
    assert.equal(publicClosed.event.registrationDeadline, "2026-11-01");
    assert.equal(publicClosed.registrationWindow.open, false);
    assert.equal(publicClosed.registrationWindow.reason, "管理员临时关闭");
    assert.deepEqual(publicClosed.groups, ["小学低段", "小学高段", "中学组", "职高/高中组"]);
    assert.deepEqual(publicClosed.grades, publicClosed.groups);

    const closedRegistration = await fetch(`${baseUrl}/api/me/events/${current.id}/registrations`, jsonOptions("POST", {
      athlete: { name: "窗口关闭学生", school: "测试学校", grade: "二年级", phone: "13600003001" },
      group: "小学低段",
      projectId: "rocket-duration"
    }, ordinary.cookie));
    assert.equal(closedRegistration.status, 409);
    const closedCheck = await fetch(`${baseUrl}/api/registrations/check`, jsonOptions("POST", {
      eventId: current.id,
      athlete: { name: "窗口关闭学生", school: "测试学校", grade: "二年级", phone: "13600003001" },
      group: "小学低段",
      projectId: "rocket-duration"
    }, ordinary.cookie));
    assert.equal(closedCheck.status, 409);

    const open = await fetch(`${baseUrl}/api/admin/events/${current.id}`, jsonOptions("PATCH", {
      registrationMode: "force_open",
      registrationStartAt: "2030-01-01T00:00:00.000Z",
      registrationEndAt: "2030-02-01T00:00:00.000Z"
    }, admin.cookie));
    assert.equal(open.status, 200);

    const draft = await fetch(`${baseUrl}/api/admin/events`, jsonOptions("POST", eventInput, admin.cookie));
    const draftEvent = (await json(draft)).row;
    const crossProjectResponse = await fetch(`${baseUrl}/api/admin/events/${draftEvent.id}/projects`, jsonOptions("POST", {
      name: "跨届项目", type: "individual", category: "测试", enabled: true,
      instructorRequired: false, displayOrder: 0, allowedGroups: ["小学低段"]
    }, admin.cookie));
    const crossProject = (await json(crossProjectResponse)).row;
    assert.equal((await fetch(`${baseUrl}/api/me/events/${current.id}/registrations`, jsonOptions("POST", {
      athlete: { name: "跨届学生", school: "测试学校", grade: "二年级", phone: "13600003002" },
      group: "小学低段", projectId: crossProject.id
    }, ordinary.cookie))).status, 422);

    await fetch(`${baseUrl}/api/admin/projects/rocket-duration`, jsonOptions("PATCH", {
      allowedGroups: ["小学低段"]
    }, admin.cookie));
    assert.equal((await fetch(`${baseUrl}/api/me/events/${current.id}/registrations`, jsonOptions("POST", {
      athlete: { name: "不允许组别学生", school: "测试学校", grade: "初二", phone: "13600003003" },
      group: "中学组", projectId: "rocket-duration"
    }, ordinary.cookie))).status, 422);

    await fetch(`${baseUrl}/api/admin/projects/rocket-duration`, jsonOptions("PATCH", { enabled: false }, admin.cookie));
    const publicWithoutDisabled = await json(await fetch(`${baseUrl}/api/public/event`));
    assert.equal(publicWithoutDisabled.projects.some((project) => project.id === "rocket-duration"), false);
    assert.equal((await fetch(`${baseUrl}/api/me/events/${current.id}/registrations`, jsonOptions("POST", {
      athlete: { name: "停用项目学生", school: "测试学校", grade: "二年级", phone: "13600003004" },
      group: "小学低段", projectId: "rocket-duration"
    }, ordinary.cookie))).status, 422);
    await fetch(`${baseUrl}/api/admin/projects/rocket-duration`, jsonOptions("PATCH", { enabled: true }, admin.cookie));

    const mismatchedEvent = await fetch(`${baseUrl}/api/me/events/${current.id}/registrations`, jsonOptions("POST", {
      eventId: draftEvent.id,
      projectName: "伪造项目名",
      projectType: "team",
      athlete: { name: "合法学生", school: "测试学校", grade: "二年级", phone: "13600003005" },
      group: "小学低段",
      projectId: "rocket-duration"
    }, ordinary.cookie));
    assert.equal(mismatchedEvent.status, 422);

    const valid = await fetch(`${baseUrl}/api/me/events/${current.id}/registrations`, jsonOptions("POST", {
      eventId: current.id,
      projectName: "伪造项目名",
      projectType: "team",
      athlete: { name: "合法学生", school: "测试学校", grade: "二年级", phone: "13600003005" },
      group: "小学低段",
      projectId: "rocket-duration"
    }, ordinary.cookie));
    assert.equal(valid.status, 201);
    const validRow = (await json(valid)).row;
    assert.equal(validRow.eventId, current.id);
    assert.equal(validRow.projectName, "带降航天火箭留空比赛");
    assert.equal(validRow.projectType, "individual");

    const unknownAdminProject = await fetch(`${baseUrl}/api/admin/events/${current.id}/registrations/${validRow.id}`, jsonOptions("PATCH", {
      projectId: "missing-project"
    }, admin.cookie));
    assert.equal(unknownAdminProject.status, 409);
    assert.equal((await json(unknownAdminProject)).code, "REGISTRATION_PROJECT_IMMUTABLE");

    await fetch(`${baseUrl}/api/admin/events/${current.id}/archive`, jsonOptions("POST", {}, admin.cookie));
    const unavailable = await fetch(`${baseUrl}/api/public/event`);
    assert.equal(unavailable.status, 503);
    assert.match((await json(unavailable)).error, /当前赛事/);
  });
});

test("archived registrations reject administrator edits even with an explicit event id", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const nextResponse = await fetch(`${baseUrl}/api/admin/events`, jsonOptions("POST", eventInput, admin.cookie));
    const nextEvent = (await json(nextResponse)).row;
    const nextProjectResponse = await fetch(`${baseUrl}/api/admin/events/${nextEvent.id}/projects`, jsonOptions("POST", {
      name: "下一届跨届测试项目",
      type: "individual",
      category: "测试",
      enabled: true,
      instructorRequired: false,
      displayOrder: 0,
      allowedGroups: ["小学高段"]
    }, admin.cookie));
    const nextProject = (await json(nextProjectResponse)).row;

    assert.equal((await fetch(`${baseUrl}/api/admin/events/${nextEvent.id}/current`, jsonOptions("POST", {}, admin.cookie))).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/archive`, jsonOptions("POST", {}, admin.cookie))).status, 200);

    const editArchived = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/registrations/R20260627001`, jsonOptions("PATCH", {
      projectId: "rocket-duration",
      group: "小学高段",
      instructor: "新指导老师"
    }, admin.cookie));
    assert.equal(editArchived.status, 409);
  });
});
