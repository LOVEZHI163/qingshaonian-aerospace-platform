import fs from "node:fs/promises";

import { resolveImportStagingPath, deletePrivateFile } from "../files/storage.js";
import { recordAudit } from "./audit.js";
import { businessError } from "./events.js";

const CLEANUP_CATEGORIES = new Set(["certificates", "imports"]);

function timestamp(now) {
  const value = now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function eventOrThrow(db, eventId) {
  const event = db.events.find((row) => row.id === eventId);
  if (!event) throw businessError(404, "赛事不存在");
  return event;
}

function organizationOrThrow(db, organizationId) {
  const organization = db.organizations.find((row) => row.id === organizationId);
  if (!organization) throw businessError(404, "组织不存在");
  return organization;
}

function importFilesForBatch(batch) {
  return (batch.previewJson || []).flatMap((candidate) => (candidate.certificates || []).map((certificate) => ({
    category: "certificate-import-staging",
    filePath: resolveImportStagingPath(batch.id, certificate.relativePath),
    label: `${batch.originalName || batch.id} · 第 ${candidate.rowNumber} 行 · 证书 ${certificate.slot}`
  })));
}

function eventResources(db, eventId, categories = CLEANUP_CATEGORIES) {
  const registrationIds = new Set(db.registrations.filter((row) => row.eventId === eventId).map((row) => row.id));
  const certificateRecords = categories.has("certificates")
    ? db.certificates.filter((row) => registrationIds.has(row.registrationId) && !row.cleanedAt)
    : [];
  const certificateFiles = certificateRecords.filter((row) => row.filePath);
  const batches = categories.has("imports")
    ? db.certificateImportBatches.filter((row) => row.eventId === eventId)
    : [];
  return {
    certificateRecords,
    certificateFiles,
    batches,
    files: [
      ...certificateFiles.map((row) => ({ category: "event-certificate", filePath: row.filePath, label: row.fileName || row.title || row.id })),
      ...batches.flatMap(importFilesForBatch)
    ]
  };
}

async function byteSize(file, statFile) {
  try {
    return Number((await statFile(file.filePath)).size || 0);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

export async function summarizeEventStorage(db, eventId, { statFile = fs.stat } = {}) {
  eventOrThrow(db, eventId);
  const resources = eventResources(db, eventId);
  const sizes = await Promise.all(resources.files.map((file) => byteSize(file, statFile)));
  return {
    certificateFiles: resources.certificateFiles.length,
    importFiles: resources.files.length - resources.certificateFiles.length,
    totalBytes: sizes.reduce((sum, value) => sum + value, 0)
  };
}

function normalizeCategories(value) {
  if (!Array.isArray(value) || value.length === 0) throw businessError(422, "请选择要清理的附件类型");
  const categories = new Set(value.map((item) => String(item)));
  if ([...categories].some((item) => !CLEANUP_CATEGORIES.has(item))) throw businessError(422, "附件清理类型无效");
  return categories;
}

function markerFor(file, { makeId, createdAt }) {
  return {
    id: makeId("FC"),
    filePath: file.filePath,
    category: file.category,
    attempts: 0,
    lastError: "pending cleanup",
    createdAt,
    lastAttemptAt: createdAt
  };
}

async function removePhysicalFiles({ store, db, entries, removeFile, now, onFailures }) {
  const failedFiles = [];
  const completedIds = new Set();
  const attemptedAt = timestamp(now);
  for (const entry of entries) {
    try {
      await removeFile(entry.marker);
      completedIds.add(entry.marker.id);
    } catch (error) {
      if (error?.code === "ENOENT") {
        completedIds.add(entry.marker.id);
        continue;
      }
      entry.marker.attempts = Number(entry.marker.attempts || 0) + 1;
      entry.marker.lastError = String(error?.message || error).slice(0, 500);
      entry.marker.lastAttemptAt = attemptedAt;
      failedFiles.push({ category: entry.file.category, name: entry.file.label });
    }
  }
  db.fileCleanupJournal = (db.fileCleanupJournal || []).filter((row) => !completedIds.has(row.id));
  if (failedFiles.length) onFailures?.(failedFiles);
  await store.writeDb(db);
  return { failedFiles, deletedFiles: entries.length - failedFiles.length };
}

function stageCleanupFiles(db, files, dependencies, scopeCategory) {
  db.fileCleanupJournal ||= [];
  const createdAt = timestamp(dependencies.now);
  const entries = db.fileCleanupJournal
    .filter((marker) => marker.category === scopeCategory)
    .map((marker) => ({ file: { category: scopeCategory, filePath: marker.filePath, label: "待重试附件" }, marker }));
  const knownPaths = new Set(entries.map((entry) => entry.marker.filePath));
  for (const file of files) {
    if (knownPaths.has(file.filePath)) continue;
    const marker = markerFor({ ...file, category: scopeCategory }, { makeId: dependencies.makeId, createdAt });
    db.fileCleanupJournal.push(marker);
    entries.push({ file, marker });
  }
  return entries;
}

export async function cleanupArchivedEventResources({ store, eventId, categories: categoryInput, actor, makeId, now = () => new Date().toISOString(), statFile = fs.stat, removeFile = deletePrivateFile }) {
  const db = await store.readDb();
  const event = eventOrThrow(db, eventId);
  if (event.status !== "archived") throw businessError(409, "只有已归档赛事可以清理附件");
  const categories = normalizeCategories(categoryInput);
  const resources = eventResources(db, eventId, categories);
  const sizes = await Promise.all(resources.files.map((file) => byteSize(file, statFile)));
  const summary = {
    certificateFiles: resources.certificateFiles.length,
    importFiles: resources.files.length - resources.certificateFiles.length,
    totalBytes: sizes.reduce((sum, value) => sum + value, 0)
  };
  const cleanedAt = timestamp(now);
  for (const certificate of resources.certificateRecords) {
    certificate.cleanedAt = cleanedAt;
    certificate.filePath = "";
    certificate.storedName = "";
  }
  for (const batch of resources.batches) {
    batch.previewJson = [];
    if (batch.status === "preview") batch.status = "cancelled";
  }
  const entries = stageCleanupFiles(db, resources.files, { makeId, now }, `event-resource:${event.id}`);
  recordAudit(db, { actor, action: "event.resource-cleanup", targetType: "event", targetId: event.id, summary: `${event.name} 清理归档附件 ${resources.files.length} 个`, createdAt: cleanedAt });
  await store.writeDb(db);
  const physical = await removePhysicalFiles({
    store, db, entries, removeFile, now,
    onFailures: (failedFiles) => recordAudit(db, {
      actor,
      action: "event.resource-cleanup-failed",
      targetType: "event",
      targetId: event.id,
      summary: `${event.name} 有 ${failedFiles.length} 个附件物理删除失败，已加入重试队列`,
      createdAt: timestamp(now)
    })
  });
  return { ...summary, ...physical };
}

export async function cleanupOrganizationCredentials({ store, organizationId, confirmName, actor, makeId, now = () => new Date().toISOString(), removeFile = deletePrivateFile }) {
  const db = await store.readDb();
  const organization = organizationOrThrow(db, organizationId);
  if (organization.status !== "disabled") throw businessError(409, "只有已停用组织可以清理资质");
  if (String(confirmName || "") !== organization.name) throw businessError(422, "组织名称确认不一致");
  const documents = db.organizationDocuments.filter((row) => row.organizationId === organization.id && !row.cleanedAt);
  const files = documents.filter((row) => row.filePath).map((row) => ({ category: "organization-credential", filePath: row.filePath, label: row.originalName || row.id }));
  const cleanedAt = timestamp(now);
  for (const document of documents) {
    document.cleanedAt = cleanedAt;
    document.filePath = "";
    document.storedName = "";
  }
  organization.currentDocumentId = null;
  organization.reviewStatus = "pending";
  organization.reviewedBy = null;
  organization.reviewedAt = null;
  organization.updatedAt = cleanedAt;
  const entries = stageCleanupFiles(db, files, { makeId, now }, `organization-credential:${organization.id}`);
  recordAudit(db, { actor, action: "organization.credential-cleanup", targetType: "organization", targetId: organization.id, summary: `${organization.name} 清理资质附件 ${files.length} 个`, createdAt: cleanedAt });
  await store.writeDb(db);
  return { organization, ...(await removePhysicalFiles({
    store, db, entries, removeFile, now,
    onFailures: (failedFiles) => recordAudit(db, {
      actor,
      action: "organization.credential-cleanup-failed",
      targetType: "organization",
      targetId: organization.id,
      summary: `${organization.name} 有 ${failedFiles.length} 个资质附件物理删除失败，已加入重试队列`,
      createdAt: timestamp(now)
    })
  })) };
}

export async function deleteArchivedEvent({ store, eventId, confirmName, actor, makeId, now = () => new Date().toISOString(), removeFile = deletePrivateFile }) {
  const db = await store.readDb();
  const event = eventOrThrow(db, eventId);
  if (event.isCurrent || event.status !== "archived") throw businessError(409, "只能彻底删除非当前的已归档赛事");
  if (String(confirmName || "") !== event.name) throw businessError(422, "赛事名称确认不一致");
  const resources = eventResources(db, eventId);
  const entries = stageCleanupFiles(db, resources.files, { makeId, now }, `event-delete:${event.id}`);
  const registrationIds = new Set(db.registrations.filter((row) => row.eventId === eventId).map((row) => row.id));
  const projectIds = new Set(db.projects.filter((row) => row.eventId === eventId).map((row) => row.id));
  const batchIds = new Set(db.certificateImportBatches.filter((row) => row.eventId === eventId).map((row) => row.id));
  db.certificateImportErrors = db.certificateImportErrors.filter((row) => !batchIds.has(row.batchId));
  db.certificates = db.certificates.filter((row) => !registrationIds.has(row.registrationId));
  db.registrations = db.registrations.filter((row) => row.eventId !== eventId);
  db.projectGroups = db.projectGroups.filter((row) => !projectIds.has(row.projectId));
  db.projects = db.projects.filter((row) => row.eventId !== eventId);
  db.certificateImportBatches = db.certificateImportBatches.filter((row) => row.eventId !== eventId);
  db.events = db.events.filter((row) => row.id !== eventId);
  const deletedAt = timestamp(now);
  recordAudit(db, { actor, action: "event.delete", targetType: "event", targetId: event.id, summary: `${event.name} 已彻底删除，附件 ${resources.files.length} 个`, createdAt: deletedAt });
  await store.writeDb(db);
  return { deletedEventId: event.id, ...(await removePhysicalFiles({
    store, db, entries, removeFile, now,
    onFailures: (failedFiles) => recordAudit(db, {
      actor,
      action: "event.delete-files-failed",
      targetType: "event",
      targetId: event.id,
      summary: `${event.name} 删除后有 ${failedFiles.length} 个附件物理删除失败，已加入重试队列`,
      createdAt: timestamp(now)
    })
  })) };
}
