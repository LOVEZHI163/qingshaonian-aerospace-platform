const API_BASE = import.meta.env.VITE_API_URL || "";

let unauthorizedHandler = null;

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

async function readPayload(response) {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export async function api(path, options = {}) {
  const formData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = formData
    ? { ...(options.headers || {}) }
    : { "Content-Type": "application/json", ...(options.headers || {}) };
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    const code = payload.code || "";
    if (response.status === 401 && code !== "PASSWORD_CHANGE_REQUIRED") unauthorizedHandler?.();
    const message = payload.error || payload.message || payload.errors?.join("；") || `请求失败 (${response.status})`;
    throw new ApiError(message, { status: response.status, code, payload });
  }
  return payload;
}

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}
