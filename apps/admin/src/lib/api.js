const API_BASE = import.meta.env.VITE_API_URL || "";

let unauthorizedHandler = null;
let passwordChangeRequiredHandler = null;

export class ApiError extends Error {
  constructor(message, { status, code, payload } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code || "";
    this.payload = payload || {};
  }
}

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = typeof handler === "function" ? handler : null;
}

export function setPasswordChangeRequiredHandler(handler) {
  passwordChangeRequiredHandler = typeof handler === "function" ? handler : null;
}

async function readPayload(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const text = await response.text().catch(() => "");
  if (!text) return { payload: {}, responseKind: "empty" };
  if (contentType.includes("application/json")) {
    try { return { payload: JSON.parse(text), responseKind: "json" }; }
    catch { return { payload: {}, responseKind: "invalid-json" }; }
  }
  return { payload: {}, responseKind: contentType.includes("text/html") ? "html" : "text" };
}

function apiFailure(response, parsed) {
  const payload = parsed.payload || {};
  const code = payload.code || "";
  const passwordChangeRequired = response.status === 428 || code === "PASSWORD_CHANGE_REQUIRED";
  if (passwordChangeRequired) passwordChangeRequiredHandler?.();
  else if (response.status === 401) unauthorizedHandler?.();
  const message = parsed.responseKind === "json"
    ? payload.error || payload.message || payload.errors?.join("\uff0c") || `\u8bf7\u6c42\u5931\u8d25 (${response.status})`
    : `服务暂时不可用，请刷新后重试 (${response.status})`;
  return new ApiError(message, { status: response.status, code, payload });
}

function safeDownloadFileName(value) {
  const name = String(value || "").trim();
  if (!name || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name)) return "";
  return name.slice(0, 255);
}

export function filenameFromContentDisposition(value) {
  const header = String(value || "");
  const encoded = header.match(/(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i);
  const encodedValue = (encoded?.[1] ?? encoded?.[2] ?? "").trim();
  if (encodedValue) {
    const match = encodedValue.match(/^utf-8''(.+)$/i);
    if (match) {
      try {
        const fileName = safeDownloadFileName(decodeURIComponent(match[1]));
        if (fileName) return fileName;
      } catch { /* fall through to the ASCII value */ }
    }
  }
  const fallback = header.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i);
  return safeDownloadFileName((fallback?.[1] ?? fallback?.[2] ?? "").trim()) || undefined;
}

export async function api(path, options = {}) {
  const formData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = formData ? { ...(options.headers || {}) } : { "Content-Type": "application/json", ...(options.headers || {}) };
  const response = await fetch(`${API_BASE}${path}`, { ...options, credentials: "include", headers });
  const parsed = await readPayload(response);
  if (!response.ok) throw apiFailure(response, parsed);
  return parsed.payload;
}

export async function apiBlob(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, { ...options, credentials: "include" });
  if (!response.ok) throw apiFailure(response, await readPayload(response));
  const blob = await response.blob();
  const fileName = filenameFromContentDisposition(response.headers.get("content-disposition"));
  if (fileName) Object.defineProperty(blob, "fileName", { value: fileName });
  return blob;
}

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}
