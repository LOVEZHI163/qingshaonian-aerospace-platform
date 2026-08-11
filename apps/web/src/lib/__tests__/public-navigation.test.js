import { describe, expect, it } from "vitest";
import {
  accountEntry,
  eventScopedPath,
  publicEventOptions,
  selectedPublicEvent
} from "../public-navigation.js";

const featured = { id: "E1", slug: "featured", name: "置顶赛事" };
const second = { id: "E2", slug: "second", name: "同期赛事" };
const home = { featuredEvent: featured, concurrentEvents: [second, featured, null] };

describe("public navigation model", () => {
  it("deduplicates the current public event options", () => {
    expect(publicEventOptions(home).map((row) => row.id)).toEqual(["E1", "E2"]);
  });

  it("uses the requested public event and falls back from a stale slug", () => {
    expect(selectedPublicEvent(home, "https://aerogp.cn/about?event=second")).toEqual(second);
    expect(selectedPublicEvent(home, "https://aerogp.cn/about?event=deleted")).toEqual(featured);
  });

  it("generates encoded public and account links", () => {
    expect(eventScopedPath("/about", second)).toBe("/about?event=second");
    expect(accountEntry("certificates", second)).toBe("/admin/?view=certificates&eventId=E2");
    expect(accountEntry("eventCenter", null)).toBe("/admin/?view=eventCenter");
  });
});
