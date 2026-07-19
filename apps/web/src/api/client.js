const API_BASE = import.meta.env.VITE_API_URL || "";

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function fetchJson(path, { signal } = {}) {
  const response = await fetch(`${API_BASE}${path}`, { signal });
  const body = await response.text();
  let payload = null;

  if (body.trim()) {
    try {
      payload = JSON.parse(body);
    } catch {
      if (response.ok) {
        throw new ApiError("服务器返回了无效的 JSON", { status: response.status });
      }
    }
  }

  if (!response.ok) {
    throw new ApiError(payload?.message || `请求失败（${response.status}）`, {
      status: response.status,
      code: payload?.code,
      details: payload?.details
    });
  }

  return payload;
}
