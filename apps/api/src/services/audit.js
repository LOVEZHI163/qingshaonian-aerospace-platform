import crypto from "node:crypto";

const PHONE_NUMBER = /(?<!\d)1\d{10}(?!\d)/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\s,，;；]+/g;
const UNIX_PATH = /(?:^|\s)\/(?:[^\s,，;；/]+\/)+[^\s,，;；]*/g;
const SECRET_VALUE = /\b(password|session|secret|token)\s*[:=]\s*[^\s,，;；]+/gi;

export function sanitizeAuditSummary(value) {
  return String(value || "")
    .replace(PHONE_NUMBER, (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`)
    .replace(WINDOWS_PATH, "[文件路径]")
    .replace(UNIX_PATH, (path) => `${path.startsWith(" ") ? " " : ""}[文件路径]`)
    .replace(SECRET_VALUE, "$1=[已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
export function recordAudit(db, {
  actor,
  action,
  targetType,
  targetId,
  summary,
  createdAt = new Date().toISOString()
}) {
  db.auditLogs ||= [];
  const row = {
    id: `A${crypto.randomUUID()}`,
    actorUserId: actor?.id || null,
    actorName: String(actor?.name || "系统").trim() || "系统",
    action: String(action || "").trim(),
    targetType: String(targetType || "").trim(),
    targetId: String(targetId || "").trim(),
    summary: sanitizeAuditSummary(summary),
    createdAt: new Date(createdAt).toISOString()
  };
  if (!row.action || !row.targetType || !row.targetId || !row.summary) {
    throw new TypeError("审计日志的操作、对象和摘要不能为空");
  }
  db.auditLogs.unshift(row);
  return row;
}
