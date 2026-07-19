import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

async function json(response) {
  return response.json();
}

async function withServer(fn) {
  await withTestServer(({ baseUrl, dbPath }) => fn(baseUrl, dbPath), { prefix: "wz-registration-api-" });
}

async function mutateDb(dbPath, mutate) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  mutate(db);
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
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
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await openRegistration(baseUrl, admin.cookie);
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

test("legacy current event without a profile is rejected explicitly once public profiles exist", async () => {
  await withServer(async (baseUrl, dbPath) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.eventPublicProfiles.push({ eventId: "OTHER", slug: "other", isVisible: false });
    });

    const response = await fetch(
      `${baseUrl}/api/me/registration-context?eventId=wz-aerospace-2026`,
      withSession(ordinary.cookie)
    );
    assert.equal(response.status, 409);
    assert.match((await json(response)).error, /未公开/);
  });
});

test("legacy current event without a profile is not an implicit candidate once public profiles exist", async () => {
  await withServer(async (baseUrl, dbPath) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.eventPublicProfiles.push({ eventId: "OTHER", slug: "other", isVisible: false });
    });

    const response = await fetch(`${baseUrl}/api/me/registration-context`, withSession(ordinary.cookie));
    assert.equal(response.status, 422);
    assert.match((await json(response)).error, /没有可报名赛事|选择赛事/);
  });
});

test("event context requires an explicit selection when multiple published events accept registration", async () => {
  await withServer(async (baseUrl, dbPath) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.eventPublicProfiles.push({ eventId: db.events[0].id, slug: "event-one", isVisible: true });
      db.events.push({
        ...structuredClone(db.events[0]),
        id: "E2",
        name: "第二场公开赛事",
        isCurrent: false
      });
      db.projects.push({
        ...structuredClone(db.projects[0]),
        id: "P-E2",
        eventId: "E2",
        name: "第二场纸飞机"
      });
      db.eventPublicProfiles.push({ eventId: "E2", slug: "event-two", isVisible: true });
    });

    const ambiguous = await fetch(`${baseUrl}/api/me/registration-context`, withSession(ordinary.cookie));
    assert.equal(ambiguous.status, 422);
    assert.match((await json(ambiguous)).error, /选择赛事/);

    const selected = await fetch(`${baseUrl}/api/me/registration-context?eventId=E2`, withSession(ordinary.cookie));
    assert.equal(selected.status, 200);
    const selectedContext = await json(selected);
    assert.equal(selectedContext.event.id, "E2");
    assert.deepEqual(selectedContext.projects.map((project) => project.id), ["P-E2"]);

    const mismatch = await fetch(`${baseUrl}/api/registrations/check`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: "E2",
        athlete: { name: "跨赛事学生", school: "测试学校", grade: "二年级", phone: "13600004001" },
        projectId: "rocket-duration"
      })
    }));
    assert.equal(mismatch.status, 422);
    assert.match((await json(mismatch)).error, /赛项不属于/);

    const created = await fetch(`${baseUrl}/api/registrations`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: "E2",
        athlete: { name: "第二场学生", school: "测试学校", grade: "二年级", phone: "13600004002" },
        projectId: "P-E2"
      })
    }));
    assert.equal(created.status, 201);
    assert.equal((await json(created)).row.eventId, "E2");
  });
});

test("event context rejects unknown, hidden, archived, draft and closed events", async () => {
  await withServer(async (baseUrl, dbPath) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const request = (eventId) => fetch(
      `${baseUrl}/api/me/registration-context?eventId=${encodeURIComponent(eventId)}`,
      withSession(ordinary.cookie)
    );

    assert.equal((await request("missing-event")).status, 422);

    await mutateDb(dbPath, (db) => {
      db.events.push({ ...structuredClone(db.events[0]), id: "UNPUBLISHED-PROFILE", isCurrent: false, registrationMode: "force_open" });
    });
    assert.equal((await request("UNPUBLISHED-PROFILE")).status, 409);
    await mutateDb(dbPath, (db) => {
      db.events = db.events.filter((event) => event.id !== "UNPUBLISHED-PROFILE");
    });

    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.eventPublicProfiles.push({ eventId: db.events[0].id, slug: "hidden-event", isVisible: false });
    });
    assert.equal((await request("wz-aerospace-2026")).status, 409);

    await mutateDb(dbPath, (db) => {
      db.eventPublicProfiles[0].isVisible = true;
      db.events[0].status = "draft";
    });
    assert.equal((await request("wz-aerospace-2026")).status, 409);

    await mutateDb(dbPath, (db) => {
      db.events[0].status = "archived";
      db.events[0].archivedAt = "2026-07-19T00:00:00.000Z";
    });
    assert.equal((await request("wz-aerospace-2026")).status, 409);

    await mutateDb(dbPath, (db) => {
      db.events[0].status = "published";
      db.events[0].archivedAt = null;
      db.events[0].registrationMode = "force_closed";
    });
    const closed = await request("wz-aerospace-2026");
    assert.equal(closed.status, 409);
    assert.match((await json(closed)).error, /关闭/);
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

test("admin registration listing filters athleteName only against the athlete name", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const response = await fetch(
      `${baseUrl}/api/admin/registrations?eventId=wz-aerospace-2026&status=approved&athleteName=${encodeURIComponent("周星言")}&pageSize=10`,
      withSession(admin.cookie)
    );
    assert.equal(response.status, 200);
    const payload = await json(response);
    assert.equal(payload.total, 1);
    assert.deepEqual(payload.rows.map((row) => row.id), ["R20260627002"]);
    assert.equal(payload.rows.every((row) => row.status === "approved"), true);
    assert.equal(payload.rows.every((row) => row.athlete.name.includes("周星言")), true);

    const noFalsePositive = await fetch(
      `${baseUrl}/api/admin/registrations?athleteName=${encodeURIComponent("王老师")}&pageSize=10`,
      withSession(admin.cookie)
    );
    assert.equal((await json(noFalsePositive)).total, 0);
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
