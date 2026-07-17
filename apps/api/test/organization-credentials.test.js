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
import { registerOrganization } from "../src/services/organizations.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const pngBuffer = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63600000020001e221bc330000000049454e44ae426082", "hex");
const pdfBuffer = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const jpegBuffer = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAFcf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAQUCq//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEABj8Cp//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8h/9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAE/EP/Z", "base64");
const executableBuffer = Buffer.from("4d5a90000300000004000000ffff0000b8000000", "hex");

function uploadedFile(buffer, originalname, mimetype = "application/octet-stream") {
  return { buffer, size: buffer.length, originalname, mimetype };
}

function organizationRegistration({ creditCode = "91330300TEST000001", documentType = "business_license", includeCredential = true } = {}) {
  const form = new FormData();
  form.set("name", "组织负责人");
  form.set("phone", "13600009991");
  form.set("password", "Strong123");
  form.set("organizationName", "待审核航空学校");
  form.set("creditCode", creditCode);
  form.set("documentType", documentType);
  if (includeCredential) form.set("credential", new Blob([pdfBuffer], { type: "application/pdf" }), "license.pdf");
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
    assert.equal(Object.hasOwn(reviewedOrganization.documents[0], "filePath"), false);

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
    const { organization } = await register.json();
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
  }, { prefix: "org-resubmit-" });
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

test("PostgreSQL credential migration upgrades a legacy organization only during first initialization", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  await pool.query(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, password TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, owner_user_id TEXT NOT NULL REFERENCES users(id), contact_name TEXT NOT NULL DEFAULT '', contact_phone TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
    INSERT INTO users VALUES ('ULEGACY', 'Legacy owner', '13000000000', 'secret', 'organization', 'active', '2026-01-01T00:00:00.000Z');
    INSERT INTO organizations VALUES ('OLEGACY', 'Legacy organization', 'LEGACY', 'ULEGACY', 'Owner', '13000000000', 'active', '2026-01-01T00:00:00.000Z');
  `);
  let store = createPostgresStore(pool);

  try {
    await store.initialize();
    const migrated = (await store.readDb()).organizations.find((organization) => organization.id === "OLEGACY");
    assert.equal(migrated.creditCode, "LEGACY-OLEGACY");
    assert.equal(migrated.reviewStatus, "approved");
    assert.equal((await store.pool.query("SELECT name FROM schema_migrations WHERE name = $1", ["002-organization-credentials.sql"])).rowCount, 1);

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
