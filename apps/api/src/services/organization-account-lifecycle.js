import { recordAudit } from "./audit.js";
import { OrganizationError } from "./organizations.js";

function timestamp(now) {
  const value = now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function uniquePendingCleanupFiles(db, organizationId, removableAssets) {
  const known = new Set((db.fileCleanupJournal || []).map((row) => row.filePath));
  const paths = [];
  for (const document of db.organizationDocuments || []) {
    if (document.organizationId !== organizationId || document.cleanedAt || !document.filePath) continue;
    if (known.has(document.filePath)) continue;
    known.add(document.filePath);
    paths.push(document.filePath);
  }
  for (const asset of removableAssets) {
    if (asset.cleanedAt || !asset.filePath || known.has(asset.filePath)) continue;
    known.add(asset.filePath);
    paths.push(asset.filePath);
  }
  return paths;
}

export function organizationHistoryFields(registration) {
  const organizationSnapshot = String(registration?.organization || "").trim();
  const organizationDeleted = registration?.organizationDeleted === true;
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
  const retainedRegistrationIds = new Set((db.registrations || []).map((row) => row.id));
  const ownedSessionIds = new Set((db.registrationUploadSessions || [])
    .filter((row) => row.ownerUserId === owner.id || row.organizationId === organization.id)
    .map((row) => row.id));
  const preservedAssets = (db.registrationSubmissionAssets || []).filter((row) => (
    retainedRegistrationIds.has(row.registrationId)
  ));
  const preservedAssetIds = new Set(preservedAssets.map((row) => row.id));
  const preservedSessionIds = new Set(preservedAssets.map((row) => row.uploadSessionId));
  const removableAssets = (db.registrationSubmissionAssets || []).filter((row) => (
    (ownedSessionIds.has(row.uploadSessionId) || row.uploadedByUserId === owner.id)
    && !preservedAssetIds.has(row.id)
  ));
  const removableAssetIds = new Set(removableAssets.map((row) => row.id));
  const cleanupPaths = uniquePendingCleanupFiles(db, organization.id, removableAssets);
  db.fileCleanupJournal ||= [];
  for (const filePath of cleanupPaths) {
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
      registration.organizationDeleted = true;
    }
    if (registration.createdByUserId === owner.id) registration.createdByUserId = null;
    if (registration.personalUserId === owner.id) registration.personalUserId = null;
  }

  db.registrationSubmissionAssets = (db.registrationSubmissionAssets || []).filter((row) => !removableAssetIds.has(row.id));
  for (const asset of db.registrationSubmissionAssets) {
    if (asset.uploadedByUserId === owner.id) asset.uploadedByUserId = null;
  }
  db.registrationUploadSessions = (db.registrationUploadSessions || []).filter((row) => (
    !ownedSessionIds.has(row.id) || preservedSessionIds.has(row.id)
  ));
  for (const session of db.registrationUploadSessions) {
    if (session.ownerUserId === owner.id) session.ownerUserId = null;
    if (session.organizationId === organization.id) session.organizationId = null;
  }
  for (const batch of db.certificateImportBatches || []) {
    if (batch.createdBy === owner.id) batch.createdBy = null;
  }
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
    queuedFileCount: cleanupPaths.length
  };
}
