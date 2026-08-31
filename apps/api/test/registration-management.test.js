import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const validStudentIdNumber = "11010519491231002X";
const otherValidStudentIdNumber = "110105194912310038";

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
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await openRegistration(baseUrl, admin.cookie);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(owner.cookie, { method: "POST" }))).status, 201);
    const contextResponse = await fetch(`${baseUrl}/api/me/registration-context`, withSession(ordinary.cookie));
    assert.equal(contextResponse.status, 200);
    const context = await json(contextResponse);
    assert.equal(context.eligibility.eligible, true);
    assert.equal(context.eligibility.code, "OK");
    assert.equal(context.eligibility.organization.id, "O1001");
    assert.equal(context.eligibility.membership.id, "M1002");
    assert.equal(context.defaultOrganizationId, "O1001");
    assert.deepEqual(context.organizations.map((organization) => organization.id), ["O1001"]);
    assert.deepEqual(context.grades.map((group) => group.name), ["小学低段", "小学高段", "中学组", "职高/高中组"]);

    const schoolsResponse = await fetch(`${baseUrl}/api/schools?q=%E5%AE%9E%E9%AA%8C`, withSession(ordinary.cookie));
    assert.equal(schoolsResponse.status, 200);
    const schools = await json(schoolsResponse);
    assert.deepEqual(schools.rows, ["温州市实验小学", "温州市第二实验中学"]);
  });
});

test("ACTIVE_ORGANIZATION_REQUIRED blocks personal registration without an approved active member relation", async () => {
  const cases = [
    ["no membership", (db) => { db.memberships = []; }],
    ["pending membership", (db) => { db.memberships.find((row) => row.userId === "U1001").status = "pending"; }],
    ["rejected organization", (db) => { db.organizations.find((row) => row.id === "O1001").reviewStatus = "rejected"; }],
    ["disabled organization", (db) => { db.organizations.find((row) => row.id === "O1001").status = "disabled"; }]
  ];

  for (const [label, arrange] of cases) {
    await withServer(async (baseUrl, dbPath) => {
      const ordinary = await loginAs(baseUrl, "13800000001", "123456");
      await mutateDb(dbPath, (db) => {
        db.events[0].registrationMode = "force_open";
        arrange(db);
      });
      const response = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(ordinary.cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: "O1002",
          athlete: { name: `Blocked ${label}`, school: "Test school", grade: "五年级", phone: "13600005001" },
          projectId: "paper-plane-gate"
        })
      }));
      assert.equal(response.status, 403, label);
      assert.equal((await json(response)).code, "ACTIVE_ORGANIZATION_REQUIRED", label);
    });
  }
});

test("ordinary registration eligibility derives the approved member organization for individual and team projects", async () => {
  await withServer(async (baseUrl, dbPath) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => { db.events[0].registrationMode = "force_open"; });
    for (const [projectId, suffix] of [["paper-plane-gate", "individual"], ["drone-relay", "team"]]) {
      const response = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(ordinary.cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: "O1002",
          studentIdNumber: validStudentIdNumber,
          athlete: { name: `Eligible ${suffix}`, school: "Test school", grade: "五年级", phone: `13600005${suffix === "individual" ? "101" : "102"}` },
          projectId
        })
      }));
      assert.equal(response.status, 201);
      const payload = await json(response);
      assert.equal(payload.row.organizationId, "O1001");
      assert.equal(payload.row.organization, "温州市实验小学");
      assert.equal(payload.row.source, "member_registration");
      assert.equal(payload.row.projectType, suffix);
    }
  });
});

test("ACTIVE_ORGANIZATION_REQUIRED also blocks personal updates and upload-session creation", async () => {
  await withServer(async (baseUrl, dbPath) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.memberships.find((row) => row.userId === "U1001").status = "pending";
      db.projects.find((row) => row.id === "rocket-duration").submissionMode = "image_video";
    });

    const updated = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations/R20260627001`, withSession(ordinary.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instructor: "Blocked" })
    }));
    assert.equal(updated.status, 403);
    assert.equal((await json(updated)).code, "ACTIVE_ORGANIZATION_REQUIRED");

    const cancelled = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations/R20260627001/status`, withSession(ordinary.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled" })
    }));
    assert.equal(cancelled.status, 403);
    assert.equal((await json(cancelled)).code, "ACTIVE_ORGANIZATION_REQUIRED");

    const session = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/projects/rocket-duration/upload-sessions`, withSession(ordinary.cookie, { method: "POST" }));
    assert.equal(session.status, 403);
    assert.equal((await json(session)).code, "ACTIVE_ORGANIZATION_REQUIRED");
  });
});

test("fix round 1 personal updates restore the derived organization and member source", async () => {
  await withServer(async (baseUrl, dbPath) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      const row = db.registrations.find((item) => item.id === "R20260627001");
      row.organizationId = "O1002";
      row.organization = "Stale organization";
      row.source = "legacy_personal";
    });

    const response = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations/R20260627001`, withSession(ordinary.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instructor: "Updated" })
    }));
    assert.equal(response.status, 200);
    const row = (await json(response)).row;
    assert.equal(row.organizationId, "O1001");
    assert.equal(row.organization, "温州市实验小学");
    assert.equal(row.source, "member_registration");
  });
});

test("registration no longer requires a second website profile switch", async () => {
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
    assert.equal(response.status, 200);
  });
});

test("the only open event remains the implicit candidate without a website profile", async () => {
  await withServer(async (baseUrl, dbPath) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.eventPublicProfiles.push({ eventId: "OTHER", slug: "other", isVisible: false });
    });

    const response = await fetch(`${baseUrl}/api/me/registration-context`, withSession(ordinary.cookie));
    assert.equal(response.status, 200);
    assert.equal((await json(response)).event.id, "wz-aerospace-2026");
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

    const created = await fetch(`${baseUrl}/api/me/events/E2/registrations`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: "E2",
        studentIdNumber: validStudentIdNumber,
        athlete: { name: "第二场学生", school: "测试学校", grade: "二年级", phone: "13600004002" },
        projectId: "P-E2"
      })
    }));
    assert.equal(created.status, 201);
    assert.equal((await json(created)).row.eventId, "E2");
  });
});

test("event context ignores website visibility, accepts open drafts, and rejects unknown archived and closed events", async () => {
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
    assert.equal((await request("UNPUBLISHED-PROFILE")).status, 200);
    await mutateDb(dbPath, (db) => {
      db.events = db.events.filter((event) => event.id !== "UNPUBLISHED-PROFILE");
    });

    await mutateDb(dbPath, (db) => {
      db.events[0].registrationMode = "force_open";
      db.eventPublicProfiles.push({ eventId: db.events[0].id, slug: "hidden-event", isVisible: false });
    });
    assert.equal((await request("wz-aerospace-2026")).status, 200);

    await mutateDb(dbPath, (db) => {
      db.eventPublicProfiles[0].isVisible = true;
      db.events[0].status = "draft";
    });
    assert.equal((await request("wz-aerospace-2026")).status, 200);

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
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await openRegistration(baseUrl, admin.cookie);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(owner.cookie, { method: "POST" }))).status, 201);

    const checkResponse = await fetch(`${baseUrl}/api/registrations/check`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: "wz-aerospace-2026",
        studentIdNumber: validStudentIdNumber,
        athlete: { name: "派生组别学生", school: "温州市实验小学", grade: "五年级", phone: "13800000031" },
        group: "伪造组别", projectId: "paper-plane-gate"
      })
    }));
    assert.equal(checkResponse.status, 200);

    const createdResponse = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(ordinary.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId: "O1001",
        studentIdNumber: validStudentIdNumber,
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
    const deniedResponse = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(ordinary.cookie, {
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
    const response = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/registrations?group=%E4%B8%AD%E5%AD%A6%E7%BB%84&q=%E7%8E%8B%E8%80%81%E5%B8%88&page=1&pageSize=10`, withSession(admin.cookie));
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
    assert.equal(legacyResponse.status, 404);
  });
});

test("admin registration listing filters athleteName only against the athlete name", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const response = await fetch(
      `${baseUrl}/api/admin/events/wz-aerospace-2026/registrations?status=approved&athleteName=${encodeURIComponent("周星言")}&pageSize=10`,
      withSession(admin.cookie)
    );
    assert.equal(response.status, 200);
    const payload = await json(response);
    assert.equal(payload.total, 1);
    assert.deepEqual(payload.rows.map((row) => row.id), ["R20260627002"]);
    assert.equal(payload.rows.every((row) => row.status === "approved"), true);
    assert.equal(payload.rows.every((row) => row.athlete.name.includes("周星言")), true);

    const noFalsePositive = await fetch(
      `${baseUrl}/api/admin/events/wz-aerospace-2026/registrations?athleteName=${encodeURIComponent("王老师")}&pageSize=10`,
      withSession(admin.cookie)
    );
    assert.equal((await json(noFalsePositive)).total, 0);
  });
});

test("registration status changes enforce the owner's event window while administrators bypass it", async () => {
  await withServer(async (baseUrl) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const personalStatus = (id, payload, cookie) => fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations/${id}/status`, withSession(cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    }));
    const adminStatus = (id, payload, cookie) => fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/registrations/${id}/status`, withSession(cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    }));

    assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationMode: "force_closed" })
    }))).status, 200);
    assert.equal((await personalStatus("R20260627001", { status: "cancelled" }, ordinary.cookie)).status, 409);
    assert.equal((await adminStatus("R20260627002", { status: "rejected" }, admin.cookie)).status, 200);

    assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationMode: "automatic" })
    }))).status, 200);
    assert.equal((await personalStatus("R20260627001", { status: "cancelled" }, ordinary.cookie)).status, 409);

    await openRegistration(baseUrl, admin.cookie);
    assert.equal((await personalStatus("R20260627002", { status: "cancelled" }, ordinary.cookie)).status, 404);
    assert.equal((await personalStatus("R20260627001", { status: "approved" }, ordinary.cookie)).status, 403);
    assert.equal((await personalStatus("R20260627001", { status: "cancelled" }, ordinary.cookie)).status, 200);
  });
});

test("member registration updates keep the selected active membership while proxy updates stay operational", async () => {
  await withServer(async (baseUrl, dbPath) => {
    await mutateDb(dbPath, (db) => {
      const user = db.users.find((row) => row.id === "U1001");
      const memberRegistration = db.registrations.find((row) => row.id === "R20260627001");
      memberRegistration.source = "member_registration";
      memberRegistration.athlete.name = user.name;
      memberRegistration.athlete.phone = user.phone;
      const proxyRegistration = db.registrations.find((row) => row.id === "R20260627002");
      proxyRegistration.source = "organization_proxy";
      proxyRegistration.personalUserId = null;
    });
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await openRegistration(baseUrl, admin.cookie);
    const patch = (path, payload, cookie) => fetch(`${baseUrl}${path}`, withSession(cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    }));

    const ordinaryResponse = await patch("/api/me/events/wz-aerospace-2026/registrations/R20260627001", {
      organizationId: "O1002",
      instructor: "Updated by member"
    }, ordinary.cookie);
    assert.equal(ordinaryResponse.status, 200);
    const ordinaryRow = (await json(ordinaryResponse)).row;
    assert.equal(ordinaryRow.organizationId, "O1001");
    assert.equal(ordinaryRow.instructor, "Updated by member");

    const adminResponse = await patch("/api/admin/events/wz-aerospace-2026/registrations/R20260627001", { organizationId: "O1002" }, admin.cookie);
    assert.equal(adminResponse.status, 403);
    assert.equal((await json(adminResponse)).code, "ACTIVE_ORGANIZATION_MEMBER_REQUIRED");

    const proxyResponse = await patch("/api/admin/events/wz-aerospace-2026/registrations/R20260627002", {
      organizationId: "O1001",
      instructor: "Updated proxy"
    }, admin.cookie);
    assert.equal(proxyResponse.status, 200);
    const proxyRow = (await json(proxyResponse)).row;
    assert.equal(proxyRow.organizationId, "O1001");
    assert.equal(proxyRow.instructor, "Updated proxy");

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(persisted.registrations.find((row) => row.id === "R20260627001").organizationId, "O1001");
  });
});

test("member registration instructor-only updates fail closed after the member leaves the organization", async () => {
  await withServer(async (baseUrl, dbPath) => {
    await mutateDb(dbPath, (db) => {
      const user = db.users.find((row) => row.id === "U1001");
      const registration = db.registrations.find((row) => row.id === "R20260627001");
      registration.source = "member_registration";
      registration.athlete.name = user.name;
      registration.athlete.phone = user.phone;
      registration.instructor = "Original instructor";
    });
    const organizationOwner = await loginAs(baseUrl, "13800000011", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await openRegistration(baseUrl, admin.cookie);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(organizationOwner.cookie, { method: "POST" }))).status, 201);
    await mutateDb(dbPath, (db) => {
      db.memberships.find((row) => row.userId === "U1001" && row.organizationId === "O1001").status = "left";
    });

    const response = await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/registrations/R20260627001`, withSession(organizationOwner.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructor: "Forged after leaving" })
    }));
    assert.equal(response.status, 403);
    assert.equal((await json(response)).code, "ACTIVE_ORGANIZATION_MEMBER_REQUIRED");

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(persisted.registrations.find((row) => row.id === "R20260627001").instructor, "Original instructor");
  });
});

test("member registration edits keep the selected account identity while proxy edits remain editable", async () => {
  await withServer(async (baseUrl, dbPath) => {
    await mutateDb(dbPath, (db) => { db.users.find((row) => row.id === "U1001").name = "Member Identity"; });
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const organizationOwner = await loginAs(baseUrl, "13800000011", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await openRegistration(baseUrl, admin.cookie);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(organizationOwner.cookie, { method: "POST" }))).status, 201);

    const create = async (body) => fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/registrations`, withSession(organizationOwner.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }));
    const patch = async (path, body, cookie) => fetch(`${baseUrl}${path}`, withSession(cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }));

    const memberCreated = await create({
      registrationSource: "member_registration",
      memberUserId: "U1001",
      studentIdNumber: validStudentIdNumber,
      athlete: { name: "Member Identity", school: "成员身份测试学校", grade: "五年级", phone: "13800000001" },
      projectId: "paper-plane-gate"
    });
    assert.equal(memberCreated.status, 201);
    const memberRow = (await json(memberCreated)).row;

    const forgedByOrganization = await patch(
      `/api/organization/events/wz-aerospace-2026/registrations/${memberRow.id}`,
      { athlete: { ...memberRow.athlete, name: "伪造姓名" } },
      organizationOwner.cookie
    );
    assert.equal(forgedByOrganization.status, 422);
    assert.equal((await json(forgedByOrganization)).code, "MEMBER_IDENTITY_MISMATCH");

    const forgedByPersonal = await patch(
      `/api/me/events/wz-aerospace-2026/registrations/${memberRow.id}`,
      { athlete: { ...memberRow.athlete, phone: "13999999999" } },
      ordinary.cookie
    );
    assert.equal(forgedByPersonal.status, 422);
    assert.equal((await json(forgedByPersonal)).code, "MEMBER_IDENTITY_MISMATCH");

    const proxyCreated = await create({
      registrationSource: "organization_proxy",
      studentIdNumber: otherValidStudentIdNumber,
      athlete: { name: "代理选手", school: "代理身份测试学校", grade: "五年级", phone: "13700009999" },
      projectId: "paper-plane-gate"
    });
    assert.equal(proxyCreated.status, 201);
    const proxyRow = (await json(proxyCreated)).row;
    const proxyUpdated = await patch(
      `/api/organization/events/wz-aerospace-2026/registrations/${proxyRow.id}`,
      { athlete: { ...proxyRow.athlete, name: "代理选手已修改", phone: "13700008888" } },
      organizationOwner.cookie
    );
    assert.equal(proxyUpdated.status, 200);
    assert.equal((await json(proxyUpdated)).row.athlete.name, "代理选手已修改");
  });
});

test("administrator and organization edits keep a registration's project immutable once submission materials exist", async () => {
  await withServer(async (baseUrl, dbPath) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const organizationOwner = await loginAs(baseUrl, "13800000012", "123456");
    await openRegistration(baseUrl, admin.cookie);
    await mutateDb(dbPath, (db) => {
      for (const registrationId of ["R20260627001", "R20260627002"]) {
        const registration = db.registrations.find((row) => row.id === registrationId);
        const project = db.projects.find((row) => row.id === registration.projectId);
        project.submissionMode = "image_video";
        const alternate = db.projects.find((row) => row.id !== project.id && row.eventId === registration.eventId);
        alternate.allowedGroups = [...new Set([...(alternate.allowedGroups || []), registration.group])];
        db.registrationSubmissionAssets.push(
          { id: `SA-${registrationId}-image`, registrationId, uploadSessionId: `US-${registrationId}`, kind: "artwork_image", originalName: "work.png", storedName: "work.png", filePath: `/tmp/${registrationId}-image`, mimeType: "image/png", sizeBytes: 1, width: 800, height: 600, durationMs: null, uploadedByUserId: registration.createdByUserId, uploadedAt: "2026-08-01T00:00:00.000Z", cleanedAt: null, cleanupReason: "", warnings: [] },
          { id: `SA-${registrationId}-video`, registrationId, uploadSessionId: `US-${registrationId}`, kind: "creation_video", originalName: "work.mp4", storedName: "work.mp4", filePath: `/tmp/${registrationId}-video`, mimeType: "video/mp4", sizeBytes: 1, width: 1280, height: 720, durationMs: 1, uploadedByUserId: registration.createdByUserId, uploadedAt: "2026-08-01T00:00:00.000Z", cleanedAt: null, cleanupReason: "", warnings: [] }
        );
      }
    });
    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(organizationOwner.cookie, { method: "POST" }))).status, 201);
    const initial = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const adminRegistration = initial.registrations.find((row) => row.id === "R20260627001");
    const organizationRegistration = initial.registrations.find((row) => row.id === "R20260627002");
    const alternativeFor = (registration) => initial.projects.find((project) => project.id !== registration.projectId && project.eventId === registration.eventId).id;

    const adminResponse = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/registrations/${adminRegistration.id}`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: alternativeFor(adminRegistration) })
    }));
    assert.equal(adminResponse.status, 409);
    assert.equal((await json(adminResponse)).code, "REGISTRATION_PROJECT_IMMUTABLE");

    const organizationResponse = await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/registrations/${organizationRegistration.id}`, withSession(organizationOwner.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: alternativeFor(organizationRegistration) })
    }));
    assert.equal(organizationResponse.status, 409);
    assert.equal((await json(organizationResponse)).code, "REGISTRATION_PROJECT_IMMUTABLE");

    const after = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(after.registrations.find((row) => row.id === adminRegistration.id).projectId, adminRegistration.projectId);
    assert.equal(after.registrations.find((row) => row.id === organizationRegistration.id).projectId, organizationRegistration.projectId);
  });
});
