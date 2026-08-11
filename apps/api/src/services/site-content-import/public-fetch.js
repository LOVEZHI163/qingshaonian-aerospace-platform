import http from "node:http";
import https from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { resolvePublicImportTarget } from "./url-policy.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const HTML_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function fetchError(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

function timeoutError() {
  return fetchError("抓取网页超时，请稍后重试", "IMPORT_FETCH_TIMEOUT", 504);
}

function blockedError() {
  return fetchError("无法访问该公开网页", "IMPORT_URL_BLOCKED", 422);
}

function tooLargeError() {
  return fetchError("网页或图片超过允许大小", "IMPORT_RESPONSE_TOO_LARGE", 413);
}

function unsupportedError() {
  return fetchError("链接返回的内容类型不受支持", "IMPORT_UNSUPPORTED_CONTENT", 422);
}

function contentType(headers) {
  return String(headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
}

function acceptsContentType(expected, headers) {
  const type = contentType(headers);
  return expected === "image" ? IMAGE_CONTENT_TYPES.has(type) : HTML_CONTENT_TYPES.has(type);
}

function decodedStream(response) {
  const encoding = String(response.headers["content-encoding"] || "").trim().toLowerCase();
  if (!encoding || encoding === "identity") return response;
  if (encoding === "gzip" || encoding === "x-gzip") return response.pipe(createGunzip());
  if (encoding === "deflate") return response.pipe(createInflate());
  if (encoding === "br") return response.pipe(createBrotliDecompress());
  throw unsupportedError();
}

function readBody(response, maxBytes) {
  return new Promise((resolve, reject) => {
    let stream;
    try {
      stream = decodedStream(response);
    } catch (error) {
      response.resume();
      reject(error);
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      action(value);
    };

    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy(tooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    stream.once("end", () => finish(resolve, Buffer.concat(chunks, size)));
    stream.once("error", (error) => finish(reject, error));
    response.once("aborted", () => finish(reject, blockedError()));
  });
}

function pinnedLookup(selectedAddress) {
  return (_hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (options?.all) {
      callback(null, [selectedAddress]);
      return;
    }
    callback(null, selectedAddress.address, selectedAddress.family);
  };
}

function requestTarget(target, { expected, maxBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http;
    let settled = false;
    let deadlineTimer;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      action(value);
    };

    const request = transport.request({
      protocol: target.url.protocol,
      hostname: target.hostname,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: "GET",
      servername: target.hostname,
      autoSelectFamily: false,
      lookup: pinnedLookup(target.selectedAddress),
      headers: {
        Accept: expected === "image"
          ? "image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.1"
          : "text/html,application/xhtml+xml;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Host: target.url.host,
        "User-Agent": "AerogpContentImporter/1.0"
      }
    }, async (response) => {
      try {
        const status = Number(response.statusCode || 0);
        if (REDIRECT_STATUS.has(status)) {
          response.resume();
          finish(resolve, { status, headers: response.headers, location: response.headers.location || "" });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          finish(reject, blockedError());
          return;
        }
        if (!acceptsContentType(expected, response.headers)) {
          response.resume();
          finish(reject, unsupportedError());
          return;
        }
        const buffer = await readBody(response, maxBytes);
        finish(resolve, { status, headers: response.headers, buffer });
      } catch (error) {
        finish(reject, error);
      }
    });

    deadlineTimer = setTimeout(() => request.destroy(timeoutError()), timeoutMs);
    request.once("error", (error) => {
      if (error?.code?.startsWith("IMPORT_")) finish(reject, error);
      else finish(reject, blockedError());
    });
    request.end();
  });
}

async function withinDeadline(operation, remainingMs) {
  if (remainingMs <= 0) throw timeoutError();
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), remainingMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPublicResource(rawUrl, {
  expected = "html",
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = 10_000,
  maxRedirects = 3,
  resolveTarget = resolvePublicImportTarget
} = {}) {
  if (!["html", "image"].includes(expected)) throw unsupportedError();
  const byteLimit = Number(maxBytes);
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1) throw tooLargeError();

  const deadline = Date.now() + timeoutMs;
  let currentUrl = String(rawUrl);
  let redirects = 0;

  while (true) {
    const target = await withinDeadline(Promise.resolve().then(() => resolveTarget(currentUrl)), deadline - Date.now());
    const response = await requestTarget(target, {
      expected,
      maxBytes: byteLimit,
      timeoutMs: deadline - Date.now()
    });

    if (!REDIRECT_STATUS.has(response.status)) {
      return {
        finalUrl: target.url.href,
        status: response.status,
        headers: response.headers,
        buffer: response.buffer
      };
    }

    if (!response.location || redirects >= maxRedirects) throw blockedError();
    currentUrl = new URL(response.location, target.url).href;
    redirects += 1;
  }
}
