import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const TRACKING_QUERY_PARAM = /^(?:utm_[a-z0-9_]+|spm|from|from_source|share_source|share_medium|scene|clicktime|enterid)$/i;

function policyError(message, code) {
  return Object.assign(new Error(message), { status: 422, code });
}

function importUrlInvalid() {
  return policyError("请输入有效的公开网页链接", "IMPORT_URL_INVALID");
}

function importUrlBlocked() {
  return policyError("该地址不是可访问的公开网页", "IMPORT_URL_BLOCKED");
}

export function normalizeImportUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? "").trim());
  } catch {
    throw importUrlInvalid();
  }

  if (!["http:", "https:"].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || (url.port && !["80", "443"].includes(url.port))) {
    throw importUrlInvalid();
  }

  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_QUERY_PARAM.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

export function sourceUrlFingerprint(normalizedUrl) {
  return createHash("sha256").update(String(normalizedUrl)).digest("hex");
}

function ipv4Number(address) {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = (value * 256) + byte;
  }
  return value >>> 0;
}

function inIpv4Range(value, base, bits) {
  const baseValue = ipv4Number(base);
  const size = 2 ** (32 - bits);
  return value >= baseValue && value < baseValue + size;
}

function isPublicIpv4(address) {
  const value = ipv4Number(address);
  if (value === null) return false;
  return ![
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ].some(([base, bits]) => inIpv4Range(value, base, bits));
}

function ipv6Segments(address) {
  let input = String(address).toLowerCase();
  const zoneIndex = input.indexOf("%");
  if (zoneIndex >= 0) input = input.slice(0, zoneIndex);

  if (input.includes(".")) {
    const separator = input.lastIndexOf(":");
    const embedded = ipv4Number(input.slice(separator + 1));
    if (separator < 0 || embedded === null) return null;
    input = `${input.slice(0, separator)}:${((embedded >>> 16) & 0xffff).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }

  if ((input.match(/::/g) || []).length > 1) return null;
  const [leftText, rightText = ""] = input.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((input.includes("::") && missing < 1) || (!input.includes("::") && missing !== 0)) return null;
  const segments = [...left, ...Array(missing).fill("0"), ...right];
  if (segments.length !== 8 || segments.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return segments.map((part) => Number.parseInt(part, 16));
}

function embeddedIpv4FromIpv6(segments) {
  if (segments.slice(0, 5).some((part) => part !== 0) || segments[5] !== 0xffff) return null;
  return `${segments[6] >>> 8}.${segments[6] & 255}.${segments[7] >>> 8}.${segments[7] & 255}`;
}

function isPublicIpv6(address) {
  const segments = ipv6Segments(address);
  if (!segments) return false;
  const embeddedIpv4 = embeddedIpv4FromIpv6(segments);
  if (embeddedIpv4) return isPublicIpv4(embeddedIpv4);

  if (segments[0] < 0x2000 || segments[0] > 0x3fff) return false;
  if (segments[0] === 0x2001 && segments[1] === 0x0) return false;
  if (segments[0] === 0x2001 && segments[1] === 0x0db8) return false;
  if (segments[0] === 0x2001 && segments[1] >= 0x10 && segments[1] <= 0x1f) return false;
  if (segments[0] === 0x2002) return false;
  return true;
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function literalHostname(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export async function resolvePublicImportTarget(rawUrl, { lookup = dnsLookup } = {}) {
  const url = new URL(normalizeImportUrl(rawUrl));
  const hostname = literalHostname(url.hostname);
  const literalFamily = isIP(hostname);
  let addresses;

  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      const result = await lookup(hostname, { all: true, verbatim: true });
      addresses = Array.isArray(result) ? result : [result];
    } catch {
      throw importUrlBlocked();
    }
  }

  const normalizedAddresses = addresses.map((entry) => ({
    address: String(entry?.address || ""),
    family: Number(entry?.family)
  }));
  if (!normalizedAddresses.length || normalizedAddresses.some((entry) => {
    const actualFamily = isIP(entry.address);
    return !actualFamily || actualFamily !== entry.family || !isPublicAddress(entry.address);
  })) {
    throw importUrlBlocked();
  }

  return {
    url,
    hostname,
    addresses: normalizedAddresses,
    selectedAddress: normalizedAddresses[0]
  };
}
