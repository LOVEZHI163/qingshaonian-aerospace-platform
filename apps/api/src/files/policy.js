import { fileTypeFromBuffer } from "file-type";

export const CREDENTIAL_POLICY = {
  extensions: new Set(["png", "jpg", "jpeg", "pdf"]),
  mimeTypes: new Set(["image/png", "image/jpeg", "application/pdf"]),
  maxBytes: 10 * 1024 * 1024
};

export const ORGANIZATION_LEADER_DOCUMENT_POLICY = CREDENTIAL_POLICY;

export const CERTIFICATE_POLICY = {
  extensions: new Set(["pdf", "png", "jpg", "jpeg", "webp"]),
  mimeTypes: new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]),
  maxBytes: 10 * 1024 * 1024
};

export const SITE_IMAGE_POLICY = {
  extensions: new Set(["png", "jpg", "jpeg", "webp"]),
  mimeTypes: new Set(["image/png", "image/jpeg", "image/webp"]),
  maxBytes: 10 * 1024 * 1024
};

export const SITE_ATTACHMENT_POLICY = {
  extensions: new Set(["pdf", "png", "jpg", "jpeg", "webp"]),
  mimeTypes: new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]),
  maxBytes: 20 * 1024 * 1024
};

export const SUBMISSION_IMAGE_POLICY = {
  mimeTypes: new Set(["image/png", "image/jpeg"]),
  maxBytes: 2 * 1024 * 1024
};

export const SUBMISSION_VIDEO_POLICY = {
  mimeTypes: new Set(["video/mp4"]),
  maxBytes: 200 * 1024 * 1024,
  maxDurationMs: 120_000
};

export async function validateUpload(file, policy = CREDENTIAL_POLICY) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new Error("A non-empty file buffer is required");
  }
  if (file.buffer.length > policy.maxBytes) {
    throw new Error(`File exceeds the ${policy.maxBytes} byte limit`);
  }

  const detected = await fileTypeFromBuffer(file.buffer);
  const hasPdfHeader = file.buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (!detected || !policy.extensions.has(detected.ext) || !policy.mimeTypes.has(detected.mime)) {
    throw new Error("Unsupported file signature");
  }
  if (detected.mime === "application/pdf" && !hasPdfHeader) {
    throw new Error("Invalid PDF signature");
  }
  return detected;
}
