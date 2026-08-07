import crypto from "node:crypto";

const PHONE_NUMBER = /(?<!\d)1\d{10}(?!\d)/g;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'`,;:{}()[\]]+/g;
const UNIX_PATH = /(^|[\s="'(:,])\/(?:[^\s"'`,;:{}()[\]]+\/)+[^\s"'`,;:{}()[\]]*/g;
const RELATIVE_UPLOAD_PATH = /(^|[\s="'(:,])uploads[\\/][^\s"'`,;:{}()[\]]+/gi;
const IDENTITY_NUMBER = /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/g;
const SECRET_VALUE = /(["']?)(password|passwd|session(?:[_-]?id)?|secret|token|authorization|aerogp\.sid|student[_-]?id[_-]?number|identity[_-]?number|id[_-]?card[_-]?number)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;
const PERCENT_ENCODED_TEXT = /%(?:[0-9A-Fa-f]{2})+/g;
const MAX_PERCENT_DECODING_PASSES = 4;

function decodePercentEncodedText(value) {
  let decoded = value;
  for (let pass = 0; pass < MAX_PERCENT_DECODING_PASSES; pass += 1) {
    const next = decoded.replace(PERCENT_ENCODED_TEXT, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.replace(PERCENT_ENCODED_TEXT, "[已隐藏编码]");
}

function sanitizeAuditText(value, maximumLength) {
  return decodePercentEncodedText(String(value || ""))
    .replace(PHONE_NUMBER, (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`)
    .replace(IDENTITY_NUMBER, "[身份证号已隐藏]")
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
