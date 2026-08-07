import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ORGANIZATION_LEADER_DOCUMENT_POLICY, validateUpload } from "../src/files/policy.js";
import {
  createOrganizationLeader,
  listOrganizationLeaders,
  organizationHasApprovedLeader,
  reviewOrganizationLeader,
  setOrganizationLeaderEnabled,
  updateOrganizationLeader
} from "../src/services/organization-leaders.js";

const pdfBuffer = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const pngBuffer = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63600000020001e221bc330000000049454e44ae426082", "hex");
const jpegBuffer = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAFcf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAQUCq//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEABj8Cp//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8h/9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAQ/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAE/EP/Z", "base64");

const actor = { id: "user-organization-owner" };
const reviewer = { id: "user-admin" };

function file(buffer = pdfBuffer, originalname = "领队授权书.pdf") {
  return { buffer, originalname, mimetype: "application/octet-stream", size: buffer.length };
}

function dbFixture() {
  return {
    organizations: [{ id: "organization-1", name: "温州市实验小学" }],
    organizationLeaders: [],
    organizationLeaderDocuments: [],
    organizationLeaderReviews: []
  };
}

async function withUploadRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "organization-leaders-"));
  const previous = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("organization can create multiple pending leaders while email and notes stay optional", async () => {
  await withUploadRoot(async (root) => {
    const db = dbFixture();
    const first = await createOrganizationLeader(db, {
      organizationId: "organization-1",
      name: " 张老师 ",
      phone: "138 0000 0000",
      authorizationFile: file()
    }, actor);
    const second = await createOrganizationLeader(db, {
      organizationId: "organization-1",
      name: "李老师",
      phone: "13900000000",
      email: " leader@example.com ",
      notes: " 校队领队 ",
      authorizationFile: file(pngBuffer, "授权书.png")
    }, actor);

    assert.equal(first.leader.name, "张老师");
    assert.equal(first.leader.phone, "13800000000");
    assert.equal(first.leader.email, "");
    assert.equal(first.leader.notes, "");
    assert.equal(first.leader.reviewStatus, "pending");
    assert.equal(first.leader.submissionVersion, 1);
    assert.equal(second.leader.email, "leader@example.com");
    assert.equal(second.leader.notes, "校队领队");
    assert.equal(listOrganizationLeaders(db, "organization-1").length, 2);
    assert.equal(db.organizationLeaderReviews.every((row) => row.action === "submitted"), true);
    assert.equal(db.organizationLeaderDocuments.length, 2);
    assert.equal(path.relative(root, first.document.filePath).split(path.sep)[0], "organization-leader-documents");
    assert.deepEqual(await fs.readFile(first.document.filePath), pdfBuffer);
  });
});

test("leader name, phone, and authorization document are required", async () => {
  await withUploadRoot(async () => {
    for (const input of [
      { organizationId: "organization-1", name: "", phone: "13800000000", authorizationFile: file() },
      { organizationId: "organization-1", name: "张老师", phone: "", authorizationFile: file() },
      { organizationId: "organization-1", name: "张老师", phone: "13800000000" }
    ]) {
      await assert.rejects(() => createOrganizationLeader(dbFixture(), input, actor), (error) => error.status === 422);
    }
  });
});

test("leader authorization policy accepts PDF, JPEG and PNG signatures up to 10 MB", async () => {
  await assert.doesNotReject(() => validateUpload(file(pdfBuffer), ORGANIZATION_LEADER_DOCUMENT_POLICY));
  await assert.doesNotReject(() => validateUpload(file(pngBuffer, "授权书.png"), ORGANIZATION_LEADER_DOCUMENT_POLICY));
  await assert.doesNotReject(() => validateUpload(file(jpegBuffer, "授权书.jpg"), ORGANIZATION_LEADER_DOCUMENT_POLICY));
  await assert.rejects(
    () => validateUpload(file(Buffer.from("not an image"), "伪造授权书.png"), ORGANIZATION_LEADER_DOCUMENT_POLICY),
    /signature/i
  );
  await assert.rejects(
    () => validateUpload(file(Buffer.alloc(10 * 1024 * 1024 + 1), "超大授权书.pdf"), ORGANIZATION_LEADER_DOCUMENT_POLICY),
    /byte limit/i
  );
});

test("leader creation maps forged and oversized authorization documents to 422 without partial state", async () => {
  await withUploadRoot(async () => {
    for (const authorizationFile of [
      file(Buffer.from("not an image"), "伪造授权书.png"),
      file(Buffer.alloc(10 * 1024 * 1024 + 1), "超大授权书.pdf")
    ]) {
      const db = dbFixture();
      await assert.rejects(
        () => createOrganizationLeader(db, {
          organizationId: "organization-1",
          name: "张老师",
          phone: "13800000000",
          authorizationFile
        }, actor),
        (error) => error.status === 422 && /授权书无效/.test(error.message)
      );
      assert.deepEqual(db.organizationLeaders, []);
      assert.deepEqual(db.organizationLeaderDocuments, []);
      assert.deepEqual(db.organizationLeaderReviews, []);
    }
  });
});

test("leader creation propagates private storage I/O errors without partial state", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "organization-leader-storage-error-"));
  const blockedRoot = path.join(parent, "upload-root-is-a-file");
  await fs.writeFile(blockedRoot, "blocks child directories");
  const previous = process.env.UPLOAD_ROOT;
  process.env.UPLOAD_ROOT = blockedRoot;
  try {
    const db = dbFixture();
    await assert.rejects(
      () => createOrganizationLeader(db, {
        organizationId: "organization-1",
        name: "张老师",
        phone: "13800000000",
        authorizationFile: file()
      }, actor),
      (error) => {
        assert.equal(error.status, undefined);
        assert.match(error.code, /^(ENOTDIR|EACCES|EPERM)$/);
        return true;
      }
    );
    assert.deepEqual(db.organizationLeaders, []);
    assert.deepEqual(db.organizationLeaderDocuments, []);
    assert.deepEqual(db.organizationLeaderReviews, []);
  } finally {
    if (previous === undefined) delete process.env.UPLOAD_ROOT;
    else process.env.UPLOAD_ROOT = previous;
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("only name, phone, or authorization changes create a new pending submission", async () => {
  await withUploadRoot(async () => {
    const db = dbFixture();
    const { leader } = await createOrganizationLeader(db, {
      organizationId: "organization-1", name: "张老师", phone: "13800000000", authorizationFile: file()
    }, actor);
    reviewOrganizationLeader(db, leader.id, { status: "approved" }, reviewer);

    const reviewCount = db.organizationLeaderReviews.length;
    await updateOrganizationLeader(db, leader.id, { email: "new@example.com", notes: "更新备注" }, actor);
    assert.equal(leader.reviewStatus, "approved");
    assert.equal(leader.submissionVersion, 1);
    assert.equal(db.organizationLeaderReviews.length, reviewCount);

    await updateOrganizationLeader(db, leader.id, { name: "王老师" }, actor);
    assert.equal(leader.reviewStatus, "pending");
    assert.equal(leader.submissionVersion, 2);
    assert.equal(db.organizationLeaderReviews.at(-1).action, "submitted");
    assert.equal(db.organizationLeaderReviews.at(-1).snapshot.name, "王老师");

    reviewOrganizationLeader(db, leader.id, { status: "approved" }, reviewer);
    await updateOrganizationLeader(db, leader.id, { phone: "139-0000-0000" }, actor);
    assert.equal(leader.reviewStatus, "pending");
    assert.equal(leader.submissionVersion, 3);
    assert.equal(leader.phone, "13900000000");

    reviewOrganizationLeader(db, leader.id, { status: "approved" }, reviewer);
    const oldDocumentId = leader.currentDocumentId;
    await updateOrganizationLeader(db, leader.id, { authorizationFile: file(pngBuffer, "新版授权书.png") }, actor);
    assert.equal(leader.reviewStatus, "pending");
    assert.equal(leader.submissionVersion, 4);
    assert.notEqual(leader.currentDocumentId, oldDocumentId);
    assert.deepEqual(db.organizationLeaderDocuments.map((row) => row.version), [1, 2]);
    assert.equal(db.organizationLeaderDocuments.every((row) => row.cleanedAt === null), true);
  });
});

test("rejection needs a reason, approval clears it, and every review remains in history", async () => {
  await withUploadRoot(async () => {
    const db = dbFixture();
    const { leader } = await createOrganizationLeader(db, {
      organizationId: "organization-1", name: "张老师", phone: "13800000000", authorizationFile: file()
    }, actor);

    assert.throws(
      () => reviewOrganizationLeader(db, leader.id, { status: "rejected", reason: "  " }, reviewer),
      (error) => error.status === 422
    );
    reviewOrganizationLeader(db, leader.id, { status: "rejected", reason: "授权书缺少盖章" }, reviewer);
    assert.equal(leader.rejectionReason, "授权书缺少盖章");
    reviewOrganizationLeader(db, leader.id, { status: "approved", reason: "材料已补齐" }, reviewer);
    assert.equal(leader.rejectionReason, "");
    assert.deepEqual(db.organizationLeaderReviews.map((row) => row.action), ["submitted", "rejected", "approved"]);
    assert.equal(db.organizationLeaderReviews[1].reason, "授权书缺少盖章");
    assert.equal(organizationHasApprovedLeader(db, "organization-1"), true);
  });
});

test("enabling and disabling are independent from review state and preserve audit rows", async () => {
  await withUploadRoot(async () => {
    const db = dbFixture();
    const { leader } = await createOrganizationLeader(db, {
      organizationId: "organization-1", name: "张老师", phone: "13800000000", authorizationFile: file()
    }, actor);
    reviewOrganizationLeader(db, leader.id, { status: "approved" }, reviewer);

    setOrganizationLeaderEnabled(db, leader.id, false, reviewer);
    assert.equal(leader.enabled, false);
    assert.equal(leader.reviewStatus, "approved");
    assert.equal(organizationHasApprovedLeader(db, "organization-1"), false);
    setOrganizationLeaderEnabled(db, leader.id, true, reviewer);
    assert.equal(organizationHasApprovedLeader(db, "organization-1"), true);
    assert.deepEqual(db.organizationLeaderReviews.map((row) => row.action), ["submitted", "approved", "disabled", "enabled"]);
  });
});
