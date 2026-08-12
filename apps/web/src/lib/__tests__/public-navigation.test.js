import { describe, expect, it } from "vitest";
import * as navigationModule from "../public-navigation.js";
import {
  PUBLIC_PRIMARY_NAVIGATION,
  activePrimaryNavigationLabel,
  accountEntry,
  eventScopedPath,
  navigationHref,
  publicEventOptions,
  selectedPublicEvent
} from "../public-navigation.js";

const featured = { id: "E1", slug: "featured", name: "置顶赛事" };
const second = { id: "E2", slug: "second", name: "同期赛事" };
const home = { featuredEvent: featured, concurrentEvents: [second, featured, null] };

describe("public navigation model", () => {
  it("exposes three independent drawer groups and three direct destinations", () => {
    expect(PUBLIC_PRIMARY_NAVIGATION.map(({ label, children }) => [label, children?.map((row) => row.label) || []])).toEqual([
      ["首页", ["赛事服务", "报名流程", "关于大赛"]],
      ["关于大赛", ["大赛简介", "大赛章程"]],
      ["赛事资讯", ["通知公告", "新闻动态", "赛事回顾"]],
      ["获奖查询", []],
      ["联系我们", []],
      ["报名入口", []]
    ]);
  });

  it("maps child and direct routes to their semantic primary entry", () => {
    expect(activePrimaryNavigationLabel("/registration-guide")).toBe("首页");
    expect(activePrimaryNavigationLabel("/contact")).toBe("联系我们");
  });

  it("uses the primary navigation model as the only exported navigation source", () => {
    expect(navigationModule).not.toHaveProperty("PUBLIC_NAVIGATION_GROUPS");
  });

  it("scopes public and account navigation without inventing children for direct links", () => {
    const items = Object.fromEntries(PUBLIC_PRIMARY_NAVIGATION.map((row) => [row.label, row]));
    expect(navigationHref(items["联系我们"], second)).toBe("/contact?event=second");
    expect(navigationHref(items["获奖查询"], second)).toBe("/admin/?view=certificates&eventId=E2");
    expect(navigationHref(items["报名入口"], second)).toBe("/admin/?view=eventCenter&eventId=E2");
  });

  it("deduplicates the current public event options", () => {
    expect(publicEventOptions(home).map((row) => row.id)).toEqual(["E1", "E2"]);
  });

  it("falls back safely when the homepage data is null", () => {
    expect(publicEventOptions(null)).toEqual([]);
    expect(selectedPublicEvent(null, "https://aerogp.cn/about")).toBeNull();
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
