import { ApiError } from "./api.js";

const SAFE_FAILURE = (status) => `服务暂时不可用，请刷新后重试 (${status})`;

function parseResponse(xhr) {
  const contentType = String(xhr.getResponseHeader?.("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json") && !contentType.includes("+json")) {
    return { payload: {}, responseKind: "non-json" };
  }
  const text = String(xhr.responseText || "");
  if (!text) return { payload: {}, responseKind: "json" };
  try {
    return { payload: JSON.parse(text), responseKind: "json" };
  } catch {
    return { payload: {}, responseKind: "invalid-json" };
  }
}

function uploadFailure(xhr, parsed) {
  const payload = parsed.payload || {};
  const message = parsed.responseKind === "json"
    ? payload.error || payload.message || payload.errors?.join("，") || `请求失败 (${xhr.status})`
    : SAFE_FAILURE(xhr.status);
  return new ApiError(message, { status: xhr.status, code: payload.code || "", payload });
}

function abortError() {
  return new DOMException("上传已取消", "AbortError");
}

/**
 * Upload one submission asset with browser-native progress events.
 * The File remains only in this call frame and is never retained in application state.
 */
export function uploadFile(path, file, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const removeAbortListener = () => signal?.removeEventListener?.("abort", abort);
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      callback(value);
    };
    const abort = () => {
      xhr.abort();
      settle(reject, abortError());
    };

    xhr.open("PUT", path);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !event.total) return;
      onProgress?.({
        loaded: event.loaded,
        total: event.total,
        percent: Math.round((event.loaded / event.total) * 100)
      });
    };
    xhr.onload = () => {
      const parsed = parseResponse(xhr);
      if (xhr.status >= 200 && xhr.status < 300) settle(resolve, parsed.payload);
      else settle(reject, uploadFailure(xhr, parsed));
    };
    xhr.onerror = () => settle(reject, new ApiError(SAFE_FAILURE(xhr.status || 0), { status: xhr.status || 0 }));
    xhr.onabort = () => settle(reject, abortError());

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener?.("abort", abort, { once: true });
    const body = new FormData();
    body.append("file", file);
    xhr.send(body);
  });
}
