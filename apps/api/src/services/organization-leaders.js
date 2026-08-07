import crypto from "node:crypto";

import { ORGANIZATION_LEADER_DOCUMENT_POLICY, validateUpload } from "../files/policy.js";
import { savePrivateFile } from "../files/storage.js";

const REVIEW_DECISIONS = new Set(["approved", "rejected"]);

export class OrganizationLeaderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const validationError = (message) => new OrganizationLeaderError(422, message);

function ensureCollections(db) {
  db.organizationLeaders ||= [];
  db.organizationLeaderDocuments ||= [];
  db.organizationLeaderReviews ||= [];
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw validationError(`${label}不能为空`);
  return text;
}

function normalizedPhone(value) {
  const phone = requiredText(value, "手机").replace(/[^\d]/g, "");
  if (!phone) throw validationError("手机不能为空");
  return phone;
}

function optionalText(value) {
  return String(value ?? "").trim();
}

function timestamp() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function actorId(actor) {
  return actor?.id || null;
}

function findLeader(db, leaderId) {
  const leader = db.organizationLeaders.find((row) => row.id === leaderId);
  if (!leader) throw new OrganizationLeaderError(404, "组织领队不存在");
  return leader;
}

function leaderSnapshot(leader) {
  return {
    name: leader.name,
    phone: leader.phone,
    email: leader.email,
    notes: leader.notes,
    reviewStatus: leader.reviewStatus,
    rejectionReason: leader.rejectionReason,
    enabled: leader.enabled,
    submissionVersion: leader.submissionVersion,
    currentDocumentId: leader.currentDocumentId
  };
}

function appendReview(db, leader, action, actor, reason = "", createdAt = timestamp()) {
  const review = {
    id: makeId("OLR"),
    leaderId: leader.id,
    organizationId: leader.organizationId,
    submissionVersion: leader.submissionVersion,
    action,
    actorId: actorId(actor),
    reason,
    snapshot: leaderSnapshot(leader),
    documentId: leader.currentDocumentId,
    createdAt
  };
  db.organizationLeaderReviews.push(review);
  return review;
}

async function storeAuthorizationFile(leaderId, file) {
  if (!file) throw validationError("授权书不能为空");
  try {
    await validateUpload(file, ORGANIZATION_LEADER_DOCUMENT_POLICY);
    return await savePrivateFile({
      category: "organization-leader-documents",
      ownerId: leaderId,
      file
    });
  } catch (error) {
    if (error instanceof OrganizationLeaderError) throw error;
    throw validationError(`授权书无效：${error.message}`);
  }
}

function nextDocumentVersion(db, leaderId) {
  return db.organizationLeaderDocuments
    .filter((row) => row.leaderId === leaderId)
    .reduce((maximum, row) => Math.max(maximum, Number(row.version) || 0), 0) + 1;
}

function documentRecord(db, leaderId, stored, uploadedAt) {
  return {
    id: makeId("OLD"),
    leaderId,
    version: nextDocumentVersion(db, leaderId),
    originalName: stored.originalName,
    storedName: stored.storedName,
    filePath: stored.filePath,
    mimeType: stored.mimeType,
    sizeBytes: stored.size,
    uploadedAt,
    cleanedAt: null
  };
}

export function listOrganizationLeaders(db, organizationId) {
  ensureCollections(db);
  return db.organizationLeaders.filter((row) => row.organizationId === organizationId);
}

export async function createOrganizationLeader(db, input, actor) {
  ensureCollections(db);
  const organizationId = requiredText(input?.organizationId, "组织");
  if (!(db.organizations || []).some((row) => row.id === organizationId)) {
    throw new OrganizationLeaderError(404, "组织不存在");
  }
  const name = requiredText(input?.name, "姓名");
  const phone = normalizedPhone(input?.phone);
  const email = optionalText(input?.email);
  const notes = optionalText(input?.notes);
  const leaderId = makeId("OL");
  const stored = await storeAuthorizationFile(leaderId, input?.authorizationFile || input?.file);
  const now = timestamp();
  const document = documentRecord(db, leaderId, stored, now);
  const leader = {
    id: leaderId,
    organizationId,
    name,
    phone,
    email,
    notes,
    currentDocumentId: document.id,
    reviewStatus: "pending",
    rejectionReason: "",
    enabled: true,
    submissionVersion: 1,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: now,
    updatedAt: now
  };
  db.organizationLeaders.push(leader);
  db.organizationLeaderDocuments.push(document);
  const review = appendReview(db, leader, "submitted", actor, "", now);
  return { leader, document, review };
}

export async function updateOrganizationLeader(db, leaderId, input, actor) {
  ensureCollections(db);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw validationError("领队资料必须是对象");
  }
  const leader = findLeader(db, leaderId);
  const name = Object.hasOwn(input, "name") ? requiredText(input.name, "姓名") : leader.name;
  const phone = Object.hasOwn(input, "phone") ? normalizedPhone(input.phone) : leader.phone;
  const email = Object.hasOwn(input, "email") ? optionalText(input.email) : leader.email;
  const notes = Object.hasOwn(input, "notes") ? optionalText(input.notes) : leader.notes;
  const authorizationFile = input.authorizationFile || input.file;
  const requiresReview = name !== leader.name || phone !== leader.phone || Boolean(authorizationFile);
  let document = null;
  if (authorizationFile) {
    const stored = await storeAuthorizationFile(leader.id, authorizationFile);
    document = documentRecord(db, leader.id, stored, timestamp());
  }

  const now = timestamp();
  Object.assign(leader, { name, phone, email, notes, updatedAt: now });
  if (document) {
    db.organizationLeaderDocuments.push(document);
    leader.currentDocumentId = document.id;
  }
  let review = null;
  if (requiresReview) {
    leader.reviewStatus = "pending";
    leader.rejectionReason = "";
    leader.submissionVersion += 1;
    leader.reviewedBy = null;
    leader.reviewedAt = null;
    review = appendReview(db, leader, "submitted", actor, "", now);
  }
  return { leader, document, review };
}

export function reviewOrganizationLeader(db, leaderId, decision, actor) {
  ensureCollections(db);
  const leader = findLeader(db, leaderId);
  const status = String(decision?.status || decision?.action || "").trim();
  if (!REVIEW_DECISIONS.has(status)) throw validationError("审核状态无效");
  const reason = optionalText(decision?.reason);
  if (status === "rejected" && !reason) throw validationError("驳回理由不能为空");
  const now = timestamp();
  leader.reviewStatus = status;
  leader.rejectionReason = status === "rejected" ? reason : "";
  leader.reviewedBy = actorId(actor);
  leader.reviewedAt = now;
  leader.updatedAt = now;
  const review = appendReview(db, leader, status, actor, reason, now);
  return { leader, review };
}

export function setOrganizationLeaderEnabled(db, leaderId, enabled, actor) {
  ensureCollections(db);
  if (typeof enabled !== "boolean") throw validationError("启用状态必须是布尔值");
  const leader = findLeader(db, leaderId);
  if (leader.enabled === enabled) return { leader, review: null };
  const now = timestamp();
  leader.enabled = enabled;
  leader.updatedAt = now;
  const review = appendReview(db, leader, enabled ? "enabled" : "disabled", actor, "", now);
  return { leader, review };
}

export function organizationHasApprovedLeader(db, organizationId) {
  ensureCollections(db);
  return db.organizationLeaders.some((row) => (
    row.organizationId === organizationId
    && row.reviewStatus === "approved"
    && row.enabled === true
  ));
}
