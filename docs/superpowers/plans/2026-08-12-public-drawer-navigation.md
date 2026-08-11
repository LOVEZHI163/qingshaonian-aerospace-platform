# Public Drawer Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将公共官网顶部导航改造成桌面与移动端统一的向下抽屉式大型菜单，并让赛事内容页和业务入口自动跟随首页置顶赛事。

**Architecture:** 继续复用 `/api/public/home` 返回的 `featuredEvent`、`concurrentEvents` 和 `services`，不新增数据库字段。新增纯函数模块统一选择当前浏览赛事和生成站内链接；新增独立赛事信息页从置顶赛事与 `/api/public/events/:slug` 组合数据，2026 年赛事的章程文本使用会签稿整理的内置公开副本，其他赛事安全使用动态字段和通用说明。`SiteHeader` 只负责外壳，抽屉的状态、焦点、悬停和移动端滚动锁定由独立组件负责。

**Tech Stack:** React 18、Vite 6、Vitest 4、Testing Library、现有 History API 路由器、现有公共站点 REST API。

## Global Constraints

- 公共网站保持现有蓝白配色与现有 SVG LOGO。
- 桌面端和移动端都使用从顶部向下展开的抽屉，不使用右侧滑出菜单。
- “获奖查询”进入 `/admin/?view=certificates`；“报名入口”进入 `/admin/?view=eventCenter`，由现有登录页完成身份认证。
- 默认内容跟随首页置顶赛事；无置顶赛事或接口失败时保留平台公共导航。
- 已删除、不可公开或不在 `/api/public/home` 返回值中的赛事不能留在赛事切换列表。
- 不改变后台、组织用户和普通用户的权限模型。
- 不增加新的运行时依赖。
- 所有新增交互必须支持键盘、`Escape`、焦点恢复和 `prefers-reduced-motion`。

---

## File Map

- Create `apps/web/src/lib/public-navigation.js`: 导航分组、赛事选择、赛事查询参数和账号入口链接的单一来源。
- Create `apps/web/src/lib/__tests__/public-navigation.test.js`: 纯函数的赛事选择、残留清理与链接测试。
- Create `apps/web/src/content/wz-aerospace-2026.js`: 从会签稿整理的当前赛事公开文字，不包含内部会签信息。
- Create `apps/web/src/lib/public-event-content.js`: 将赛事动态字段、当前赛事公开副本和平台降级内容组合成页面模型。
- Create `apps/web/src/lib/__tests__/public-event-content.test.js`: 内容映射与降级测试。
- Create `apps/web/src/components/PublicMegaDrawer.jsx`: 抽屉分组、赛事切换和业务入口渲染。
- Modify `apps/web/src/components/SiteHeader.jsx`: 品牌区、一级导航和抽屉交互外壳。
- Create `apps/web/src/pages/EventInformationPage.jsx`: 大赛简介、章程、报名流程、联系方式、赛项组别的统一页面。
- Modify `apps/web/src/router.js`: 注册五个固定公共内容路由。
- Modify `apps/web/src/App.jsx`: 将首页聚合数据传给导航并渲染赛事信息页。
- Modify `apps/api/src/routes/public-site.js`: 将新增固定页面加入公开站点地图。
- Modify `apps/api/test/public-site-routes.test.js`: 验证新页面使用正式域名生成 canonical sitemap URL。
- Create `apps/web/src/styles/navigation.css`: 顶部导航和抽屉的桌面、移动端、动画和焦点样式。
- Create `apps/web/src/styles/event-information.css`: 独立内容页样式。
- Modify `apps/web/src/styles.css`: 引入新样式并移除旧导航冲突规则。
- Modify `apps/web/src/__tests__/router.test.jsx`: 新路由、站内跳转和抽屉关闭回归。
- Modify `apps/web/src/__tests__/Accessibility.test.jsx`: 焦点、键盘、链接顺序和无障碍状态。
- Create `apps/web/src/__tests__/PublicMegaDrawer.test.jsx`: 悬停延迟、点击锁定、点击外部和赛事切换测试。
- Modify `apps/web/src/__tests__/PublicPages.test.jsx`: 独立赛事内容页和动态赛项测试。

---

### Task 1: 建立导航与赛事选择的纯函数契约

**Files:**
- Create: `apps/web/src/lib/public-navigation.js`
- Create: `apps/web/src/lib/__tests__/public-navigation.test.js`

**Interfaces:**
- Produces: `publicEventOptions(homeData): PublicEvent[]`
- Produces: `selectedPublicEvent(homeData, location): PublicEvent | null`
- Produces: `eventScopedPath(path, event): string`
- Produces: `accountEntry(view, event): string`
- Produces: `PUBLIC_NAVIGATION_GROUPS: NavigationGroup[]`

- [ ] **Step 1: Write the failing pure-function tests**

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w apps/web -- --run src/lib/__tests__/public-navigation.test.js`

Expected: FAIL because `public-navigation.js` does not exist.

- [ ] **Step 3: Implement the minimal navigation model**

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w apps/web -- --run src/lib/__tests__/public-navigation.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/public-navigation.js apps/web/src/lib/__tests__/public-navigation.test.js
git commit -m "feat(web): add public navigation model"
```

---

### Task 2: 整理赛事方案内容并建立页面内容模型

**Files:**
- Create: `apps/web/src/content/wz-aerospace-2026.js`
- Create: `apps/web/src/lib/public-event-content.js`
- Create: `apps/web/src/lib/__tests__/public-event-content.test.js`

**Interfaces:**
- Consumes: `PublicEvent` from `/api/public/home` and event detail `{ event, projects, groups }` from `/api/public/events/:slug`.
- Produces: `buildPublicEventContent(section, { event, detail, site }): EventInformationModel`
- `EventInformationModel` shape: `{ title, eyebrow, lead, facts, sections, actions }` where each section is `{ heading, paragraphs?: string[], items?: object[] }`.

- [ ] **Step 1: Write failing tests for current-event copy and generic fallback**

```js
import { describe, expect, it } from "vitest";
import { buildPublicEventContent } from "../public-event-content.js";

const current = {
  id: "E1",
  slug: "wz-aerospace-2026",
  name: "2026年温州市青少年航空航天创新比赛",
  theme: "科技强国 未来有我",
  dateLabel: "2026年11月21-22日",
  venue: "温州市文成县东方职业技术学院",
  contact: "吴琛琛 88968723 / 15858799111"
};

describe("public event content", () => {
  it("maps the approved document copy onto the current event", () => {
    const model = buildPublicEventContent("registration", { event: current, detail: null, site: {} });
    expect(model.title).toBe("报名流程");
    expect(model.sections.map((section) => section.heading)).toContain("报名资格与方式");
    expect(JSON.stringify(model)).toContain("2026年11月1日");
  });

  it("renders live projects and groups without hard-coding deleted projects", () => {
    const model = buildPublicEventContent("projects", {
      event: current,
      detail: { projects: [{ id: "P1", name: "无人机竞速", category: "飞行类" }], groups: ["小学高段"] },
      site: {}
    });
    expect(JSON.stringify(model)).toContain("无人机竞速");
    expect(JSON.stringify(model)).not.toContain("已删除赛项");
  });

  it("uses safe platform copy when no public event exists", () => {
    const model = buildPublicEventContent("about", { event: null, detail: null, site: { platformIntro: "平台公共介绍" } });
    expect(model.lead).toBe("平台公共介绍");
    expect(model.actions[0]).toEqual({ label: "查看历届赛事", href: "/history" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w apps/web -- --run src/lib/__tests__/public-event-content.test.js`

Expected: FAIL because the content modules do not exist.

- [ ] **Step 3: Add the approved 2026 public copy**

Create `apps/web/src/content/wz-aerospace-2026.js` with a structured export containing these exact public sections:

```js
export const WZ_AEROSPACE_2026_COPY = {
  about: [
    { heading: "赛事主题", paragraphs: ["科技强国，未来有我。"] },
    { heading: "举办宗旨", paragraphs: ["通过航空航天科技实践，培养青少年的科学兴趣、创新精神和实践能力，展示学习实践成果。"] },
    { heading: "参赛对象", paragraphs: ["面向温州市符合赛事报名条件的青少年学生，具体资格以赛事章程和报名审核结果为准。"] }
  ],
  rules: [
    { heading: "竞赛组织", paragraphs: ["赛事按照公开、公平、公正原则组织实施，各赛项执行公布的技术规则和现场要求。"] },
    { heading: "竞赛办法", paragraphs: ["参赛者须遵守赛场纪律、安全要求和赛项规程，报名信息与参赛身份须真实一致。"] },
    { heading: "奖项设置", paragraphs: ["各赛项按实际参赛和评审情况设置奖项，最终结果以赛事组委会公布内容为准。"] }
  ],
  registration: [
    { heading: "报名资格与方式", paragraphs: ["赛事面向温州市符合条件的学生，通过 aerogp.cn 赛事平台报名，并按要求提交真实完整的信息。"] },
    { heading: "报名限制", paragraphs: ["每名参赛者最多报名1个个人赛和1个团体赛；具体适用组别以赛项设置为准。"] },
    { heading: "报名截止", paragraphs: ["报名截止时间为2026年11月1日，逾期不再接受本届赛事报名。"] },
    { heading: "费用说明", paragraphs: ["赛事坚持公益原则，不向参赛者收取报名费。"] }
  ],
  contact: [
    { heading: "赛事联系", paragraphs: ["联系人：吴琛琛", "联系电话：88968723 / 15858799111"] },
    { heading: "比赛地点", paragraphs: ["浙江东方职业技术学院文成校区（文成县南田镇伯温北路1号）。"] }
  ]
};
```

- [ ] **Step 4: Implement `buildPublicEventContent`**

The implementation must:

- choose the current copy only when `event.slug === "wz-aerospace-2026"`;
- build title/lead and facts from the selected event, never from a stale cached event;
- render projects from `detail.projects` and groups from `detail.groups`;
- use `site.platformIntro`, `site.contact` and `/history` when no event exists;
- return buttons for “立即报名”, “返回首页” and “查看赛事资讯” when an event exists.

```js
import { WZ_AEROSPACE_2026_COPY } from "../content/wz-aerospace-2026.js";
import { accountEntry } from "./public-navigation.js";

const TITLES = {
  about: "大赛简介",
  rules: "赛事章程",
  registration: "报名流程",
  contact: "联系我们",
  projects: "赛事项目与组别"
};

const GENERIC_COPY = {
  about: [{ heading: "赛事介绍", paragraphs: ["赛事详细介绍正在整理中，请以赛事公告为准。"] }],
  rules: [{ heading: "赛事规则", paragraphs: ["请按照赛事公告、赛项规程和现场安全要求参赛。"] }],
  registration: [{ heading: "报名说明", paragraphs: ["请登录赛事报名系统，选择赛事后按照页面要求提交信息。"] }],
  contact: []
};

const text = (value) => String(value || "").trim();

function dynamicFacts(event) {
  return [
    ["比赛时间", event.dateLabel],
    ["比赛地点", event.venue],
    ["报名截止", event.registrationEndAt ? new Date(event.registrationEndAt).toLocaleString("zh-CN", { hour12: false }) : ""]
  ].filter(([, value]) => text(value)).map(([label, value]) => ({ label, value }));
}

function projectSections(detail) {
  const projects = Array.isArray(detail?.projects) ? detail.projects : [];
  const groups = Array.isArray(detail?.groups) ? detail.groups : [];
  return [
    { heading: "赛事项目", items: projects.map(({ id, name, category, type, allowedGroups }) => ({ id, name, category, type, allowedGroups })) },
    { heading: "参赛组别", items: groups.map((name) => ({ id: name, name })) }
  ];
}

export function buildPublicEventContent(section, { event, detail, site = {} }) {
  if (!event) return {
    title: TITLES[section] || "赛事信息",
    eyebrow: "温州少航",
    lead: site.platformIntro || "赛事信息正在整理中，请稍后查看。",
    facts: [],
    sections: site.contact ? [{ heading: "平台联系", paragraphs: [site.contact] }] : [],
    actions: [{ label: "查看历届赛事", href: "/history" }]
  };

  const eventCopy = event.slug === "wz-aerospace-2026" ? WZ_AEROSPACE_2026_COPY : GENERIC_COPY;
  const sections = section === "projects"
    ? projectSections(detail)
    : [...(eventCopy[section] || GENERIC_COPY[section] || [])];
  if (section === "contact" && event.slug !== "wz-aerospace-2026") {
    const contact = text(event.contact || site.contact);
    if (contact) sections.push({ heading: "赛事联系", paragraphs: [contact] });
  }
  return {
    title: TITLES[section] || "赛事信息",
    eyebrow: event.name,
    lead: event.summary || event.slogan || event.theme || `${event.name}公开信息`,
    facts: dynamicFacts(event),
    sections,
    actions: [
      { label: "立即报名", href: accountEntry("eventCenter", event), externalRouter: true },
      { label: "返回首页", href: "/" },
      { label: "查看赛事资讯", href: `/news?event=${encodeURIComponent(event.slug)}` }
    ]
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w apps/web -- --run src/lib/__tests__/public-event-content.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/content/wz-aerospace-2026.js apps/web/src/lib/public-event-content.js apps/web/src/lib/__tests__/public-event-content.test.js
git commit -m "feat(web): add public event information model"
```

---

### Task 3: 新增独立赛事信息页和路由

**Files:**
- Create: `apps/web/src/pages/EventInformationPage.jsx`
- Modify: `apps/web/src/router.js`
- Modify: `apps/web/src/App.jsx`
- Modify: `apps/web/src/__tests__/router.test.jsx`
- Modify: `apps/web/src/__tests__/PublicPages.test.jsx`
- Modify: `apps/api/src/routes/public-site.js`
- Modify: `apps/api/test/public-site-routes.test.js`

**Interfaces:**
- Consumes: `selectedPublicEvent`, `buildPublicEventContent`, `fetchJson`.
- Produces: routes `about`, `rules`, `registration-guide`, `contact`, `projects`.
- `EventInformationPage` props: `{ section, homeData, homeStatus, location }`.

- [ ] **Step 1: Add failing route tests**

Extend the route table in `router.test.jsx`:

```js
it.each([
  ["/about", "大赛简介"],
  ["/rules", "赛事章程"],
  ["/registration-guide", "报名流程"],
  ["/contact", "联系我们"],
  ["/projects", "赛事项目与组别"]
])("renders the %s event information route", async (path, heading) => {
  window.history.replaceState({}, "", path);
  render(<App />);
  expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
});
```

Add a page test that supplies a home payload with `featuredEvent.slug = "summer-cup"`, returns project detail for `/api/public/events/summer-cup`, and asserts the page renders only the returned projects.

Extend the existing sitemap test to assert:

```js
for (const route of ["/about", "/rules", "/registration-guide", "/contact", "/projects"]) {
  assert.equal(xml.includes(`<loc>https://public.example/base${route}</loc>`), true);
}
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -w apps/web -- --run src/__tests__/router.test.jsx src/__tests__/PublicPages.test.jsx`

Expected: FAIL because the routes and page do not exist.

- [ ] **Step 3: Register the fixed routes**

Add to `matchRoute`:

```js
if (pathname === "/about") return { name: "event-information", params: { section: "about" } };
if (pathname === "/rules") return { name: "event-information", params: { section: "rules" } };
if (pathname === "/registration-guide") return { name: "event-information", params: { section: "registration" } };
if (pathname === "/contact") return { name: "event-information", params: { section: "contact" } };
if (pathname === "/projects") return { name: "event-information", params: { section: "projects" } };
```

- [ ] **Step 4: Implement the information page**

`EventInformationPage.jsx` must:

- select an event only from the current home response;
- fetch `/api/public/events/${encodeURIComponent(event.slug)}` when an event exists;
- abort the request when the event or route changes;
- show a restrained loading state for detail-dependent content;
- hide absent fields instead of printing `undefined`;
- render event switch links when there are two or three public events;
- render bottom actions with ordinary anchors so login still works if client routing fails.

Use this component structure:

```jsx
import React, { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../api/client.js";
import Seo from "../components/Seo.jsx";
import { buildPublicEventContent } from "../lib/public-event-content.js";
import { eventScopedPath, publicEventOptions, selectedPublicEvent } from "../lib/public-navigation.js";

export default function EventInformationPage({ section, homeData, homeStatus, location }) {
  const event = selectedPublicEvent(homeData, location);
  const [detailState, setDetailState] = useState({ slug: null, status: "idle", data: null });
  useEffect(() => {
    if (!event?.slug) return undefined;
    const controller = new AbortController();
    setDetailState({ slug: event.slug, status: "loading", data: null });
    fetchJson(`/api/public/events/${encodeURIComponent(event.slug)}`, { signal: controller.signal })
      .then((data) => setDetailState({ slug: event.slug, status: "success", data }))
      .catch((error) => {
        if (error?.name !== "AbortError") setDetailState({ slug: event.slug, status: "error", data: null });
      });
    return () => controller.abort();
  }, [event?.slug]);
  const detail = detailState.slug === event?.slug ? detailState.data : null;
  const model = useMemo(
    () => buildPublicEventContent(section, { event, detail, site: homeData?.site }),
    [section, event, detail, homeData?.site]
  );
  const options = publicEventOptions(homeData);
  return (
    <section className="event-information-page" aria-labelledby="event-information-title">
      <Seo title={model.title} description={model.lead} pathname={new URL(location, window.location.origin).pathname} />
      <header className="event-information-hero">
        <p>{model.eyebrow}</p>
        <h1 id="event-information-title">{model.title}</h1>
        <p>{model.lead}</p>
      </header>
      {options.length > 1 ? (
        <nav className="event-information-switcher" aria-label="切换公开赛事">
          {options.map((row) => <a key={row.id} href={eventScopedPath(new URL(location, window.location.origin).pathname, row)} aria-current={row.id === event?.id ? "page" : undefined}>{row.name}</a>)}
        </nav>
      ) : null}
      {model.facts.length ? <dl className="event-information-facts">{model.facts.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : null}
      {homeStatus === "loading" || (detailState.status === "loading" && section === "projects") ? <p role="status">正在加载赛事信息…</p> : null}
      <div className="event-information-sections">
        {model.sections.map((item) => (
          <article key={item.heading}>
            <h2>{item.heading}</h2>
            {(item.paragraphs || []).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            {item.items ? <ul>{item.items.map((row) => <li key={row.id}>{row.name}</li>)}</ul> : null}
          </article>
        ))}
      </div>
      <div className="event-information-actions">
        {model.actions.map((action) => <a key={action.label} href={action.href} data-router-ignore={action.externalRouter || undefined}>{action.label}</a>)}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Wire the page into `App.jsx`**

Lazy-load the page, render it from `PublicRoute`, pass `bootstrap.data`, `bootstrap.status` and `location`, and change:

```jsx
<SiteHeader routeKey={location} homeData={bootstrap.data || {}} homeStatus={bootstrap.status} />
```

- [ ] **Step 6: Add the fixed pages to the sitemap**

Change the API constant to:

```js
const FIXED_ROUTES = [
  "/", "/about", "/rules", "/registration-guide", "/contact", "/projects",
  "/announcements", "/news", "/history"
];
```

- [ ] **Step 7: Run the focused tests**

Run: `npm test -w apps/web -- --run src/__tests__/router.test.jsx src/__tests__/PublicPages.test.jsx`

Expected: PASS.

Run: `npm test -w apps/api -- --test-name-pattern="sitemap"`

Expected: sitemap tests PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/EventInformationPage.jsx apps/web/src/router.js apps/web/src/App.jsx apps/web/src/__tests__/router.test.jsx apps/web/src/__tests__/PublicPages.test.jsx apps/api/src/routes/public-site.js apps/api/test/public-site-routes.test.js
git commit -m "feat(web): add event information pages"
```

---

### Task 4: 建立全宽抽屉组件及完整交互

**Files:**
- Create: `apps/web/src/components/PublicMegaDrawer.jsx`
- Modify: `apps/web/src/components/SiteHeader.jsx`
- Create: `apps/web/src/__tests__/PublicMegaDrawer.test.jsx`
- Modify: `apps/web/src/__tests__/Accessibility.test.jsx`
- Modify: `apps/web/src/__tests__/router.test.jsx`

**Interfaces:**
- `PublicMegaDrawer` props: `{ open, activeEvent, events, currentPath, onClose, onEventChange }`.
- `SiteHeader` props: `{ routeKey, homeData, homeStatus }`.
- Consumes: `PUBLIC_NAVIGATION_GROUPS`, `accountEntry`, `eventScopedPath`, `publicEventOptions`, `selectedPublicEvent`.

- [ ] **Step 1: Write failing interaction tests**

```jsx
it("opens from hover, waits before closing, and cancels closing on re-entry", () => {
  vi.useFakeTimers();
  render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
  const zone = screen.getByTestId("public-navigation-zone");
  fireEvent.mouseEnter(zone);
  expect(screen.getByRole("navigation", { name: "赛事导航" })).toBeVisible();
  fireEvent.mouseLeave(zone);
  act(() => vi.advanceTimersByTime(299));
  expect(screen.getByRole("navigation", { name: "赛事导航" })).toBeVisible();
  fireEvent.mouseEnter(zone);
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("navigation", { name: "赛事导航" })).toBeVisible();
  vi.useRealTimers();
});

it("locks the drawer by click and closes on outside click", () => {
  render(<SiteHeader routeKey="/" homeData={home} homeStatus="success" />);
  fireEvent.click(screen.getByRole("button", { name: "打开赛事导航" }));
  expect(screen.getByRole("button", { name: "关闭赛事导航" })).toHaveAttribute("aria-expanded", "true");
  fireEvent.pointerDown(document.body);
  expect(screen.getByRole("button", { name: "打开赛事导航" })).toHaveAttribute("aria-expanded", "false");
});

it("returns focus after Escape and exposes the selected event links", () => {
  render(<SiteHeader routeKey="/about?event=second" homeData={home} homeStatus="success" />);
  const trigger = screen.getByRole("button", { name: "打开赛事导航" });
  fireEvent.click(trigger);
  expect(screen.getByRole("link", { name: "大赛简介" })).toHaveAttribute("href", "/about?event=second");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(trigger).toHaveFocus();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w apps/web -- --run src/__tests__/PublicMegaDrawer.test.jsx src/__tests__/Accessibility.test.jsx src/__tests__/router.test.jsx`

Expected: FAIL because the drawer and updated labels do not exist.

- [ ] **Step 3: Implement `PublicMegaDrawer`**

The component must:

- render the three approved groups and the theme “科技强国，未来有我” fallback;
- use `accountEntry` for registration/results/certificates;
- use `eventScopedPath` for event information pages;
- render only `publicEventOptions(homeData)` in the switcher;
- use links instead of mutating global state when switching events;
- add `data-router-ignore="true"` to `/admin/` links.

Use this rendering contract:

```jsx
import React from "react";
import { accountEntry, eventScopedPath, PUBLIC_NAVIGATION_GROUPS } from "../lib/public-navigation.js";

export default function PublicMegaDrawer({ open, activeEvent, events, currentPath, onClose }) {
  const theme = activeEvent?.theme || activeEvent?.slogan || "科技强国，未来有我";
  const hrefFor = (link) => link.accountView
    ? accountEntry(link.accountView, activeEvent)
    : eventScopedPath(link.path, activeEvent);
  return (
    <div id="public-mega-drawer" className="public-mega-drawer" data-open={open || undefined} aria-hidden={!open}>
      <div className="public-mega-drawer-inner">
        <nav aria-label="赛事导航">
          {PUBLIC_NAVIGATION_GROUPS.map((group) => (
            <section className="public-mega-drawer-group" key={group.label}>
              <h2>{group.label}</h2>
              <ul>{group.links.map((link) => {
                const href = hrefFor(link);
                return <li key={`${group.label}:${link.label}`}><a href={href} data-router-ignore={link.accountView ? "true" : undefined} onClick={onClose} aria-current={currentPath === link.path ? "page" : undefined}>{link.label}</a></li>;
              })}</ul>
            </section>
          ))}
        </nav>
        <aside className="public-mega-drawer-featured">
          <p>{theme}</p>
          <strong>{activeEvent?.name || "温州少航赛事平台"}</strong>
          {events.length > 1 ? <div aria-label="切换赛事">{events.map((event) => <a key={event.id} href={eventScopedPath("/about", event)}>{event.name}</a>)}</div> : null}
        </aside>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Refactor `SiteHeader` state handling**

Use two state values so hover does not fight click locking:

```jsx
const [hoverOpen, setHoverOpen] = useState(false);
const [lockedOpen, setLockedOpen] = useState(false);
const menuOpen = hoverOpen || lockedOpen;
const closeTimerRef = useRef(null);

const cancelClose = () => {
  window.clearTimeout(closeTimerRef.current);
  closeTimerRef.current = null;
};
const openFromHover = () => {
  cancelClose();
  setHoverOpen(true);
};
const scheduleHoverClose = () => {
  cancelClose();
  closeTimerRef.current = window.setTimeout(() => setHoverOpen(false), 300);
};
```

Connect these helpers to the component as follows:

- `mouseEnter`: cancel close timer and set `hoverOpen`;
- `mouseLeave`: schedule `setHoverOpen(false)` after 300 ms unless locked;
- click trigger: toggle `lockedOpen`;
- outside pointer down: clear both states;
- `Escape`: clear both states and restore trigger focus;
- route change: clear both states;
- on small screens, lock `document.body.style.overflow = "hidden"` while open and restore the previous inline value on cleanup;
- move focus to the first drawer link only for click/keyboard opening, not incidental desktop hover.

Render these approved primary links in this order, with the awards and registration links generated from the selected event:

```jsx
const primaryLinks = [
  { label: "首页", href: "/" },
  { label: "关于大赛", href: eventScopedPath("/about", activeEvent) },
  { label: "赛事资讯", href: eventScopedPath("/news", activeEvent) },
  { label: "获奖查询", href: accountEntry("certificates", activeEvent), routerIgnore: true },
  { label: "联系我们", href: eventScopedPath("/contact", activeEvent) },
  { label: "报名入口", href: accountEntry("eventCenter", activeEvent), routerIgnore: true }
];
```

- [ ] **Step 5: Update accessibility and routing assertions**

Replace obsolete expectations for “公告” as a direct-only header item with assertions for the approved main links. Preserve checks that account links carry `data-router-ignore="true"`, the account entry appears before registration, and route navigation closes the drawer.

- [ ] **Step 6: Run the interaction tests**

Run: `npm test -w apps/web -- --run src/__tests__/PublicMegaDrawer.test.jsx src/__tests__/Accessibility.test.jsx src/__tests__/router.test.jsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/PublicMegaDrawer.jsx apps/web/src/components/SiteHeader.jsx apps/web/src/__tests__/PublicMegaDrawer.test.jsx apps/web/src/__tests__/Accessibility.test.jsx apps/web/src/__tests__/router.test.jsx
git commit -m "feat(web): add accessible public mega drawer"
```

---

### Task 5: 完成蓝白响应式视觉和内容页布局

**Files:**
- Create: `apps/web/src/styles/navigation.css`
- Create: `apps/web/src/styles/event-information.css`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/__tests__/BuildClean.test.js`

**Interfaces:**
- Consumes the class names emitted by Tasks 3 and 4.
- Produces no JavaScript API; produces the responsive visual contract.

- [ ] **Step 1: Add a failing stylesheet contract test**

Extend `BuildClean.test.js` to read the new files and assert:

```js
expect(styles).toContain('@import "./styles/navigation.css"');
expect(styles).toContain('@import "./styles/event-information.css"');
expect(navigation).toContain(".public-mega-drawer");
expect(navigation).toContain("@media (max-width: 1120px)");
expect(navigation).toContain("prefers-reduced-motion");
expect(eventInformation).toContain(".event-information-page");
```

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `npm test -w apps/web -- --run src/__tests__/BuildClean.test.js`

Expected: FAIL because the style modules are absent.

- [ ] **Step 3: Add `navigation.css`**

Implement these exact layout constraints with the following core rules, then add typography and spacing using the existing tokens:

```css
.site-header { position: relative; z-index: 30; color: var(--color-white); background: var(--color-brand); }
.site-header-inner,
.public-mega-drawer-inner { width: min(var(--content-max), calc(100% - 2.5rem)); margin-inline: auto; }
.public-mega-drawer {
  position: absolute;
  inset-inline: 0;
  top: 100%;
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-12px);
  color: var(--color-text);
  background: var(--color-white);
  box-shadow: var(--shadow-lg);
  transition: opacity 200ms ease, transform 200ms ease, visibility 200ms;
}
.public-mega-drawer[data-open] { visibility: visible; opacity: 1; pointer-events: auto; transform: translateY(0); }
.public-mega-drawer-inner { display: grid; grid-template-columns: minmax(0, 3fr) minmax(15rem, 1fr); gap: 3rem; padding-block: 2.5rem; }
.public-mega-drawer nav { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2rem; }
@media (max-width: 1120px) {
  .public-mega-drawer { max-height: calc(100vh - 72px); overflow-y: auto; }
  .public-mega-drawer-inner { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .site-header-inner, .public-mega-drawer-inner { width: min(var(--content-max), calc(100% - 1.5rem)); }
  .public-mega-drawer nav { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .public-mega-drawer { transition: none; }
}
```

Also enforce:

- `.site-header-inner` and `.public-mega-drawer-inner` both use `width: min(var(--content-max), calc(100% - 2.5rem))`;
- desktop drawer uses `position: absolute; inset-inline: 0; top: 100%` and a white background;
- drawer content uses three link columns plus a theme/event column;
- closed state uses `visibility`, `opacity` and `transform`, not `display: none`, so the 200 ms transition works;
- closed drawer must also use `pointer-events: none`;
- mobile breakpoint at 1120 px changes the drawer to a vertically scrollable panel below the header;
- mobile groups use one column below 640 px;
- focus-visible states use `var(--focus-ring)`;
- reduced-motion media query removes transitions.

- [ ] **Step 4: Add `event-information.css`**

Implement the content page with these core rules:

```css
.event-information-page { width: min(var(--content-max), calc(100% - 2.5rem)); margin: 0 auto; padding: clamp(2rem, 5vw, 5rem) 0; }
.event-information-hero { padding: clamp(1.5rem, 5vw, 4rem); border-radius: var(--radius-lg); color: var(--color-white); background: linear-gradient(135deg, var(--color-brand-deep), var(--color-brand)); }
.event-information-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
.event-information-sections { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.25rem; }
.event-information-sections article { padding: 1.5rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-white); }
.event-information-actions { display: flex; flex-wrap: wrap; gap: .75rem; }
@media (max-width: 720px) {
  .event-information-page { width: min(var(--content-max), calc(100% - 1.5rem)); }
  .event-information-facts, .event-information-sections { grid-template-columns: 1fr; }
}
```

Also enforce:

- shared max-width aligned with the homepage;
- blue event hero with readable white text;
- event switch chips or select control that wraps without horizontal scrolling;
- two-column fact cards on desktop and one column on mobile;
- project and group cards with no fixed height;
- bottom action row that wraps at narrow widths;
- `scroll-margin-top` for focused headings.

- [ ] **Step 5: Remove conflicting old header rules and import modules**

Keep global tokens and shell styles in `styles.css`; remove the old `.site-navigation`, `.menu-trigger`, `.header-actions` and associated breakpoint blocks after their equivalents exist in `navigation.css`.

- [ ] **Step 6: Run contract test and build**

Run: `npm test -w apps/web -- --run src/__tests__/BuildClean.test.js`

Expected: PASS.

Run: `npm run build -w apps/web`

Expected: exit code 0 and Vite emits the public site bundle without warnings about unresolved imports.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/styles.css apps/web/src/styles/navigation.css apps/web/src/styles/event-information.css apps/web/src/__tests__/BuildClean.test.js
git commit -m "style(web): add responsive drawer navigation"
```

---

### Task 6: 全量回归与浏览器验收

**Files:**
- Modify only if verification exposes a concrete regression in files already listed above.

**Interfaces:**
- Verifies the completed public website feature as a whole.

- [ ] **Step 1: Run the complete web test suite**

Run: `npm test -w apps/web -- --run`

Expected: all web tests PASS.

- [ ] **Step 2: Run the full monorepo build**

Run: `npm run build`

Expected: web and admin production builds both exit with code 0.

- [ ] **Step 3: Start the local application for visual verification**

Run in the existing development environment: `npm run dev`

Verify with browser tooling at these viewport widths:

- 1440 px: hover opens full-width drawer aligned with homepage content.
- 1024 px: click menu opens the same information architecture without clipping.
- 390 px: menu is vertically scrollable, background is locked, links remain tappable.

- [ ] **Step 4: Verify user journeys**

Check:

1. 首页 → 抽屉 → 大赛简介。
2. 首页 → 抽屉 → 赛事章程。
3. 首页 → 抽屉 → 获奖查询 → 用户登录。
4. 首页 → 抽屉 → 报名入口 → 用户登录/赛事中心。
5. 切换同期赛事 → 赛事项目与组别只显示该赛事的 API 数据。
6. 请求不存在的 `?event=deleted` → 自动回到置顶赛事。
7. `/api/public/home` 失败 → 页头和平台公共导航仍显示，不暴露技术错误。
8. 键盘打开菜单、逐项 Tab、Escape 关闭并恢复焦点。

- [ ] **Step 5: Review the final diff**

Run: `git diff HEAD~5 --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: clean after the final verification commit.

- [ ] **Step 6: Commit verification fixes if any were required**

```bash
git add apps/web/src
git commit -m "fix(web): complete drawer navigation verification"
```

Skip this commit only when Step 1–5 required no file changes.
