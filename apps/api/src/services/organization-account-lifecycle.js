import { recordAudit } from "./audit.js";
import { OrganizationError } from "./organizations.js";

function timestamp(now) {
  const value = now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function uniquePendingCredentialFiles(db, organizationId) {
  const known = new Set((db.fileCleanupJournal || []).map((row) => row.filePath));
  const paths = [];
  for (const document of db.organizationDocuments || []) {
    if (document.organizationId !== organizationId || document.cleanedAt || !document.filePath) continue;
    if (known.has(document.filePath)) continue;
    known.add(document.filePath);
    paths.push(document.filePath);
  }
  return paths;
}

export function organizationHistoryFields(registration) {
  const organizationSnapshot = String(registration?.organization || "").trim();
  const organizationDeleted = Boolean(organizationSnapshot && !registration?.organizationId);
  return {
    organizationSnapshot,
    organizationDeleted,
    organization: organizationDeleted ? `${organizationSnapshot}（原组织已删除）` : organizationSnapshot
  };
}

export function deleteOrganizationAccount(db, {
  organizationId,
  actor,
  makeId,
  now = () => new Date().toISOString()
}) {
  if (actor?.type !== "admin") {
    throw new OrganizationError(403, "只有平台管理员可以删除组织账号");
  }
  const organization = (db.organizations || []).find((row) => row.id === organizationId);
  if (!organization) throw new OrganizationError(404, "组织不存在");
  const owner = (db.users || []).find((row) => row.id === organization.ownerUserId);
  if (!owner || owner.type !== "organization") {
    throw new OrganizationError(409, "组织负责人账号不存在或类型异常");
  }

  const deletedAt = timestamp(now);
  const credentialPaths = uniquePendingCredentialFiles(db, organization.id);
  db.fileCleanupJournal ||= [];
  for (const filePath of credentialPaths) {
    db.fileCleanupJournal.push({
      id: makeId("CLN"),
      filePath,
      category: "organization-deleted",
      attempts: 0,
      lastError: "pending cleanup",
      createdAt: deletedAt,
      lastAttemptAt: deletedAt
    });
  }

  let retainedRegistrationCount = 0;
  for (const registration of db.registrations || []) {
    if (registration.organizationId === organization.id) {
      retainedRegistrationCount += 1;
      registration.organization = String(registration.organization || organization.name).trim() || organization.name;
      registration.organizationId = null;
    }
    if (registration.createdByUserId === owner.id) registration.createdByUserId = null;
    if (registration.personalUserId === owner.id) registration.personalUserId = null;
  }

  const deletedSessionIds = new Set((db.registrationUploadSessions || [])
    .filter((row) => row.ownerUserId === owner.id || row.organizationId === organization.id)
    .map((row) => row.id));
  db.registrationSubmissionAssets = (db.registrationSubmissionAssets || []).filter((row) => (
    !deletedSessionIds.has(row.uploadSessionId) && row.uploadedByUserId !== owner.id
  ));
  db.registrationUploadSessions = (db.registrationUploadSessions || []).filter((row) => !deletedSessionIds.has(row.id));
  db.organizationEventParticipations = (db.organizationEventParticipations || []).filter((row) => row.organizationId !== organization.id);
  db.memberships = (db.memberships || []).filter((row) => row.organizationId !== organization.id && row.userId !== owner.id);
  db.organizationDocuments = (db.organizationDocuments || []).filter((row) => row.organizationId !== organization.id);
  db.organizations = (db.organizations || []).filter((row) => row.id !== organization.id);
  db.users = (db.users || []).filter((row) => row.id !== owner.id);

  recordAudit(db, {
    actor,
    action: "organization.delete",
    targetType: "organization",
    targetId: organization.id,
    summary: `${organization.name} 及负责人 ${owner.name} 已删除；历史报名、成绩和证书保留组织名称快照，共 ${retainedRegistrationCount} 条报名`,
    createdAt: deletedAt
  });

  return {
    ownerUserId: owner.id,
    organizationName: organization.name,
    retainedRegistrationCount,
    queuedFileCount: credentialPaths.length
  };
}
