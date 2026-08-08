import { ApiError } from "./api.js";

const CHINESE_TEXT = /[\u3400-\u9fff]/u;

export function userFacingError(cause, fallback) {
  const message = String(cause?.message || "").trim();
  return cause instanceof ApiError && CHINESE_TEXT.test(message) ? message : fallback;
}
