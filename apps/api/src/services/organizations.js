import { deletePrivateFile, savePrivateFile } from "../files/storage.js";
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
let organizationMutation = Promise.resolve();

function coordinateOrganizationMutation(operation) {
  const result = organizationMutation.then(operation, operation);
  organizationMutation = result.catch(() => {});
  return result;
}

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
  try {
    await removePrivateFile(file);
  } catch {
    // The original persistence error is more useful to callers; cleanup is best effort.
  }
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

export function registerOrganization(input) {
  return coordinateOrganizationMutation(() => registerOrganizationMutation(input));
}

async function registerOrganizationMutation({ input, file, readDb, writeDb, hashPassword, validatePassword, makeId, now, saveFile = savePrivateFile, removePrivateFile = deletePrivateFile }) {
  const values = validateCredentialInput(input, file);
  const passwordError = validatePassword(values.password);
  if (passwordError) throw validationError(passwordError);
  await validateCredentialFile(file);
  const db = await readDb();
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
    await cleanup(stored, removePrivateFile);
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
  const hasCredential = documents.some((document) =>
    document.organizationId === organization.id
    && !document.cleanedAt
    && DOCUMENT_TYPES.has(document.documentType)
    && String(document.filePath || "").trim()
    && String(document.storedName || "").trim()
  );
  if (!hasCredential) throw validationError("组织缺少有效资质文件");
}

export function resubmitOrganization(input) {
  return coordinateOrganizationMutation(() => resubmitOrganizationMutation(input));
}

async function resubmitOrganizationMutation({ input, file, userId, readDb, writeDb, makeId, now, saveFile = savePrivateFile, removePrivateFile = deletePrivateFile }) {
  const documentType = requiredText(input.documentType, "资质类型");
  if (!DOCUMENT_TYPES.has(documentType)) throw validationError("资质类型无效");
  if (!file) throw validationError("资质文件不能为空");
  await validateCredentialFile(file);
  const db = await readDb();
  const organization = db.organizations.find((row) => row.ownerUserId === userId);
  const owner = organization && db.memberships.some((row) => row.userId === userId && row.organizationId === organization.id && row.role === "owner" && row.status === "active");
  if (!organization || !owner) throw new OrganizationError(403, "只有组织负责人可以修改组织资料");
  if (organization.reviewStatus !== "rejected") throw validationError("只有被驳回的组织可以重新提交");
  const organizationName = requiredText(input.organizationName || organization.name, "组织名称");
  const creditCode = requiredText(input.creditCode || organization.creditCode, "统一社会信用代码");
  if (db.organizations.some((row) => row.id !== organization.id && row.creditCode === creditCode)) throw new OrganizationError(409, "统一社会信用代码已注册");

  let stored;
  try {
    stored = await saveFile({ category: "organization-documents", ownerId: organization.id, file });
    const oldDocuments = db.organizationDocuments.filter((row) => row.organizationId === organization.id && !row.cleanedAt);
    const document = documentRecord({ makeId, organizationId: organization.id, documentType, stored, now });
    organization.name = organizationName;
    organization.creditCode = creditCode;
    organization.code = `ORG-${creditCode}`;
    organization.reviewStatus = "pending";
    organization.rejectReason = "";
    organization.reviewedBy = null;
    organization.reviewedAt = null;
    organization.updatedAt = now();
    db.organizationDocuments = db.organizationDocuments.filter((row) => row.organizationId !== organization.id);
    db.organizationDocuments.push(document);
    await writeDb(db);
    await Promise.all(oldDocuments.map((oldDocument) => cleanup(oldDocument, removePrivateFile)));
    return { organization, document };
  } catch (error) {
    await cleanup(stored, removePrivateFile);
    throw error;
  }
}
