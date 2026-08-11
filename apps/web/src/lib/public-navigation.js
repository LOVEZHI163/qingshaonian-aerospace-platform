export const PUBLIC_NAVIGATION_GROUPS = [
  {
    label: "赛事服务",
    links: [
      { label: "报名入口", accountView: "eventCenter" },
      { label: "报名流程", path: "/registration-guide" },
      { label: "参赛指南", path: "/registration-guide" },
      { label: "成绩查询", accountView: "records" },
      { label: "证书查询", accountView: "certificates" }
    ]
  },
  {
    label: "关于大赛",
    links: [
      { label: "大赛简介", path: "/about" },
      { label: "赛事章程", path: "/rules" },
      { label: "赛事项目与组别", path: "/projects" }
    ]
  },
  {
    label: "赛事资讯",
    links: [
      { label: "通知公告", path: "/announcements" },
      { label: "新闻动态", path: "/news" },
      { label: "优秀作品", path: "/news?type=work" },
      { label: "赛事回顾", path: "/history" }
    ]
  }
];

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
