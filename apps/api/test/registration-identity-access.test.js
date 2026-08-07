import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const validId = "11010519491231002X";
const otherValidId = "110105194912310038";
const eventId = "wz-aerospace-2026";

async function readJson(response) {
  return response.json();
}

async function mutateDb(dbPath, mutate) {
  const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
  mutate(db);
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
}

async function openEvent(baseUrl, adminCookie) {
  const response = await fetch(`${baseUrl}/api/admin/events/${eventId}`, withSession(adminCookie, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ registrationMode: "force_open" })
  }));
  assert.equal(response.status, 200);
}

function registrationBody(athlete, overrides = {}) {
  return {
    projectId: "rotor-race",
    athlete: {
      name: athlete.name,
      school: "Identity Test School",
      grade: "五年级",
      phone: athlete.phone
    },
    ...overrides
  };
}

test("new personal and organization registrations reject missing or invalid student identities", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const personal = await loginAs(baseUrl, "13800000001", "123456");
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await openEvent(baseUrl, admin.cookie);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/${eventId}/join`, withSession(owner.cookie, { method: "POST" }))).status, 201);

    for (const studentIdNumber of [undefined, "110105194912310021"]) {
      const body = registrationBody(personal.user, { studentIdNumber });
      if (studentIdNumber === undefined) delete body.studentIdNumber;
      const response = await fetch(`${baseUrl}/api/me/events/${eventId}/registrations`, withSession(personal.cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }));
      assert.equal(response.status, 400);
      assert.equal((await readJson(response)).code, "INVALID_STUDENT_ID_NUMBER");
    }

    const organizationResponse = await fetch(`${baseUrl}/api/organization/events/${eventId}/registrations`, withSession(owner.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationBody({ name: "Proxy Student", phone: "13600008101" }, {
        registrationSource: "organization_proxy"
      }))
    }));
    assert.equal(organizationResponse.status, 400);
    assert.equal((await readJson(organizationResponse)).code, "INVALID_STUDENT_ID_NUMBER");
  });
});

test("a new identity is encrypted once and visible only to the owner, its organization, and administrators", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const personal = await loginAs(baseUrl, "13800000001", "123456");
    const ownerOne = await loginAs(baseUrl, "13800000011", "123456");
    const ownerTwo = await loginAs(baseUrl, "13800000012", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await openEvent(baseUrl, admin.cookie);
    await mutateDb(dbPath, (db) => {
      db.users.push({
        id: "U1002", name: "Other Student", phone: "13800000002", password: "123456",
        type: "ordinary", status: "active", sessionVersion: 0, mustChangePassword: false,
        createdAt: "2026-08-07T00:00:00.000Z"
      });
      db.memberships.push({
        id: "M1003", userId: "U1002", organizationId: "O1002", role: "member", status: "active",
        direction: "user_request", note: "", createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z"
      });
    });
    const otherPersonal = await loginAs(baseUrl, "13800000002", "123456");
    for (const owner of [ownerOne, ownerTwo]) {
      assert.equal((await fetch(`${baseUrl}/api/organization/events/${eventId}/join`, withSession(owner.cookie, { method: "POST" }))).status, 201);
    }

    const createdResponse = await fetch(`${baseUrl}/api/me/events/${eventId}/registrations`, withSession(personal.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationBody(personal.user, { studentIdNumber: validId }))
    }));
    assert.equal(createdResponse.status, 201);
    const created = await readJson(createdResponse);
    assert.equal(created.row.studentIdNumber, validId);

    const stored = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(stored.registrationIdentities.length, 1);
    assert.equal(stored.registrationIdentities[0].registrationId, created.row.id);
    assert.equal(JSON.stringify(stored.registrationIdentities).includes(validId), false);
    assert.equal(Object.hasOwn(stored.registrations.find((row) => row.id === created.row.id), "studentIdNumber"), false);

    const ownerRows = await readJson(await fetch(`${baseUrl}/api/me/events/${eventId}/registrations`, withSession(personal.cookie)));
    assert.equal(ownerRows.rows.find((row) => row.id === created.row.id).studentIdNumber, validId);
    const organizationRows = await readJson(await fetch(`${baseUrl}/api/organization/events/${eventId}/registrations`, withSession(ownerOne.cookie)));
    assert.equal(organizationRows.rows.find((row) => row.id === created.row.id).studentIdNumber, validId);
    const adminRows = await readJson(await fetch(`${baseUrl}/api/admin/events/${eventId}/registrations`, withSession(admin.cookie)));
    assert.equal(adminRows.rows.find((row) => row.id === created.row.id).studentIdNumber, validId);

    const otherRows = await readJson(await fetch(`${baseUrl}/api/me/events/${eventId}/registrations`, withSession(otherPersonal.cookie)));
    assert.equal(otherRows.rows.some((row) => row.id === created.row.id), false);
    const otherOrganizationRows = await readJson(await fetch(`${baseUrl}/api/organization/events/${eventId}/registrations`, withSession(ownerTwo.cookie)));
    assert.equal(otherOrganizationRows.rows.some((row) => row.id === created.row.id), false);
  });
});

test("legacy retries stay identity-less while identified retries must match", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const personal = await loginAs(baseUrl, "13800000001", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await openEvent(baseUrl, admin.cookie);
    const athlete = {
      name: personal.user.name,
      school: "Legacy Identity School",
      grade: "五年级",
      phone: personal.user.phone
    };
    await mutateDb(dbPath, (db) => {
      db.registrations.push({
        id: "R-legacy-identity", eventId, source: "member_registration", createdByUserId: personal.user.id,
        personalUserId: personal.user.id, organizationId: "O1001", createdVia: "personal",
        organization: db.organizations.find((row) => row.id === "O1001").name,
        athlete, athleteKey: `${athlete.name.toLowerCase()}|legacyidentityschool|五年级|${athlete.phone}`,
        group: "小学高段", projectId: "rotor-race", projectName: "Legacy project", projectType: "individual",
        instructor: "", status: "pending", rejectReason: "",
        createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z"
      });
    });

    const legacyRetry = await fetch(`${baseUrl}/api/me/events/${eventId}/registrations`, withSession(personal.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "rotor-race", athlete, studentIdNumber: validId })
    }));
    assert.equal(legacyRetry.status, 200);
    assert.equal((await readJson(legacyRetry)).row.studentIdNumber, null);
    let stored = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(stored.registrationIdentities.some((row) => row.registrationId === "R-legacy-identity"), false);

    const legacyPatch = await fetch(`${baseUrl}/api/me/events/${eventId}/registrations/R-legacy-identity`, withSession(personal.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructor: "Legacy remains editable", studentIdNumber: validId })
    }));
    assert.equal(legacyPatch.status, 200);
    assert.equal((await readJson(legacyPatch)).row.studentIdNumber, null);
    stored = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(stored.registrationIdentities.some((row) => row.registrationId === "R-legacy-identity"), false);

    const createResponse = await fetch(`${baseUrl}/api/me/events/${eventId}/registrations`, withSession(personal.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationBody(personal.user, { projectId: "rocket-duration", studentIdNumber: validId }))
    }));
    assert.equal(createResponse.status, 201);
    const created = await readJson(createResponse);
    const matchingRetry = await fetch(`${baseUrl}/api/me/events/${eventId}/registrations`, withSession(personal.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationBody(personal.user, { projectId: "rocket-duration", studentIdNumber: validId }))
    }));
    assert.equal(matchingRetry.status, 200);
    assert.equal((await readJson(matchingRetry)).row.id, created.row.id);
    const conflict = await fetch(`${baseUrl}/api/me/events/${eventId}/registrations`, withSession(personal.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationBody(personal.user, { projectId: "rocket-duration", studentIdNumber: otherValidId }))
    }));
    assert.equal(conflict.status, 409);
    assert.equal((await readJson(conflict)).code, "REGISTRATION_IDENTITY_CONFLICT");
  });
});

test("authorized personal, organization, and administrator patches re-encrypt an existing identity", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const personal = await loginAs(baseUrl, "13800000001", "123456");
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await openEvent(baseUrl, admin.cookie);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/${eventId}/join`, withSession(owner.cookie, { method: "POST" }))).status, 201);
    const createResponse = await fetch(`${baseUrl}/api/me/events/${eventId}/registrations`, withSession(personal.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationBody(personal.user, { studentIdNumber: validId }))
    }));
    const registration = (await readJson(createResponse)).row;
    const originalIdentity = JSON.parse(await fs.readFile(dbPath, "utf8")).registrationIdentities[0];

    const patches = [
      [`/api/me/events/${eventId}/registrations/${registration.id}`, personal.cookie, otherValidId],
      [`/api/organization/events/${eventId}/registrations/${registration.id}`, owner.cookie, validId],
      [`/api/admin/events/${eventId}/registrations/${registration.id}`, admin.cookie, otherValidId]
    ];
    for (const [path, cookie, studentIdNumber] of patches) {
      const response = await fetch(`${baseUrl}${path}`, withSession(cookie, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studentIdNumber })
      }));
      assert.equal(response.status, 200);
      assert.equal((await readJson(response)).row.studentIdNumber, studentIdNumber);
    }

    const resultResponse = await fetch(`${baseUrl}/api/admin/events/${eventId}/registrations/${registration.id}/result`, withSession(admin.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ score: "98" })
    }));
    assert.equal(resultResponse.status, 200);
    assert.equal((await readJson(resultResponse)).row.studentIdNumber, otherValidId);

    const storedIdentity = JSON.parse(await fs.readFile(dbPath, "utf8")).registrationIdentities[0];
    assert.notEqual(storedIdentity.ciphertext, originalIdentity.ciphertext);
    assert.equal(JSON.stringify(storedIdentity).includes(otherValidId), false);
  });
});
