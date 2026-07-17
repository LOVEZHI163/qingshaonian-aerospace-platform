import { deletePrivateFile, readPrivateFile, savePrivateFile } from "../files/storage.js";
import { validateUpload } from "../files/policy.js";

export const DOCUMENT_TYPES = new Set([
  "business_license",
  "public_institution_certificate",
  "school_license"
]);

export class OrganizationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const validationError = (message) => new OrganizationError(422, message);

function normalizedPhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw validationError(`${label}不能为空`);
  return text;
}

function validateCredentialInput(input, file) {
  const name = requiredText(input.name, "姓名");
  const phone = normalizedPhone(requiredText(input.phone, "手机号"));
  const password = requiredText(input.password, "密码");
  const organizationName = requiredText(input.organizationName, "组织名称");
  const creditCode = requiredText(input.creditCode, "统一社会信用代码");
  const documentType = requiredText(input.documentType, "资质类型");
  if (!DOCUMENT_TYPES.has(documentType)) throw validationError("资质类型无效");
  if (!/^[0-9A-Z]{18}$/.test(creditCode)) throw validationError("统一社会信用代码必须为 18 位大写字母或数字");
  if (!file) throw validationError("资质文件不能为空");
  return { name, phone, password, organizationName, creditCode, documentType };
}

async function validateCredentialFile(file) {
  try {
    await validateUpload(file);
  } catch (error) {
    throw validationError(`资质文件无效：${error.message}`);
  }
}

function validateOrdinaryInput(input) {
  return {
    name: requiredText(input.name, "姓名"),
    phone: normalizedPhone(requiredText(input.phone, "手机号")),
    password: requiredText(input.password, "密码")
  };
}

function assertAccountAvailable(db, phone, creditCode = null) {
  if (db.users.some((user) => normalizedPhone(user.phone) === phone)) {
    throw new OrganizationError(409, "该手机号已注册");
  }
  if (creditCode && db.organizations.some((organization) => organization.creditCode === creditCode)) {
    throw new OrganizationError(409, "统一社会信用代码已注册");
  }
}

function documentRecord({ makeId, organizationId, documentType, stored, now }) {
  return {
    id: makeId("DOC"),
    organizationId,
    documentType,
    originalName: stored.originalName,
    storedName: stored.storedName,
    filePath: stored.filePath,
    mimeType: stored.mimeType,
    sizeBytes: stored.size,
    uploadedAt: now(),
    cleanedAt: null
  };
}

async function cleanup(file, removePrivateFile) {
  if (!file) return;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await removePrivateFile(file);
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  return { error: lastError };
}

async function journalCleanup(db, file, result, writeDb, makeId, now) {
  if (result === true || !file) return;
  const rollback = structuredClone(db);
  rollback.fileCleanupJournal ||= [];
  rollback.fileCleanupJournal.push({
    id: makeId("CLN"), filePath: file.filePath, category: "organization-documents", attempts: 3,
    lastError: String(result.error?.message || "文件清理失败"), createdAt: now(), lastAttemptAt: now()
  });
  try { await writeDb(rollback); } catch { /* original persistence failure remains primary */ }
}

export async function registerOrdinary({ input, readDb, writeDb, hashPassword, validatePassword, makeId, now }) {
  const { name, phone, password } = validateOrdinaryInput(input);
  const passwordError = validatePassword(password);
  if (passwordError) throw validationError(passwordError);
  const db = await readDb();
  assertAccountAvailable(db, phone);
  const user = {
    id: makeId("U"), name, phone, password: await hashPassword(password), type: "ordinary", status: "active",
    sessionVersion: 0, mustChangePassword: false, createdAt: now()
  };
  db.users.push(user);
  await writeDb(db);
  return { user, organization: null, document: null };
}

export async function registerOrganization({ input, file, readDb, writeDb, hashPassword, validatePassword, makeId, now, saveFile = savePrivateFile, removePrivateFile = deletePrivateFile }) {
  const values = validateCredentialInput(input, file);
  const passwordError = validatePassword(values.password);
  if (passwordError) throw validationError(passwordError);
  await validateCredentialFile(file);
  const db = await readDb();
  const rollbackDb = structuredClone(db);
  assertAccountAvailable(db, values.phone, values.creditCode);

  let stored;
  try {
    const userId = makeId("U");
    const organizationId = makeId("O");
    stored = await saveFile({ category: "organization-documents", ownerId: organizationId, file });
    const user = {
      id: userId, name: values.name, phone: values.phone, password: await hashPassword(values.password), type: "organization", status: "active",
      sessionVersion: 0, mustChangePassword: false, createdAt: now()
    };
    const organization = {
      id: organizationId, name: values.organizationName, code: `ORG-${values.creditCode}`, ownerUserId: user.id,
      contactName: user.name, contactPhone: user.phone, status: "active", creditCode: values.creditCode,
      reviewStatus: "pending", rejectReason: "", reviewedBy: null, reviewedAt: null, createdAt: now(), updatedAt: now()
    };
    const document = documentRecord({ makeId, organizationId: organization.id, documentType: values.documentType, stored, now });
    organization.currentDocumentId = document.id;
    db.users.push(user);
    db.organizations.push(organization);
    db.memberships.push({
      id: makeId("M"), userId: user.id, organizationId: organization.id, role: "owner", status: "active", direction: "system",
      note: "组织注册自动创建", createdAt: now(), updatedAt: now()
    });
    db.organizationDocuments.push(document);
    await writeDb(db);
    return { user, organization, document };
  } catch (error) {
    const cleanupResult = await cleanup(stored, removePrivateFile);
    await journalCleanup(rollbackDb, stored, cleanupResult, writeDb, makeId, now);
    if (error?.code === "23505") throw new OrganizationError(409, "统一社会信用代码已注册");
    throw error;
  }
}

export function reviewOrganization(organization, input, reviewerId, currentTime) {
  if (!new Set(["approved", "rejected"]).has(input.status)) throw validationError("审核状态无效");
  if (input.status === "rejected" && !String(input.reason || "").trim()) throw validationError("驳回原因不能为空");
  organization.reviewStatus = input.status;
  organization.rejectReason = input.status === "rejected" ? input.reason.trim() : "";
  organization.reviewedBy = reviewerId;
  organization.reviewedAt = currentTime;
  organization.updatedAt = currentTime;
  return organization;
}

export function assertOrganizationReadyForApproval(organization, documents) {
  if (!/^[0-9A-Z]{18}$/.test(String(organization.creditCode || ""))) {
    throw validationError("统一社会信用代码无效");
  }
  const credential = documents.find((document) =>
    document.id === organization.currentDocumentId
    && document.organizationId === organization.id
    && !document.cleanedAt
    && DOCUMENT_TYPES.has(document.documentType)
    && String(document.filePath || "").trim()
    && String(document.storedName || "").trim()
  );
  if (!credential) throw validationError("组织缺少有效的当前资质文件");
  return credential;
}

export async function validateCurrentCredentialFile(document, loadFile = readPrivateFile) {
  try {
    const buffer = await loadFile(document);
    if (!Buffer.isBuffer(buffer) || buffer.length !== Number(document.sizeBytes)) {
      throw new Error("Stored file size does not match credential metadata");
    }
    const detected = await validateUpload({ buffer });
    if (detected.mime !== document.mimeType) throw new Error("Stored file signature does not match credential metadata");
  } catch (error) {
    throw validationError(`组织资质文件无效：${error.message}`);
  }
}

export async function resubmitOrganization({ input, file, userId, readDb, writeDb, makeId, now, saveFile = savePrivateFile, removePrivateFile = deletePrivateFile }) {
  const documentType = requiredText(input.documentType, "资质类型");
  if (!DOCUMENT_TYPES.has(documentType)) throw validationError("资质类型无效");
  if (!file) throw validationError("资质文件不能为空");
  await validateCredentialFile(file);
  const db = await readDb();
  const rollbackDb = structuredClone(db);
  const organization = db.organizations.find((row) => row.ownerUserId === userId);
  const owner = organization && db.memberships.some((row) => row.userId === userId && row.organizationId === organization.id && row.role === "owner" && row.status === "active");
  if (!organization || !owner) throw new OrganizationError(403, "只有组织负责人可以修改组织资料");
  if (organization.reviewStatus !== "rejected") throw validationError("只有被驳回的组织可以重新提交");
  const organizationName = requiredText(input.organizationName || organization.name, "组织名称");
  const creditCode = requiredText(input.creditCode || organization.creditCode, "统一社会信用代码");
  if (!/^[0-9A-Z]{18}$/.test(creditCode)) throw validationError("统一社会信用代码必须为 18 位大写字母或数字");
  if (db.organizations.some((row) => row.id !== organization.id && row.creditCode === creditCode)) throw new OrganizationError(409, "统一社会信用代码已注册");

  let stored;
  try {
    stored = await saveFile({ category: "organization-documents", ownerId: organization.id, file });
    const document = documentRecord({ makeId, organizationId: organization.id, documentType, stored, now });
    organization.name = organizationName;
    organization.creditCode = creditCode;
    organization.code = `ORG-${creditCode}`;
    organization.reviewStatus = "pending";
    organization.rejectReason = "";
    organization.reviewedBy = null;
    organization.reviewedAt = null;
    organization.updatedAt = now();
    db.organizationDocuments.push(document);
    organization.currentDocumentId = document.id;
    await writeDb(db);
    return { organization, document };
  } catch (error) {
    const cleanupResult = await cleanup(stored, removePrivateFile);
    await journalCleanup(rollbackDb, stored, cleanupResult, writeDb, makeId, now);
    if (error?.code === "23505") throw new OrganizationError(409, "统一社会信用代码已注册");
    throw error;
  }
}

function cleanupPathIsReferenced(db, filePath) {
  const referencedByDocument = (db.organizationDocuments || []).some((document) => {
    if (document.filePath !== filePath) return false;
    const organization = (db.organizations || []).find((row) => row.id === document.organizationId);
    return !document.cleanedAt || organization?.currentDocumentId === document.id;
  });
  return referencedByDocument || (db.certificates || []).some((row) => row.filePath === filePath);
}

export async function replayFileCleanupJournal({ store, removePrivateFile = deletePrivateFile, now = () => new Date().toISOString() }) {
  return store.withMutationLock(async () => {
    const db = await store.readDb();
    const markers = [...(db.fileCleanupJournal || [])];
    if (!markers.length) return { removed: 0, retained: 0 };
    let changed = false;
    let removed = 0;
    let retained = 0;

    for (const marker of markers) {
      if (cleanupPathIsReferenced(db, marker.filePath)) {
        retained += 1;
        continue;
      }
      try {
        await removePrivateFile(marker);
        db.fileCleanupJournal = db.fileCleanupJournal.filter((row) => row.id !== marker.id);
        removed += 1;
        changed = true;
      } catch (error) {
        if (error?.code === "ENOENT") {
          db.fileCleanupJournal = db.fileCleanupJournal.filter((row) => row.id !== marker.id);
          removed += 1;
        } else {
          marker.attempts = Number(marker.attempts || 0) + 1;
          marker.lastError = String(error?.message || error);
          marker.lastAttemptAt = now();
          retained += 1;
        }
        changed = true;
      }
    }
    if (changed) await store.writeDb(db);
    return { removed, retained };
  });
}
