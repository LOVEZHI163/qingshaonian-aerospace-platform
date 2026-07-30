import assert from "node:assert/strict";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const CERTIFICATE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

async function withServer(fn) {
  await withTestServer(({ baseUrl }) => fn(baseUrl), { prefix: "aerogp-authorization-" });
}

function jsonOptions(method, body, cookie) {
  return withSession(cookie, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function uploadCertificate(baseUrl, registrationId, slot, cookie, title = "获奖证书") {
  const form = new FormData();
  form.append("certificate", new Blob([CERTIFICATE_PNG], { type: "image/png" }), `slot-${slot}.png`);
  form.append("title", title);
  return fetch(`${baseUrl}/api/admin/registrations/${registrationId}/certificates/${slot}`, withSession(cookie, {
    method: "POST",
    body: form
  }));
}

test("every business API requires a session and every administrator API rejects ordinary users", async () => {
  await withServer(async (baseUrl) => {
    const protectedGets = [
      "/api/users",
      "/api/registrations",
      "/api/admin/registrations/export.xlsx?eventId=wz-aerospace-2026&scope=all",
      "/api/organizations",
      "/api/me/registrations",
      "/api/me/certificates",
      "/api/organizations/O1001/registrations",
      "/api/organizations/O1001/certificates",
      "/api/admin/certificates",
      "/api/certificates/not-found/file"
    ];
    for (const route of protectedGets) {
      assert.equal((await fetch(`${baseUrl}${route}`)).status, 401, route);
    }
    for (const [route, body] of [
      ["/api/organizations/request", { organizationId: "O1001" }],
      ["/api/registrations/check", { athlete: {} }],
      ["/api/registrations", {}]
    ]) {
      assert.equal((await fetch(`${baseUrl}${route}`, jsonOptions("POST", body))).status, 401, route);
    }

    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const adminRequests = [
      ["GET", "/api/users"],
      ["GET", "/api/registrations"],
      ["GET", "/api/admin/registrations/export.xlsx?eventId=wz-aerospace-2026&scope=all"],
      ["GET", "/api/admin/certificates"],
      ["POST", "/api/admin/users", {}],
      ["POST", "/api/admin/users/U1001/reset-password", { password: "TempPass9" }],
      ["PATCH", "/api/admin/users/U2001", {}],
      ["DELETE", "/api/admin/users/U2001"],
      ["POST", "/api/admin/registrations/R20260627001/result", {}],
      ["PATCH", "/api/admin/registrations/R20260627001", {}],
      ["POST", "/api/admin/registrations/R20260627001/certificates/1", {}],
      ["POST", "/api/admin/certificates/bulk-status", {}],
      ["PATCH", "/api/admin/certificates/not-found", {}],
      ["DELETE", "/api/admin/certificates/not-found"]
    ];
    for (const [method, route, body] of adminRequests) {
      const options = body === undefined
        ? withSession(ordinary.cookie, { method })
        : jsonOptions(method, body, ordinary.cookie);
      assert.equal((await fetch(`${baseUrl}${route}`, options)).status, 403, `${method} ${route}`);
    }
  });
});

test("session identity cannot be replaced through body, query, or path values", async () => {
  await withServer(async (baseUrl) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, jsonOptions("PATCH", {
      registrationMode: "force_open"
    }, admin.cookie))).status, 200);

    const foreignProfile = await fetch(`${baseUrl}/api/me/U2001`, withSession(ordinary.cookie));
    assert.equal(foreignProfile.status, 403);
    const ownProfile = await fetch(`${baseUrl}/api/me/U1001`, withSession(ordinary.cookie));
    assert.equal(ownProfile.status, 200);

    const forgedQuery = new URLSearchParams({ userId: "U2001" });
    const ownRegistrations = await fetch(`${baseUrl}/api/me/registrations?${forgedQuery}`, withSession(ordinary.cookie));
    assert.equal(ownRegistrations.status, 200);
    assert.deepEqual((await ownRegistrations.json()).rows.map((row) => row.userId), ["U1001"]);

    const organizations = await fetch(`${baseUrl}/api/organizations`, withSession(ordinary.cookie));
    const organizationPayload = await organizations.json();
    assert.equal("memberships" in organizationPayload, false);
    assert.equal(organizationPayload.rows.every((row) => !("ownerUserId" in row)), true);

    const users = await fetch(`${baseUrl}/api/users`, withSession(admin.cookie));
    const userRows = (await users.json()).rows;
    assert.equal(userRows.every((row) => !("password" in row) && !("sessionVersion" in row)), true);

    const duplicateCheck = await fetch(`${baseUrl}/api/registrations/check`, jsonOptions("POST", {
      athlete: { name: "陈宇航", school: "温州市实验小学", grade: "五年级", phone: "13800000001" },
      group: "小学高段",
      projectId: "paper-plane-gate"
    }, ordinary.cookie));
    const duplicatePayload = await duplicateCheck.json();
    assert.equal(duplicatePayload.duplicate, true);
    assert.equal(duplicatePayload.duplicateCount, 1);
    assert.equal("matches" in duplicatePayload, false);
    assert.equal("athleteKey" in duplicatePayload, false);

    const forgedRegistration = await fetch(`${baseUrl}/api/registrations`, jsonOptions("POST", {
      userId: "U2001",
      organizationId: "O1001",
      source: "伪造来源",
      athlete: { name: "测试学生甲", school: "温州市实验小学", grade: "五年级", phone: "13600001001" },
      group: "小学高段",
      projectId: "rocket-duration",
      instructor: "林老师"
    }, ordinary.cookie));
    assert.equal(forgedRegistration.status, 201);
    assert.equal((await forgedRegistration.json()).row.userId, "U1001");

    const unrelatedOrganization = await fetch(`${baseUrl}/api/registrations`, jsonOptions("POST", {
      organizationId: "O1002",
      athlete: { name: "测试学生乙", school: "其他学校", grade: "初二", phone: "13600001002" },
      group: "中学组",
      projectId: "drone-relay"
    }, ordinary.cookie));
    assert.equal(unrelatedOrganization.status, 403);

    const unknownOrganization = await fetch(`${baseUrl}/api/registrations`, jsonOptions("POST", {
      organizationId: "O-NOT-FOUND",
      athlete: { name: "测试学生丙", school: "其他学校", grade: "初二", phone: "13600001003" },
      group: "中学组",
      projectId: "drone-relay"
    }, ordinary.cookie));
    assert.equal(unknownOrganization.status, 404);

    const privateRegistration = await fetch(`${baseUrl}/api/registrations`, jsonOptions("POST", {
      athlete: { name: "私人参赛者", school: "个人学校", grade: "初二", phone: "13600001004" },
      group: "中学组",
      projectId: "drone-relay"
    }, ordinary.cookie));
    assert.equal(privateRegistration.status, 201);
    const privateRegistrationId = (await privateRegistration.json()).row.id;

    assert.equal((await fetch(`${baseUrl}/api/organizations/O1002/registrations`, withSession(ordinary.cookie))).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/organizations/O1002/certificates`, withSession(ordinary.cookie))).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/organizations/O1001/registrations`, withSession(ordinary.cookie))).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/organizations/O1001/certificates`, withSession(ordinary.cookie))).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/organizations/invite`, jsonOptions("POST", {
      organizationId: "O1002", phone: "13700000001", name: "越权邀请"
    }, ordinary.cookie))).status, 404);
    const ownerOrganizationRows = await fetch(`${baseUrl}/api/organizations/O1001/registrations`, withSession(owner.cookie));
    assert.equal(ownerOrganizationRows.status, 200);
    const ownerRows = (await ownerOrganizationRows.json()).rows;
    assert.equal(ownerRows.every((row) => row.organizationId === "O1001"), true);
    assert.equal(ownerRows.some((row) => row.id === "R20260627002"), false);
    assert.equal(ownerRows.some((row) => row.id === privateRegistrationId), false);
    const adminOrganizationRows = await fetch(`${baseUrl}/api/organizations/O1001/registrations`, withSession(admin.cookie));
    assert.equal(adminOrganizationRows.status, 403);

    assert.equal((await fetch(`${baseUrl}/api/registrations/R20260627001/status`, jsonOptions("PATCH", { status: "approved" }, ordinary.cookie))).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/registrations/R20260627002/status`, jsonOptions("PATCH", { status: "cancelled" }, ordinary.cookie))).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/registrations/R20260627001/status`, jsonOptions("PATCH", { status: "cancelled" }, ordinary.cookie))).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/registrations/R20260627002/status`, jsonOptions("PATCH", { status: "rejected" }, admin.cookie))).status, 200);
  });
});

test("only the unique organization owner can review ordinary membership requests", async () => {
  await withServer(async (baseUrl) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const ordinaryRegistration = await fetch(`${baseUrl}/api/auth/register/ordinary`, jsonOptions("POST", {
      name: "申请成员", phone: "13700000010", password: "Member10"
    }));
    assert.equal(ordinaryRegistration.status, 201);
    const ordinary = await loginAs(baseUrl, "13700000010", "Member10");

    const request = await fetch(`${baseUrl}/api/organizations/request`, jsonOptions("POST", {
      organizationId: "O1001", note: "申请加入", role: "manager"
    }, ordinary.cookie));
    assert.equal(request.status, 201);
    const membership = (await request.json()).row;
    assert.equal(membership.role, "member");

    assert.equal((await fetch(`${baseUrl}/api/organizations/O1001/members`, withSession(owner.cookie))).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/organizations/O1001/members`, withSession(ordinary.cookie))).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/organizations/O1001/members`, withSession(admin.cookie))).status, 403);

    const approved = await fetch(`${baseUrl}/api/memberships/${membership.id}`, jsonOptions("PATCH", {
      status: "active", role: "manager"
    }, owner.cookie));
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).row.role, "member");

    const removedInvitationEndpoint = await fetch(`${baseUrl}/api/organizations/invite`, jsonOptions("POST", {
      organizationId: "O1001", phone: "13700000088", name: "不再支持的组织邀请"
    }, owner.cookie));
    assert.equal(removedInvitationEndpoint.status, 404);
  });
});

test("certificate downloads enforce ownership, publication, and organization management", async () => {
  await withServer(async (baseUrl) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    assert.equal((await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, jsonOptions("PATCH", {
      registrationMode: "force_open"
    }, admin.cookie))).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/registrations/R20260627001/status`, jsonOptions("PATCH", {
      status: "approved"
    }, admin.cookie))).status, 200);
    const upload = await uploadCertificate(baseUrl, "R20260627001", 1, admin.cookie, "草稿证书");
    assert.equal(upload.status, 201);
    const certificate = (await upload.json()).row;

    assert.equal((await fetch(`${baseUrl}/api/certificates/${certificate.id}/file`, withSession(ordinary.cookie))).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/certificates/${certificate.id}/file`, withSession(owner.cookie))).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/certificates/${certificate.id}/file`, withSession(admin.cookie))).status, 200);

    const publish = await fetch(`${baseUrl}/api/admin/certificates/bulk-status`, jsonOptions("POST", { ids: [certificate.id], status: "published" }, admin.cookie));
    assert.equal(publish.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/certificates/${certificate.id}/file?download=1`, withSession(ordinary.cookie))).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/certificates/${certificate.id}/file?download=1`, withSession(owner.cookie))).status, 200);

    const foreign = await uploadCertificate(baseUrl, "R20260627002", 1, admin.cookie, "外部证书");
    const foreignCertificate = (await foreign.json()).row;
    await fetch(`${baseUrl}/api/admin/certificates/bulk-status`, jsonOptions("POST", { ids: [foreignCertificate.id], status: "published" }, admin.cookie));
    assert.equal((await fetch(`${baseUrl}/api/certificates/${foreignCertificate.id}/file`, withSession(ordinary.cookie))).status, 403);

    const privateRegistration = await fetch(`${baseUrl}/api/registrations`, jsonOptions("POST", {
      athlete: { name: "私人报名", school: "个人学校", grade: "初二", phone: "13600002001" },
      group: "中学组",
      projectId: "drone-relay"
    }, ordinary.cookie));
    assert.equal(privateRegistration.status, 201);
    const privateRow = (await privateRegistration.json()).row;
    assert.equal((await fetch(`${baseUrl}/api/registrations/${privateRow.id}/status`, jsonOptions("PATCH", {
      status: "approved"
    }, admin.cookie))).status, 200);
    const privateUpload = await uploadCertificate(baseUrl, privateRow.id, 1, admin.cookie, "私人证书");
    const privateCertificate = (await privateUpload.json()).row;
    await fetch(`${baseUrl}/api/admin/certificates/bulk-status`, jsonOptions("POST", { ids: [privateCertificate.id], status: "published" }, admin.cookie));
    assert.equal((await fetch(`${baseUrl}/api/certificates/${privateCertificate.id}/file`, withSession(owner.cookie))).status, 403);

    const organizationCertificates = await fetch(`${baseUrl}/api/organizations/O1001/certificates`, withSession(owner.cookie));
    const organizationRows = (await organizationCertificates.json()).rows;
    assert.deepEqual(organizationRows.map((row) => row.registrationId), ["R20260627001"]);
    assert.equal(organizationRows.every((row) => !("filePath" in row) && !("storedName" in row)), true);
    const ownCertificates = await fetch(`${baseUrl}/api/me/certificates`, withSession(ordinary.cookie));
    assert.equal((await ownCertificates.json()).rows.every((row) => !("filePath" in row) && !("storedName" in row)), true);
    const adminCertificates = await fetch(`${baseUrl}/api/admin/certificates`, withSession(admin.cookie));
    assert.equal((await adminCertificates.json()).rows.every((row) => !("filePath" in row) && !("storedName" in row)), true);
  });
});

test("temporary-password users must change password and only the current session survives", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const reset = await fetch(`${baseUrl}/api/admin/users/U1001/reset-password`, jsonOptions("POST", { password: "TempPass9" }, admin.cookie));
    assert.equal(reset.status, 200);

    const first = await loginAs(baseUrl, "13800000001", "TempPass9");
    const second = await loginAs(baseUrl, "13800000001", "TempPass9");
    assert.equal((await fetch(`${baseUrl}/api/auth/me`, withSession(first.cookie))).status, 200);
    const blocked = await fetch(`${baseUrl}/api/me/registrations`, withSession(first.cookie));
    assert.equal(blocked.status, 428);
    assert.equal((await blocked.json()).code, "PASSWORD_CHANGE_REQUIRED");

    const wrong = await fetch(`${baseUrl}/api/auth/change-password`, jsonOptions("POST", {
      currentPassword: "WrongPass9", newPassword: "NextPass2"
    }, first.cookie));
    assert.equal(wrong.status, 401);

    const unchanged = await fetch(`${baseUrl}/api/auth/change-password`, jsonOptions("POST", {
      currentPassword: "TempPass9", newPassword: "TempPass9"
    }, first.cookie));
    assert.equal(unchanged.status, 422);
    assert.equal((await fetch(`${baseUrl}/api/me/registrations`, withSession(first.cookie))).status, 428);

    const changed = await fetch(`${baseUrl}/api/auth/change-password`, jsonOptions("POST", {
      currentPassword: "TempPass9", newPassword: "NextPass2"
    }, first.cookie));
    assert.equal(changed.status, 200);
    const changedPayload = await changed.json();
    assert.equal(changedPayload.user.mustChangePassword, false);
    assert.equal("password" in changedPayload.user, false);
    assert.equal("sessionVersion" in changedPayload.user, false);
    assert.equal((await fetch(`${baseUrl}/api/me/registrations`, withSession(first.cookie))).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/auth/me`, withSession(second.cookie))).status, 401);
  });
});
