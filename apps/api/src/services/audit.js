import crypto from "node:crypto";

const PHONE_NUMBER = /(?<!\d)1\d{10}(?!\d)/g;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'`,;:{}()[\]]+/g;
const UNIX_PATH = /(^|[\s="'(:,])\/(?:[^\s"'`,;:{}()[\]]+\/)+[^\s"'`,;:{}()[\]]*/g;
const RELATIVE_UPLOAD_PATH = /(^|[\s="'(:,])uploads[\\/][^\s"'`,;:{}()[\]]+/gi;
const SECRET_VALUE = /(["']?)(password|passwd|session(?:[_-]?id)?|secret|token|authorization|aerogp\.sid)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;

function sanitizeAuditText(value, maximumLength) {
  return String(value || "")
    .replace(PHONE_NUMBER, (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`)
    .replace(SECRET_VALUE, (_match, quote, key) => `${quote}${key}${quote}=[已隐藏]`)
    .replace(WINDOWS_PATH, "[文件路径]")
    .replace(UNIX_PATH, (_path, prefix) => `${prefix}[文件路径]`)
    .replace(RELATIVE_UPLOAD_PATH, (_path, prefix) => `${prefix}[文件路径]`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}

export function sanitizeAuditSummary(value) {
  return sanitizeAuditText(value, 500);
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
    actorName: sanitizeAuditText(actor?.name || "系统", 120) || "系统",
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
