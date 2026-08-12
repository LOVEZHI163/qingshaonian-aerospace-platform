export const PUBLIC_PRIMARY_NAVIGATION = [
  {
    id: "home",
    label: "首页",
    path: "/",
    children: [
      { id: "services", label: "赛事服务", path: "/#services" },
      { id: "registration-guide", label: "报名流程", path: "/registration-guide" },
      { id: "about", label: "关于大赛", path: "/about" }
    ]
  },
  {
    id: "about",
    label: "关于大赛",
    path: "/about",
    children: [
      { id: "about-introduction", label: "大赛简介", path: "/about" },
      { id: "rules", label: "大赛章程", path: "/rules" }
    ]
  },
  {
    id: "news",
    label: "赛事资讯",
    path: "/news",
    children: [
      { id: "announcements", label: "通知公告", path: "/announcements" },
      { id: "news-list", label: "新闻动态", path: "/news" },
      { id: "history", label: "赛事回顾", path: "/history" }
    ]
  },
  { id: "certificates", label: "获奖查询", accountView: "certificates" },
  { id: "contact", label: "联系我们", path: "/contact" },
  { id: "registration", label: "报名入口", accountView: "eventCenter" }
];

const ABOUT_ROUTES = new Set([
  "/about",
  "/rules",
  "/projects"
]);
const HOME_ROUTES = new Set(["/", "/registration-process", "/registration-guide"]);
const NEWS_ROUTES = new Set(["/announcements", "/news", "/history"]);

export function activePrimaryNavigationLabel(location) {
  let pathname;
  try {
    pathname = new URL(location || "/", window.location.origin).pathname;
  } catch {
    return null;
  }
  if (HOME_ROUTES.has(pathname)) return "首页";
  if (ABOUT_ROUTES.has(pathname)) return "关于大赛";
  if (NEWS_ROUTES.has(pathname)) return "赛事资讯";
  if (pathname === "/contact") return "联系我们";
  return null;
}

export function publicEventOptions(homeData = {}) {
  homeData ||= {};
  const seen = new Set();
  return [homeData.featuredEvent, ...(homeData.concurrentEvents || [])].filter((event) => {
    if (!event?.id || !event.slug || seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
}

export function selectedPublicEvent(homeData, location) {
  const rows = publicEventOptions(homeData);
  const requested = new URL(location || "/", window.location.origin).searchParams.get("event");
  return rows.find((event) => event.slug === requested) || rows[0] || null;
}

export function eventScopedPath(path, event) {
  if (!event?.slug) return path;
  const url = new URL(path, window.location.origin);
  url.searchParams.set("event", event.slug);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function accountEntry(view, event) {
  const params = new URLSearchParams({ view });
  if (event?.id) params.set("eventId", event.id);
  return `/admin/?${params.toString()}`;
}

export function navigationHref(item, activeEvent) {
  return item.accountView
    ? accountEntry(item.accountView, activeEvent)
    : eventScopedPath(item.path, activeEvent);
}
