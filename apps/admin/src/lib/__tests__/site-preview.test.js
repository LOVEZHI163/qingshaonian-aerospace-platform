import { describe, expect, it, vi } from "vitest";

import {
  PREVIEW_STORAGE_PREFIX,
  createPreviewSnapshot,
  cleanupPreviewSnapshots
} from "../site-preview.js";

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; }
  };
}

describe("site preview snapshots", () => {
  it("stores only a random-token keyed 15-minute envelope", () => {
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((bytes) => bytes.fill(7));
    const storage = memoryStorage();

    const result = createPreviewSnapshot({
      kind: "homepage",
      payload: { site: { platformName: "测试" } },
      context: {},
      now: 1_000,
      storage
    });

    expect(result.token).toBe("07".repeat(24));
    expect(result.expiresAt).toBe(901_000);
    expect(result.url).toBe(`/preview?token=${encodeURIComponent(result.token)}`);
    expect(storage.getItem(`${PREVIEW_STORAGE_PREFIX}${result.token}`)).toBe(JSON.stringify({
      version: 1,
      token: result.token,
      kind: "homepage",
      createdAt: 1_000,
      expiresAt: 901_000,
      adminReturnPath: "/admin/",
      payload: { site: { platformName: "测试" } },
      context: {}
    }));
  });

  it("stores only preview-safe allowlisted fields and never contact phone numbers", () => {
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((bytes) => bytes.fill(8));
    const storage = memoryStorage();

    const result = createPreviewSnapshot({
      kind: "homepage",
      payload: {
        site: {
          platformName: "测试",
          contact: "0577-76543210",
          privateDraftNote: "仅管理员可见"
        },
        featuredEvent: {
          id: "E1",
          slug: "event-one",
          name: "赛事一",
          contact: "13900000000",
          organizerMobile: "13800000001"
        },
        internalEnvelope: {
          password: "secret",
          sessionToken: "token-value"
        }
      },
      context: {
        eventId: "E1",
        contentId: null,
        actorPhone: "13700000002"
      },
      now: 1_000,
      storage
    });

    const serialized = storage.getItem(`${PREVIEW_STORAGE_PREFIX}${result.token}`);
    expect(serialized).not.toMatch(/0577-76543210|13900000000|13800000001|13700000002/);
    expect(serialized).not.toContain("privateDraftNote");
    expect(serialized).not.toContain("internalEnvelope");
    expect(JSON.parse(serialized)).toMatchObject({
      payload: {
        site: { platformName: "测试" },
        featuredEvent: { id: "E1", slug: "event-one", name: "赛事一" }
      },
      context: { eventId: "E1", contentId: null }
    });
  });

  it("removes only expired preview records", () => {
    const expiredKey = `${PREVIEW_STORAGE_PREFIX}expired`;
    const freshKey = `${PREVIEW_STORAGE_PREFIX}fresh`;
    const storage = memoryStorage({
      [expiredKey]: JSON.stringify({ expiresAt: 901_000 }),
      [freshKey]: JSON.stringify({ expiresAt: 901_002 }),
      "unrelated-key": "keep"
    });

    expect(cleanupPreviewSnapshots({ now: 901_001, storage })).toBe(1);
    expect(storage.getItem(expiredKey)).toBeNull();
    expect(storage.getItem(freshKey)).not.toBeNull();
    expect(storage.getItem("unrelated-key")).toBe("keep");
  });
});
