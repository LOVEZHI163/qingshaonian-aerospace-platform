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

const pngBuffer = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63600000020001e221bc330000000049454e44ae426082", "hex");
const pdfBuffer = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const jpegBuffer = Buffer.from("ffd8ffe000104a46494600010100000100010000ffdb004300", "hex");
const executableBuffer = Buffer.from("4d5a90000300000004000000ffff0000b8000000", "hex");

function uploadedFile(buffer, originalname, mimetype = "application/octet-stream") {
  return { buffer, size: buffer.length, originalname, mimetype };
}

test("credential policy accepts real PNG and PDF and rejects disguised executables", async () => {
  const pngFile = uploadedFile(pngBuffer, "license.png", "image/png");
  const pdfFile = uploadedFile(pdfBuffer, "license.pdf", "application/pdf");
  const exeFile = uploadedFile(executableBuffer, "license.exe", "application/x-msdownload");

  await assert.doesNotReject(() => validateUpload(pngFile, CREDENTIAL_POLICY));
  await assert.doesNotReject(() => validateUpload(pdfFile, CREDENTIAL_POLICY));
  await assert.rejects(() => validateUpload({ ...exeFile, originalname: "license.png", mimetype: "image/png" }));
});

test("credential policy accepts a real JPEG signature", async () => {
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
    creditCode: "NEW-CREDIT-CODE",
    createdAt: "2026-07-17T00:00:00.000Z"
  });
  const newOrganization = ensureDbShape(current).organizations.find((organization) => organization.id === "new-org");

  assert.equal(legacy.organizations[0].creditCode, "LEGACY-legacy-org");
  assert.equal(legacy.organizations[0].reviewStatus, "approved");
  assert.equal(newOrganization.reviewStatus, "pending");
  assert.equal(newOrganization.creditCode, "NEW-CREDIT-CODE");
});

test("PostgreSQL store creates organization_documents, migrates legacy organizations, and persists credential rows", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const store = createPostgresStore(new Pool());

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
      creditCode: "PENDING-CREDIT",
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
    await assert.rejects(store.pool.query(
      "UPDATE organizations SET credit_code = $1 WHERE id = $2",
      [persisted.organizations[0].creditCode, persisted.organizations[1].id]
    ));
  } finally {
    await store.close();
  }
});
