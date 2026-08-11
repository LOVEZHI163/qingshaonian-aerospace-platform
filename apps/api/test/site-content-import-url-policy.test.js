import assert from "node:assert/strict";
import test from "node:test";

import {
  isPublicAddress,
  normalizeImportUrl,
  resolvePublicImportTarget,
  sourceUrlFingerprint
} from "../src/services/site-content-import/url-policy.js";

test("normalizes equivalent public article urls before duplicate checks", () => {
  const normalized = normalizeImportUrl(" HTTPS://Example.COM:443/news?id=2&utm_source=feed&a=1&spm=abc#section ");

  assert.equal(normalized, "https://example.com/news?a=1&id=2");
  assert.equal(
    sourceUrlFingerprint(normalized),
    "54a2fe4d6ce3d3aa82d3739df0aa07755d99bc8cbc157bb025ba55d11cec8cb4"
  );
  assert.equal(
    sourceUrlFingerprint(normalizeImportUrl("https://EXAMPLE.com/news?id=2&a=1")),
    "54a2fe4d6ce3d3aa82d3739df0aa07755d99bc8cbc157bb025ba55d11cec8cb4"
  );
});

test("rejects urls that cannot be fetched as ordinary public web pages", () => {
  const invalidUrls = [
    "",
    "not a url",
    "ftp://example.com/article",
    "https://user:password@example.com/article",
    "https://example.com:8443/article",
    "file:///etc/passwd"
  ];

  for (const value of invalidUrls) {
    assert.throws(
      () => normalizeImportUrl(value),
      (error) => error?.status === 422 && error?.code === "IMPORT_URL_INVALID",
      value
    );
  }
});

test("classifies only globally routable ipv4 and ipv6 addresses as public", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicAddress(address), true, address);
  }

  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "2001:db8::1", "invalid"
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("resolves all dns answers and pins a validated address", async () => {
  const calls = [];
  const lookup = async (hostname, options) => {
    calls.push({ hostname, options });
    return [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }
    ];
  };

  const target = await resolvePublicImportTarget("https://example.com/article", { lookup });

  assert.deepEqual(calls, [{ hostname: "example.com", options: { all: true, verbatim: true } }]);
  assert.equal(target.url.href, "https://example.com/article");
  assert.equal(target.hostname, "example.com");
  assert.deepEqual(target.addresses, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }
  ]);
  assert.deepEqual(target.selectedAddress, { address: "93.184.216.34", family: 4 });
});

test("rejects the whole hostname when any dns answer is not public", async () => {
  const lookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 }
  ];

  await assert.rejects(
    resolvePublicImportTarget("https://example.com/article", { lookup }),
    (error) => error?.status === 422 && error?.code === "IMPORT_URL_BLOCKED"
  );
});

test("validates literal ip hosts without resolving them again", async () => {
  let lookupCalls = 0;
  const lookup = async () => {
    lookupCalls += 1;
    return [];
  };

  const publicTarget = await resolvePublicImportTarget("https://93.184.216.34/article", { lookup });
  assert.equal(lookupCalls, 0);
  assert.deepEqual(publicTarget.selectedAddress, { address: "93.184.216.34", family: 4 });

  await assert.rejects(
    resolvePublicImportTarget("http://127.0.0.1/article", { lookup }),
    (error) => error?.code === "IMPORT_URL_BLOCKED"
  );
  assert.equal(lookupCalls, 0);
});

test("rejects missing and malformed dns results instead of falling back to system resolution", async () => {
  for (const answers of [[], [{ address: "not-an-ip", family: 4 }]]) {
    await assert.rejects(
      resolvePublicImportTarget("https://example.com/article", { lookup: async () => answers }),
      (error) => error?.status === 422 && error?.code === "IMPORT_URL_BLOCKED"
    );
  }
});
