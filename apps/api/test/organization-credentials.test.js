import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";

import { CREDENTIAL_POLICY, validateUpload } from "../src/files/policy.js";
import { deletePrivateFile, savePrivateFile } from "../src/files/storage.js";
import { createPostgresStore } from "../src/data/postgres-store.js";
import { ensureDbShape, seedDb } from "../src/data/seed.js";
import { registerOrganization, resubmitOrganization } from "../src/services/organizations.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const pngBuffer = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63600000020001e221bc330000000049454e44ae426082", "hex");
const pdfBuffer = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const jpegBuffer = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAFcf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAQUCq//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEABj8Cp//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8h/9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAE/EP/Z", "base64");
const executableBuffer = Buffer.from("4d5a90000300000004000000ffff0000b8000000", "hex");

function uploadedFile(buffer, originalname, mimetype = "application/octet-stream") {
  return { buffer, size: buffer.length, originalname, mimetype };
}

function organizationRegistration({
  creditCode = "91330300TEST000001",
  documentType = "business_license",
  includeCredential = true,
  name = "组织负责人",
  phone = "13600009991",
  organizationName = "待审核航空学校",
  credentialBuffer = pdfBuffer,
  credentialName = "license.pdf",
  credentialMime = "application/pdf"
} = {}) {
  const form = new FormData();
  form.set("name", name);
  form.set("phone", phone);
  form.set("password", "Strong123");
  form.set("organizationName", organizationName);
  form.set("creditCode", creditCode);
  form.set("documentType", documentType);
  if (includeCredential) form.set("credential", new Blob([credentialBuffer], { type: credentialMime }), credentialName);
  return form;
}

async function postOrganizationRegistration(baseUrl, options) {
  return fetch(`${baseUrl}/api/auth/register/organization`, {
    method: "POST",
    body: organizationRegistration(options)
  });
}

test("organization registration review keeps pending organizations outside organization capabilities", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const ordinary = await fetch(`${baseUrl}/api/auth/register/ordinary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "普通家长", phone: "13600009990", password: "Strong123", type: "organization" })
    });
    assert.equal(ordinary.status, 201);
    assert.equal((await ordinary.json()).user.type, "ordinary");

    const legacyOrganizationRegistration = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "绕过审核", phone: "13600009989", password: "Strong123", type: "organization", organizationName: "无资质组织" })
    });
    assert.equal(legacyOrganizationRegistration.status, 422);

    const register = await postOrganizationRegistration(baseUrl);
    assert.equal(register.status, 201);
    const payload = await register.json();
    assert.equal(payload.organization.reviewStatus, "pending");
    assert.equal(payload.organization.creditCode, "91330300TEST000001");
    assert.equal(payload.organization.currentDocumentId, payload.document.id);
    assert.equal(Object.hasOwn(payload.organization, "filePath"), false);

    const owner = await loginAs(baseUrl, "13600009991", "Strong123");
    const myOrganizations = await fetch(`${baseUrl}/api/me/organizations`, withSession(owner.cookie));
    assert.equal(myOrganizations.status, 200);
    assert.equal((await myOrganizations.json()).rows[0].reviewStatus, "pending");
    const pendingConsole = await fetch(`${baseUrl}/api/organizations/${payload.organization.id}/members`, withSession(owner.cookie));
    assert.equal(pendingConsole.status, 403);

    const duplicate = await postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000001" });
    assert.equal(duplicate.status, 409);
    const missing = await postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000002", includeCredential: false });
    assert.equal(missing.status, 422);
    const invalidType = await postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000003", documentType: "invalid" });
    assert.equal(invalidType.status, 422);
    const lowercaseCredit = await postOrganizationRegistration(baseUrl, { creditCode: "91330300test000004", phone: "13600009984" });
    assert.equal(lowercaseCredit.status, 422);

    const nonAdminReview = await fetch(`${baseUrl}/api/admin/organizations/${payload.organization.id}/review`, withSession(owner.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved", reason: "" })
    }));
    assert.equal(nonAdminReview.status, 403);

    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const blankRejection = await fetch(`${baseUrl}/api/admin/organizations/${payload.organization.id}/review`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "rejected", reason: " " })
    }));
    assert.equal(blankRejection.status, 422);
    const approve = await fetch(`${baseUrl}/api/admin/organizations/${payload.organization.id}/review`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved", reason: "" })
    }));
    assert.equal(approve.status, 200);
    const reviewedOrganizations = await fetch(`${baseUrl}/api/admin/organizations`, withSession(admin.cookie));
    assert.equal(reviewedOrganizations.status, 200);
    const reviewedOrganization = (await reviewedOrganizations.json()).rows.find((row) => row.id === payload.organization.id);
    assert.equal(Object.hasOwn(reviewedOrganization, "filePath"), false);
    assert.equal(reviewedOrganization.documents[0].id, payload.document.id);
    assert.equal(reviewedOrganization.documents[0].isCurrent, true);
    assert.equal(Object.hasOwn(reviewedOrganization.documents[0], "filePath"), false);

    const adminCredential = await fetch(`${baseUrl}/api/organizations/${payload.organization.id}/credential/${payload.document.id}`, withSession(admin.cookie));
    assert.equal(adminCredential.status, 200);
    assert.deepEqual(Buffer.from(await adminCredential.arrayBuffer()), pdfBuffer);
    const credential = await fetch(`${baseUrl}/api/organizations/${payload.organization.id}/credential/${payload.document.id}`, withSession(owner.cookie));
    assert.equal(credential.status, 200);
    assert.deepEqual(Buffer.from(await credential.arrayBuffer()), pdfBuffer);
    const unrelatedUser = await loginAs(baseUrl, "13600009990", "Strong123");
    const forbiddenCredential = await fetch(`${baseUrl}/api/organizations/${payload.organization.id}/credential/${payload.document.id}`, withSession(unrelatedUser.cookie));
    assert.equal(forbiddenCredential.status, 403);
  }, { prefix: "org-registration-review-" });
});

test("rejected owner can replace credentials and resubmit organization for review", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const register = await postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000011" });
    const firstPayload = await register.json();
    const { organization } = firstPayload;
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const rejected = await fetch(`${baseUrl}/api/admin/organizations/${organization.id}/review`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "rejected", reason: "证照不清晰" })
    }));
    assert.equal(rejected.status, 200);
    const owner = await loginAs(baseUrl, "13600009991", "Strong123");
    const form = organizationRegistration({ creditCode: "91330300TEST000011", documentType: "school_license" });
    form.delete("name"); form.delete("phone"); form.delete("password");
    form.set("organizationName", "重新提交航空学校");
    const resubmit = await fetch(`${baseUrl}/api/me/organization`, withSession(owner.cookie, { method: "PATCH", body: form }));
    assert.equal(resubmit.status, 200);
    const payload = await resubmit.json();
    assert.equal(payload.organization.reviewStatus, "pending");
    assert.equal(payload.organization.rejectReason, "");
    assert.equal(payload.document.documentType, "school_license");
    assert.equal(payload.organization.currentDocumentId, payload.document.id);
    assert.notEqual(payload.organization.currentDocumentId, firstPayload.document.id);
    const adminOrganizations = await fetch(`${baseUrl}/api/admin/organizations`, withSession(admin.cookie));
    const persisted = (await adminOrganizations.json()).rows.find((row) => row.id === organization.id);
    assert.equal(persisted.documents.length, 2);
    assert.deepEqual(persisted.documents.filter((document) => document.isCurrent).map((document) => document.id), [payload.document.id]);
  }, { prefix: "org-resubmit-" });
});

test("admin organization status disables only the unique owner capabilities and persists the organization state", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const register = await postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000071", phone: "13600009971" });
    const { organization } = await register.json();
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    assert.equal((await fetch(`${baseUrl}/api/admin/organizations/${organization.id}/review`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved", reason: "" })
    }))).status, 200);

    const owner = await loginAs(baseUrl, "13600009971", "Strong123");
    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(owner.cookie, {
      method: "POST"
    }))).status, 201);
    const ordinaryRegistration = await fetch(`${baseUrl}/api/auth/register/ordinary`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "普通成员", phone: "13600009972", password: "Member72" })
    });
    assert.equal(ordinaryRegistration.status, 201);
    const member = await loginAs(baseUrl, "13600009972", "Member72");
    const request = await fetch(`${baseUrl}/api/organizations/request`, withSession(member.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: organization.id, role: "manager" })
    }));
    const membership = (await request.json()).row;
    assert.equal((await fetch(`${baseUrl}/api/memberships/${membership.id}`, withSession(owner.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "active" })
    }))).status, 200);

    const disabled = await fetch(`${baseUrl}/api/admin/organizations/${organization.id}/status`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "disabled" })
    }));
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).organization.status, "disabled");
    assert.equal((await fetch(`${baseUrl}/api/admin/organizations/${organization.id}/status`, withSession(owner.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "active" })
    }))).status, 403);
    const ownerRow = (await (await fetch(`${baseUrl}/api/users`, withSession(admin.cookie))).json()).rows.find((user) => user.id === organization.ownerUserId);
    assert.equal(ownerRow.status, "active");
    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/registrations`, withSession(owner.cookie))).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/registrations`, withSession(member.cookie))).status, 403);
    const stored = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(stored.organizations.find((row) => row.id === organization.id).status, "disabled");

    const enabled = await fetch(`${baseUrl}/api/admin/organizations/${organization.id}/status`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "active" })
    }));
    assert.equal(enabled.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/registrations`, withSession(owner.cookie))).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/registrations`, withSession(member.cookie))).status, 403);

    const rows = (await (await fetch(`${baseUrl}/api/admin/organizations`, withSession(admin.cookie))).json()).rows;
    const row = rows.find((item) => item.id === organization.id);
    assert.equal(row.memberCount, 1);
    assert.equal(Object.hasOwn(row.documents[0], "filePath"), false);
    assert.equal(Object.hasOwn(row.documents[0], "storedName"), false);
  }, { prefix: "organization-status-" });
});

test("organization registration removes the saved credential when its atomic database write fails", async () => {
  const saved = { filePath: "/safe/uploads/organization-documents/O1/license.pdf", originalName: "license.pdf", storedName: "license.pdf", mimeType: "application/pdf", size: pdfBuffer.length };
  const cleaned = [];
  await assert.rejects(
    () => registerOrganization({
      input: { name: "负责人", phone: "13600009992", password: "Strong123", organizationName: "失败组织", creditCode: "91330300TEST000012", documentType: "business_license" },
      file: uploadedFile(pdfBuffer, "license.pdf", "application/pdf"),
      readDb: async () => ({ users: [], organizations: [], memberships: [], organizationDocuments: [] }),
      writeDb: async () => { throw new Error("simulated database failure"); },
      hashPassword: async () => "hash",
      validatePassword: () => "",
      makeId: (prefix) => `${prefix}1`,
      now: () => "2026-07-17T00:00:00.000Z",
      saveFile: async () => saved,
      removePrivateFile: async (record) => { cleaned.push(record.filePath); }
    }),
    /simulated database failure/
  );
  assert.deepEqual(cleaned, [saved.filePath]);
});

test("organization registration records a cleanup tombstone when database failure leaves its new file undeletable", async () => {
  const saved = { filePath: "/safe/uploads/organization-documents/O3/license.pdf", originalName: "license.pdf", storedName: "license.pdf", mimeType: "application/pdf", size: pdfBuffer.length };
  let writes = 0;
  let journal;
  await assert.rejects(() => registerOrganization({
    input: { name: "负责人", phone: "13600009993", password: "Strong123", organizationName: "清理组织", creditCode: "91330300TEST000013", documentType: "business_license" },
    file: uploadedFile(pdfBuffer, "license.pdf", "application/pdf"),
    readDb: async () => ({ users: [], organizations: [], memberships: [], organizationDocuments: [], fileCleanupJournal: [] }),
    writeDb: async (db) => { if (writes++ === 0) throw new Error("database failure"); journal = db.fileCleanupJournal; },
    hashPassword: async () => "hash", validatePassword: () => "", makeId: (prefix) => `${prefix}3`, now: () => "2026-07-17T00:00:00.000Z",
    saveFile: async () => saved, removePrivateFile: async () => { throw new Error("disk unavailable"); }
  }), /database failure/);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].filePath, saved.filePath);
});

test("organization registrations reject pending, rejected, and disabled organizations without blocking personal registration", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const registered = await postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000020" });
    const { organization } = await registered.json();
    const owner = await loginAs(baseUrl, "13600009991", "Strong123");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registrationMode: "force_open" })
    }));
    const registration = (phone) => fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/registrations`, withSession(owner.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        athlete: { name: "组织代报名学生", school: "待审核学校", grade: "初二", phone },
        group: "中学组", projectId: "drone-relay"
      })
    }));
    assert.equal((await registration("13600009920")).status, 403);

    const rejectReview = await fetch(`${baseUrl}/api/admin/organizations/${organization.id}/review`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "rejected", reason: "资料需要补充" })
    }));
    assert.equal(rejectReview.status, 200);
    assert.equal((await registration("13600009921")).status, 403);

    const resubmitForm = organizationRegistration({ creditCode: "91330300TEST000020", documentType: "school_license" });
    resubmitForm.delete("name"); resubmitForm.delete("phone"); resubmitForm.delete("password");
    const resubmit = await fetch(`${baseUrl}/api/me/organization`, withSession(owner.cookie, { method: "PATCH", body: resubmitForm }));
    assert.equal(resubmit.status, 200);
    const approveReview = await fetch(`${baseUrl}/api/admin/organizations/${organization.id}/review`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved", reason: "" })
    }));
    assert.equal(approveReview.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/wz-aerospace-2026/join`, withSession(owner.cookie, {
      method: "POST"
    }))).status, 201);
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.organizations.find((row) => row.id === organization.id).status = "disabled";
    await fs.writeFile(dbPath, JSON.stringify(db), "utf8");
    assert.equal((await registration("13600009922")).status, 403);

    const personalRegister = await fetch(`${baseUrl}/api/auth/register/ordinary`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "个人参赛家长", phone: "13600009923", password: "Strong123" })
    });
    assert.equal(personalRegister.status, 201);
    const personal = await loginAs(baseUrl, "13600009923", "Strong123");
    const personalRegistration = await fetch(`${baseUrl}/api/me/events/wz-aerospace-2026/registrations`, withSession(personal.cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        athlete: { name: "个人报名学生", school: "个人学校", grade: "初二", phone: "13600009924" },
        group: "中学组", projectId: "drone-relay"
      })
    }));
    assert.equal(personalRegistration.status, 201);
  }, { prefix: "organization-registration-gate-" });
});

test("organization registration rejects an account that already owns an organization", async () => {
  const db = structuredClone(seedDb);
  let saved = false;

  await assert.rejects(() => registerOrganization({
    input: {
      name: "重复负责人", phone: "13600009970", password: "Strong123",
      organizationName: "第二个组织", creditCode: "91330300TEST000070", documentType: "business_license"
    },
    file: uploadedFile(pdfBuffer, "license.pdf", "application/pdf"),
    readDb: async () => structuredClone(db), writeDb: async () => {},
    hashPassword: async (value) => value, validatePassword: () => "",
    makeId: (() => { const values = ["U2001", "O2003"]; return () => values.shift(); })(),
    now: () => "2026-07-30T00:00:00.000Z",
    saveFile: async () => { saved = true; return {}; }
  }), (error) => error.status === 409);
  assert.equal(saved, false);
});

test("concurrent organization registrations preserve every committed user, organization, document, and file", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const [first, second] = await Promise.all([
      postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000030", phone: "13600009930", organizationName: "并发组织一" }),
      postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000031", phone: "13600009931", organizationName: "并发组织二" })
    ]);
    assert.deepEqual([first.status, second.status], [201, 201]);
    const firstPayload = await first.json();
    const secondPayload = await second.json();
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    for (const payload of [firstPayload, secondPayload]) {
      assert.ok(db.users.some((row) => row.id === payload.user.id));
      assert.ok(db.organizations.some((row) => row.id === payload.organization.id));
      assert.equal(db.memberships.some((row) => row.organizationId === payload.organization.id && row.userId === payload.user.id), false);
      const document = db.organizationDocuments.find((row) => row.id === payload.document.id);
      assert.ok(document);
      await fs.access(document.filePath);
    }
  }, { prefix: "organization-concurrent-" });
});

test("concurrent same-credit registrations return one conflict without an orphan credential", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const [first, second] = await Promise.all([
      postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000040", phone: "13600009940", organizationName: "重复信用代码组织一" }),
      postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000040", phone: "13600009941", organizationName: "重复信用代码组织二" })
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(db.organizations.filter((row) => row.creditCode === "91330300TEST000040").length, 1);
    assert.equal(db.organizationDocuments.length, 1);
    const directories = await fs.readdir(path.join(tempDir, "uploads", "organization-documents"));
    assert.equal(directories.length, 1);
    await fs.access(db.organizationDocuments[0].filePath);
  }, { prefix: "organization-credit-race-" });
});

test("PostgreSQL store mutation lock preserves concurrent registrations across store instances", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const store = createPostgresStore(new Pool());
  let sequence = 0;
  const makeId = (prefix) => `${prefix}${++sequence}`;
  const register = (storeInstance, creditCode, phone) => storeInstance.withMutationLock(() =>
    registerOrganization({
        input: { name: "并发负责人", phone, password: "Strong123", organizationName: `组织-${creditCode}`, creditCode, documentType: "business_license" },
        file: uploadedFile(pdfBuffer, "license.pdf", "application/pdf"),
        readDb: () => storeInstance.readDb(),
        writeDb: (db) => storeInstance.writeDb(db),
        hashPassword: async () => "hash",
        validatePassword: () => "",
        makeId,
        now: () => "2026-07-17T00:00:00.000Z",
        saveFile: async ({ ownerId }) => ({
          filePath: `/safe/uploads/organization-documents/${ownerId}/license.pdf`, originalName: "license.pdf", storedName: `${ownerId}.pdf`, mimeType: "application/pdf", size: pdfBuffer.length
        })
      })
  );

  try {
    await store.initialize();
    const secondStore = createPostgresStore(new Pool());
    await secondStore.initialize();
    const [first, second] = await Promise.all([
      register(store, "91330300TEST000032", "13600009932"),
      register(secondStore, "91330300TEST000033", "13600009933")
    ]);
    const db = await store.readDb();
    for (const result of [first, second]) {
      assert.ok(db.users.some((row) => row.id === result.user.id));
      assert.equal(db.organizations.find((row) => row.id === result.organization.id)?.currentDocumentId, result.document.id);
      assert.ok(db.organizationDocuments.some((row) => row.id === result.document.id));
    }
    await secondStore.close();
  } finally {
    await store.close();
  }
});

test("organization registration maps a PostgreSQL credit-code conflict to 409 and cleans its new file", async () => {
  const saved = { filePath: "/safe/uploads/organization-documents/O2/license.pdf", originalName: "license.pdf", storedName: "license.pdf", mimeType: "application/pdf", size: pdfBuffer.length };
  const cleaned = [];
  const conflict = new Error("duplicate key");
  conflict.code = "23505";
  await assert.rejects(
    () => registerOrganization({
      input: { name: "冲突负责人", phone: "13600009942", password: "Strong123", organizationName: "冲突组织", creditCode: "91330300TEST000042", documentType: "business_license" },
      file: uploadedFile(pdfBuffer, "license.pdf", "application/pdf"),
      readDb: async () => ({ users: [], organizations: [], memberships: [], organizationDocuments: [] }),
      writeDb: async () => { throw conflict; },
      hashPassword: async () => "hash",
      validatePassword: () => "",
      makeId: (prefix) => `${prefix}2`,
      now: () => "2026-07-17T00:00:00.000Z",
      saveFile: async () => saved,
      removePrivateFile: async (record) => { cleaned.push(record.filePath); }
    }),
    (error) => error.status === 409
  );
  assert.deepEqual(cleaned, [saved.filePath]);
});

test("organization resubmission maps a PostgreSQL credit-code conflict to 409 and cleans its new file", async () => {
  const saved = { filePath: "/safe/uploads/organization-documents/O2/replacement.pdf", originalName: "replacement.pdf", storedName: "replacement.pdf", mimeType: "application/pdf", size: pdfBuffer.length };
  const cleaned = [];
  const conflict = Object.assign(new Error("duplicate key"), { code: "23505" });
  const db = ensureDbShape({
    users: [],
    organizations: [{ id: "O2", ownerUserId: "U2", name: "Old", creditCode: "91330300TEST000042", reviewStatus: "rejected", createdAt: "2026-07-16T00:00:00.000Z" }],
    memberships: [],
    organizationDocuments: [],
    fileCleanupJournal: []
  });
  await assert.rejects(() => resubmitOrganization({
    input: { organizationName: "New", creditCode: "91330300TEST000043", documentType: "business_license" },
    file: uploadedFile(pdfBuffer, "replacement.pdf", "application/pdf"), userId: "U2",
    readDb: async () => structuredClone(db), writeDb: async () => { throw conflict; },
    makeId: (prefix) => `${prefix}2`, now: () => "2026-07-17T00:00:00.000Z",
    saveFile: async () => saved, removePrivateFile: async (record) => { cleaned.push(record.filePath); }
  }), (error) => error.status === 409);
  assert.deepEqual(cleaned, [saved.filePath]);
});

test("deleting an organization owner with credential records is blocked before it can orphan private files", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const registered = await postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000050", phone: "13600009950" });
    const payload = await registered.json();
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const deletion = await fetch(`${baseUrl}/api/admin/users/${payload.user.id}`, withSession(admin.cookie, { method: "DELETE" }));
    assert.equal(deletion.status, 409);
    const owner = await loginAs(baseUrl, "13600009950", "Strong123");
    const credential = await fetch(`${baseUrl}/api/organizations/${payload.organization.id}/credential/${payload.document.id}`, withSession(owner.cookie));
    assert.equal(credential.status, 200);
  }, { prefix: "organization-owner-delete-" });
});

test("organization registration returns 422 with readable errors for forged or oversized credentials", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const forged = await postOrganizationRegistration(baseUrl, {
      creditCode: "91330300TEST000060", phone: "13600009960", credentialBuffer: Buffer.from("not-a-real-pdf"), credentialName: "forged.pdf"
    });
    assert.equal(forged.status, 422);
    assert.match((await forged.json()).error, /签名|文件|支持|资质/i);

    const oversized = await postOrganizationRegistration(baseUrl, {
      creditCode: "91330300TEST000061", phone: "13600009961", credentialBuffer: Buffer.alloc(10 * 1024 * 1024 + 1), credentialName: "large.pdf"
    });
    assert.equal(oversized.status, 422);
    assert.match((await oversized.json()).error, /大小|文件|资质/i);
  }, { prefix: "organization-invalid-credential-" });
});

test("organization review cannot approve historical records missing a credential or valid credit code", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const withoutDocument = await postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000070", phone: "13600009970" });
    const noDocumentPayload = await withoutDocument.json();
    const dbWithoutDocument = JSON.parse(await fs.readFile(dbPath, "utf8"));
    dbWithoutDocument.organizationDocuments = dbWithoutDocument.organizationDocuments.filter((row) => row.organizationId !== noDocumentPayload.organization.id);
    await fs.writeFile(dbPath, JSON.stringify(dbWithoutDocument), "utf8");
    const noDocumentApproval = await fetch(`${baseUrl}/api/admin/organizations/${noDocumentPayload.organization.id}/review`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved", reason: "" })
    }));
    assert.equal(noDocumentApproval.status, 422);

    const invalidCredit = await postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000071", phone: "13600009971" });
    const invalidCreditPayload = await invalidCredit.json();
    const dbInvalidCredit = JSON.parse(await fs.readFile(dbPath, "utf8"));
    dbInvalidCredit.organizations.find((row) => row.id === invalidCreditPayload.organization.id).creditCode = "INVALID";
    await fs.writeFile(dbPath, JSON.stringify(dbInvalidCredit), "utf8");
    const invalidCreditApproval = await fetch(`${baseUrl}/api/admin/organizations/${invalidCreditPayload.organization.id}/review`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved", reason: "" })
    }));
    assert.equal(invalidCreditApproval.status, 422);
  }, { prefix: "organization-review-defense-" });
});

test("organization review rejects a current credential outside UPLOAD_ROOT or with a changed disk signature", async () => {
  await withTestServer(async ({ baseUrl, dbPath, tempDir }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const outsidePath = path.join(tempDir, "outside.pdf");
    await fs.writeFile(outsidePath, pdfBuffer);
    const outside = await postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000072", phone: "13600009972" });
    const outsidePayload = await outside.json();
    let db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.organizationDocuments.find((row) => row.id === outsidePayload.document.id).filePath = outsidePath;
    await fs.writeFile(dbPath, JSON.stringify(db), "utf8");
    const outsideApproval = await fetch(`${baseUrl}/api/admin/organizations/${outsidePayload.organization.id}/review`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved", reason: "" })
    }));
    assert.equal(outsideApproval.status, 422);
    await fs.access(outsidePath);

    const drifted = await postOrganizationRegistration(baseUrl, { creditCode: "91330300TEST000073", phone: "13600009973" });
    const driftedPayload = await drifted.json();
    db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const driftedDocument = db.organizationDocuments.find((row) => row.id === driftedPayload.document.id);
    await fs.writeFile(driftedDocument.filePath, Buffer.alloc(driftedDocument.sizeBytes, 0x41));
    const driftedApproval = await fetch(`${baseUrl}/api/admin/organizations/${driftedPayload.organization.id}/review`, withSession(admin.cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved", reason: "" })
    }));
    assert.equal(driftedApproval.status, 422);
  }, { prefix: "organization-review-disk-defense-" });
});

test("credential policy accepts real PNG and PDF and rejects disguised executables", async () => {
  const pngFile = uploadedFile(pngBuffer, "license.png", "image/png");
  const pdfFile = uploadedFile(pdfBuffer, "license.pdf", "application/pdf");
  const exeFile = uploadedFile(executableBuffer, "license.exe", "application/x-msdownload");

  await assert.doesNotReject(() => validateUpload(pngFile, CREDENTIAL_POLICY));
  await assert.doesNotReject(() => validateUpload(pdfFile, CREDENTIAL_POLICY));
  await assert.rejects(() => validateUpload({ ...exeFile, originalname: "license.png", mimetype: "image/png" }));
});

test("credential policy accepts a real JPEG signature", async () => {
  assert.deepEqual(jpegBuffer.subarray(-2), Buffer.from([0xff, 0xd9]));
  await assert.doesNotReject(() => validateUpload(uploadedFile(jpegBuffer, "license.jpeg", "image/jpeg"), CREDENTIAL_POLICY));
});

test("credential policy validates detected type and byte limit instead of client metadata", async () => {
  await assert.doesNotReject(() => validateUpload(uploadedFile(pngBuffer, "credential.bin"), CREDENTIAL_POLICY));
  await assert.rejects(
    () => validateUpload(uploadedFile(Buffer.concat([pngBuffer, Buffer.alloc(CREDENTIAL_POLICY.maxBytes)]), "too-large.png"), CREDENTIAL_POLICY),
    /size|large|10/i
  );
});

test("private storage uses a UUID filename, keeps files under UPLOAD_ROOT, and safely records the original name", async () => {
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "credentials-"));
  const previousRoot = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = uploadRoot;

  try {
    const record = await savePrivateFile({
      category: "organization-documents",
      ownerId: "org-123",
      file: uploadedFile(pdfBuffer, "../营业执照<>.pdf", "text/plain")
    });

    assert.match(record.storedName, /^[0-9a-f-]{36}\.pdf$/i);
    assert.equal(record.originalName.includes(".."), false);
    assert.equal(record.mimeType, "application/pdf");
    assert.equal(record.size, pdfBuffer.length);
    assert.equal(path.relative(uploadRoot, record.filePath).startsWith(".."), false);
    assert.deepEqual(await fs.readFile(record.filePath), pdfBuffer);

    await deletePrivateFile(record);
    await assert.rejects(fs.access(record.filePath));
  } finally {
    if (previousRoot === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previousRoot;
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
});

test("private storage rejects traversal in category and owner paths", async () => {
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "credentials-"));
  const previousRoot = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = uploadRoot;

  try {
    await assert.rejects(
      () => savePrivateFile({ category: "../outside", ownerId: "org-123", file: uploadedFile(pdfBuffer, "license.pdf") }),
      /path|category|owner/i
    );
    await assert.rejects(
      () => savePrivateFile({ category: "organization-documents", ownerId: "../outside", file: uploadedFile(pdfBuffer, "license.pdf") }),
      /path|category|owner/i
    );
  } finally {
    if (previousRoot === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previousRoot;
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
});

test("private storage removes only its attempted UUID file when writing fails", async () => {
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "credentials-"));
  const sentinelPath = path.join(uploadRoot, "sentinel.txt");
  const previousRoot = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = uploadRoot;
  await fs.writeFile(sentinelPath, "keep");
  let attemptedPath;
  const failingFs = {
    mkdir: fs.mkdir.bind(fs),
    async writeFile(filePath, buffer) {
      attemptedPath = filePath;
      await fs.writeFile(filePath, buffer);
      throw new Error("simulated disk failure");
    },
    unlink: fs.unlink.bind(fs)
  };

  try {
    await assert.rejects(
      () => savePrivateFile({
        category: "organization-documents",
        ownerId: "org-123",
        file: uploadedFile(pdfBuffer, "license.pdf"),
        fileSystem: failingFs
      }),
      /simulated disk failure/
    );
    await assert.rejects(fs.access(attemptedPath));
    assert.equal(await fs.readFile(sentinelPath, "utf8"), "keep");
  } finally {
    if (previousRoot === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previousRoot;
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
});

test("private storage never removes an existing file when exclusive creation reports EEXIST", async () => {
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "credentials-"));
  const previousRoot = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = uploadRoot;
  let attemptedPath;
  const exclusiveFailureFs = {
    mkdir: fs.mkdir.bind(fs),
    async writeFile(filePath) {
      attemptedPath = filePath;
      await fs.writeFile(filePath, "existing file");
      const error = new Error("already exists");
      error.code = "EEXIST";
      throw error;
    },
    unlink: fs.unlink.bind(fs)
  };

  try {
    await assert.rejects(
      () => savePrivateFile({
        category: "organization-documents",
        ownerId: "org-123",
        file: uploadedFile(pdfBuffer, "license.pdf"),
        fileSystem: exclusiveFailureFs
      }),
      /already exists/
    );
    assert.equal(await fs.readFile(attemptedPath, "utf8"), "existing file");
  } finally {
    if (previousRoot === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previousRoot;
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
});

test("private deletion refuses a record outside UPLOAD_ROOT", async () => {
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "credentials-"));
  const outsidePath = path.join(os.tmpdir(), `outside-${crypto.randomUUID()}.pdf`);
  const previousRoot = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = uploadRoot;
  await fs.writeFile(outsidePath, pdfBuffer);

  try {
    await assert.rejects(() => deletePrivateFile({ filePath: outsidePath }), /escapes upload root/i);
    assert.deepEqual(await fs.readFile(outsidePath), pdfBuffer);
  } finally {
    if (previousRoot === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previousRoot;
    await fs.rm(uploadRoot, { recursive: true, force: true });
    await fs.rm(outsidePath, { force: true });
  }
});

test("legacy file snapshots migrate to approved while new organizations remain pending", () => {
  const legacy = ensureDbShape({
    users: [],
    organizations: [{ id: "legacy-org", createdAt: "2026-01-01T00:00:00.000Z" }]
  });
  const current = ensureDbShape(structuredClone(seedDb));
  current.organizations.push({
    id: "new-org",
    createdAt: "2026-07-17T00:00:00.000Z"
  });
  current.organizations.push({
    id: "new-org-two",
    createdAt: "2026-07-17T00:00:00.000Z"
  });
  const shapedCurrent = ensureDbShape(current);
  const newOrganization = shapedCurrent.organizations.find((organization) => organization.id === "new-org");
  const secondNewOrganization = shapedCurrent.organizations.find((organization) => organization.id === "new-org-two");

  assert.equal(legacy.organizations[0].creditCode, "LEGACY-legacy-org");
  assert.equal(legacy.organizations[0].reviewStatus, "approved");
  assert.equal(newOrganization.reviewStatus, "pending");
  assert.equal(newOrganization.creditCode, "PENDING-new-org");
  assert.equal(secondNewOrganization.creditCode, "PENDING-new-org-two");
  assert.notEqual(newOrganization.creditCode, secondNewOrganization.creditCode);
});

test("legacy owner and unbound invitation memberships are normalized out of actionable summaries", () => {
  const db = ensureDbShape({
    users: [{ id: "U1", type: "organization" }, { id: "U2", type: "ordinary" }],
    organizations: [{ id: "O1", createdAt: "2026-01-01T00:00:00.000Z" }],
    memberships: [
      { id: "M-owner", userId: "U1", organizationId: "O1", role: "owner", status: "active" },
      { id: "M-unbound", userId: null, organizationId: "O1", direction: "organization_invite", status: "pending" },
      { id: "M-member", userId: "U2", organizationId: "O1", role: "member", status: "active" }
    ]
  });
  assert.equal(db.memberships.find((row) => row.id === "M-owner").status, "removed");
  assert.equal(db.memberships.find((row) => row.id === "M-unbound").status, "rejected");
  assert.equal(db.memberships.find((row) => row.id === "M-member").status, "active");
});

test("file snapshots deterministically migrate currentDocumentId by uploadedAt and then id", () => {
  const db = ensureDbShape({
    users: [],
    organizations: [{ id: "O1", createdAt: "2026-01-01T00:00:00.000Z" }],
    organizationDocuments: [
      { id: "DOC-A", organizationId: "O1", uploadedAt: "2026-07-17T00:00:00.000Z", cleanedAt: null },
      { id: "DOC-C", organizationId: "O1", uploadedAt: "2026-07-17T00:00:01.000Z", cleanedAt: null },
      { id: "DOC-B", organizationId: "O1", uploadedAt: "2026-07-17T00:00:01.000Z", cleanedAt: null }
    ]
  });
  assert.equal(db.organizations[0].currentDocumentId, "DOC-C");
});

test("PostgreSQL credential migration upgrades a legacy organization only during first initialization", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  await pool.query(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, password TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, owner_user_id TEXT NOT NULL REFERENCES users(id), contact_name TEXT NOT NULL DEFAULT '', contact_phone TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE organization_documents (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, document_type TEXT NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, file_path TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes BIGINT NOT NULL, uploaded_at TIMESTAMPTZ NOT NULL, cleaned_at TIMESTAMPTZ);
    INSERT INTO users VALUES ('ULEGACY', 'Legacy owner', '13000000000', 'secret', 'organization', 'active', '2026-01-01T00:00:00.000Z');
    INSERT INTO organizations VALUES ('OLEGACY', 'Legacy organization', 'LEGACY', 'ULEGACY', 'Owner', '13000000000', 'active', '2026-01-01T00:00:00.000Z');
    INSERT INTO organization_documents VALUES
      ('DOC-A', 'OLEGACY', 'business_license', 'a.pdf', 'a.pdf', '/data/uploads/a.pdf', 'application/pdf', 10, '2026-07-16T00:00:00.000Z', NULL),
      ('DOC-B', 'OLEGACY', 'business_license', 'b.pdf', 'b.pdf', '/data/uploads/b.pdf', 'application/pdf', 10, '2026-07-17T00:00:00.000Z', NULL),
      ('DOC-C', 'OLEGACY', 'business_license', 'c.pdf', 'c.pdf', '/data/uploads/c.pdf', 'application/pdf', 10, '2026-07-17T00:00:00.000Z', NULL);
  `);
  let store = createPostgresStore(pool);

  try {
    await store.initialize();
    const migrated = (await store.readDb()).organizations.find((organization) => organization.id === "OLEGACY");
    assert.equal(migrated.creditCode, "LEGACY-OLEGACY");
    assert.equal(migrated.reviewStatus, "approved");
    assert.equal(migrated.currentDocumentId, "DOC-C");
    assert.equal((await store.pool.query("SELECT name FROM schema_migrations WHERE name = $1", ["002-organization-credentials.sql"])).rowCount, 1);
    assert.equal((await store.pool.query("SELECT name FROM schema_migrations WHERE name = $1", ["005-organization-current-document.sql"])).rowCount, 1);

    await store.close();
    store = createPostgresStore(new Pool());
    await store.initialize();
    assert.equal((await store.pool.query("SELECT name FROM schema_migrations WHERE name = $1", ["002-organization-credentials.sql"])).rowCount, 1);
  } finally {
    await store.close();
  }
});

test("PostgreSQL store creates organization_documents, migrates legacy organizations, and persists credential rows", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  let store = createPostgresStore(new Pool());

  try {
    await store.initialize();
    const tables = await store.pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'organization_documents'
    `);
    assert.equal(tables.rowCount, 1);

    const data = await store.readDb();
    assert.equal(data.organizations.every((organization) => organization.creditCode && organization.reviewStatus === "approved"), true);
    assert.deepEqual(data.organizationDocuments, []);
    data.organizations.push({
      id: "OPENDING",
      name: "Pending Organization",
      code: "PENDING-ORG",
      ownerUserId: data.users[0].id,
      contactName: "Owner",
      contactPhone: "13900000001",
      status: "active",
      createdAt: "2026-07-17T00:00:00.000Z"
    });

    data.organizationDocuments.push({
      id: "DOC1001",
      organizationId: data.organizations[0].id,
      documentType: "business-license",
      originalName: "license.pdf",
      storedName: "00000000-0000-4000-8000-000000000001.pdf",
      filePath: "/data/uploads/organization-documents/O1001/00000000-0000-4000-8000-000000000001.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
      uploadedAt: "2026-07-17T00:00:00.000Z",
      cleanedAt: null
    });
    await store.writeDb(data);

    const persisted = await store.readDb();
    assert.equal(persisted.organizationDocuments[0].id, "DOC1001");
    assert.equal(persisted.organizations.find((organization) => organization.id === "OPENDING").reviewStatus, "pending");
    assert.equal(persisted.organizations.find((organization) => organization.id === "OPENDING").creditCode, "PENDING-OPENDING");
    const migrationRows = await store.pool.query("SELECT name FROM schema_migrations WHERE name = $1", ["002-organization-credentials.sql"]);
    assert.equal(migrationRows.rowCount, 1);

    await store.close();
    store = createPostgresStore(new Pool());
    await store.initialize();
    const restarted = await store.readDb();
    const pending = restarted.organizations.find((organization) => organization.id === "OPENDING");
    assert.equal(pending.reviewStatus, "pending");
    assert.equal(pending.creditCode, "PENDING-OPENDING");
    assert.equal((await store.pool.query("SELECT name FROM schema_migrations WHERE name = $1", ["002-organization-credentials.sql"])).rowCount, 1);
    await assert.rejects(store.pool.query(
      "UPDATE organizations SET credit_code = $1 WHERE id = $2",
      [persisted.organizations[0].creditCode, persisted.organizations[1].id]
    ));
  } finally {
    await store.close();
  }
});
