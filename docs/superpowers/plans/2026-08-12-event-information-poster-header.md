# Event Information Poster Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让“大赛简介 / 大赛章程”使用当前赛事海报头图，并修复公开站导航名称、桌面布局和 1224px 宽度下的挤压裁切。

**Architecture:** 保留现有公开赛事模型与路由，赛事信息页复用 `EventPicture` 响应式媒体组件，通过 CSS 绝对定位把图片变成装饰性头图，并用渐变背景作为加载失败兜底。导航只修改公开展示文案与响应式布局，不修改 API 字段或后台数据。

**Tech Stack:** React 18、Vite 6、Vitest、Testing Library、CSS、现有 ECS Docker 部署脚本。

## Global Constraints

- `/about` 统一显示“大赛简介”，`/rules` 统一显示“大赛章程”。
- 海报读取所选赛事 `hero`，不得硬编码媒体 ID 或服务器地址。
- 无海报或加载失败时保留蓝紫品牌渐变，不显示破图。
- 约 1280px 及以下切换紧凑抽屉，390px 至 1280px 不得横向溢出。
- 不新增后端接口，不修改业务字段和既有登录、报名跳转。
- 所有功能修改先有失败测试，再写最小实现。

---

### Task 1: 统一“大赛简介 / 大赛章程”公开名称

**Files:**
- Modify: `apps/web/src/lib/public-navigation.js`
- Modify: `apps/web/src/lib/public-event-content.js`
- Test: `apps/web/src/lib/__tests__/public-navigation.test.js`
- Test: `apps/web/src/__tests__/PublicMegaDrawer.test.jsx`
- Test: `apps/web/src/__tests__/router.test.jsx`

**Interfaces:**
- Consumes: `PUBLIC_PRIMARY_NAVIGATION`、`buildPublicEventContent(section, context)`。
- Produces: `/about` 的稳定文案“大赛简介”和 `/rules` 的稳定文案“大赛章程”。

- [ ] **Step 1: 修改测试，声明新名称**

```js
expect(groups).toContainEqual(["关于大赛", ["大赛简介", "大赛章程"]]);
expect(screen.getByRole("link", { name: "大赛简介" })).toHaveAttribute("href", expect.stringContaining("/about"));
expect(screen.getByRole("heading", { name: "大赛章程" })).toBeInTheDocument();
```

- [ ] **Step 2: 运行聚焦测试并确认 RED**

Run: `npm --workspace @qingshaonian/web test -- --run src/lib/__tests__/public-navigation.test.js src/__tests__/PublicMegaDrawer.test.jsx src/__tests__/router.test.jsx`

Expected: FAIL，旧文案“赛事简章 / 赛事章程”仍存在。

- [ ] **Step 3: 最小修改导航和内容标题**

```js
children: [
  { id: "about-introduction", label: "大赛简介", path: "/about" },
  { id: "rules", label: "大赛章程", path: "/rules" }
]

const TITLES = { about: "大赛简介", rules: "大赛章程" };
```

同时把通用内容段落标题改为“大赛简介 / 大赛章程”，API 值和路由不变。

- [ ] **Step 4: 运行聚焦测试并确认 GREEN**

Run: `npm --workspace @qingshaonian/web test -- --run src/lib/__tests__/public-navigation.test.js src/__tests__/PublicMegaDrawer.test.jsx src/__tests__/router.test.jsx`

Expected: PASS。

- [ ] **Step 5: 提交名称统一**

```bash
git add apps/web/src/lib/public-navigation.js apps/web/src/lib/public-event-content.js apps/web/src/lib/__tests__/public-navigation.test.js apps/web/src/__tests__/PublicMegaDrawer.test.jsx apps/web/src/__tests__/router.test.jsx
git commit -m "fix(web): unify event introduction labels"
```

---

### Task 2: 在赛事信息页复用当前赛事海报

**Files:**
- Modify: `apps/web/src/components/FeaturedEvent.jsx`
- Modify: `apps/web/src/pages/EventInformationPage.jsx`
- Modify: `apps/web/src/styles/event-information.css`
- Test: `apps/web/src/__tests__/PublicPages.test.jsx`
- Test: `apps/web/src/__tests__/BuildClean.test.js`

**Interfaces:**
- Consumes: `EventPicture({ event, className, decorative })` 和 `selectedPublicEvent(homeData, location)`。
- Produces: 可作为装饰背景使用的赛事图片组件；赛事信息页类名 `event-information-hero-media` 与 `event-information-hero-copy`。

- [ ] **Step 1: 添加海报和降级测试**

```jsx
renderPublicPage("/about?event=wz-aerospace-2026", homeDataWithHero);
expect(screen.getByTestId("event-information-hero-media")).toHaveAttribute("aria-hidden", "true");
expect(screen.getByRole("heading", { name: "大赛简介" })).toBeInTheDocument();
```

并验证无 `hero.url` 时仍存在 `.event-information-hero` 渐变容器，而不是破图。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm --workspace @qingshaonian/web test -- --run src/__tests__/PublicPages.test.jsx src/__tests__/BuildClean.test.js`

Expected: FAIL，赛事信息页尚未渲染海报媒体和新的结构类名。

- [ ] **Step 3: 扩展 `EventPicture` 装饰模式并接入页面**

```jsx
export function EventPicture({ event, className = "", decorative = false, testId }) {
  // 保留现有失败回退；decorative 时 picture 标记 aria-hidden，img 使用空 alt。
}

<header className="event-information-hero">
  <EventPicture event={event} className="event-information-hero-media" decorative testId="event-information-hero-media" />
  <div className="event-information-hero-copy">...</div>
</header>
```

当赛事没有海报时，不渲染图片组件，只显示现有渐变兜底。

- [ ] **Step 4: 实现头图 CSS**

```css
.event-information-hero { position: relative; isolation: isolate; overflow: hidden; min-height: clamp(18rem, 29vw, 23rem); }
.event-information-hero-media { position: absolute; z-index: -2; inset: 0; width: 100%; height: 100%; }
.event-information-hero-media img { width: 100%; height: 100%; object-fit: cover; object-position: center; }
.event-information-hero::after { content: ""; position: absolute; z-index: -1; inset: 0; background: linear-gradient(90deg, rgba(3, 24, 85, .96), rgba(7, 45, 137, .72) 48%, rgba(30, 49, 180, .12)); }
.event-information-hero-copy { width: min(42rem, 66%); }
```

移动端把文案宽度改为 100%，并增强蒙层，保证对比度。

- [ ] **Step 5: 运行聚焦测试并确认 GREEN**

Run: `npm --workspace @qingshaonian/web test -- --run src/__tests__/PublicPages.test.jsx src/__tests__/BuildClean.test.js`

Expected: PASS。

- [ ] **Step 6: 提交海报头图**

```bash
git add apps/web/src/components/FeaturedEvent.jsx apps/web/src/pages/EventInformationPage.jsx apps/web/src/styles/event-information.css apps/web/src/__tests__/PublicPages.test.jsx apps/web/src/__tests__/BuildClean.test.js
git commit -m "feat(web): use event poster on information pages"
```

---

### Task 3: 修复顶部导航对齐和响应式断点

**Files:**
- Modify: `apps/web/src/styles/navigation.css`
- Test: `apps/web/src/__tests__/BuildClean.test.js`
- Test: `apps/web/src/__tests__/PublicMegaDrawer.test.jsx`

**Interfaces:**
- Consumes: 现有 `.site-header-inner`、`.brand-wordmark`、`.site-navigation`、`.menu-trigger`。
- Produces: 1280px 桌面/抽屉断点与稳定三段式桌面头部。

- [ ] **Step 1: 添加断点和布局契约测试**

```js
expect(navigationStyles).toMatch(/grid-template-columns:\s*minmax\([^;]+\)\s+minmax\(0,\s*1fr\)\s+auto/);
expect(navigationStyles).toMatch(/@media\s*\(max-width:\s*1280px\)/);
expect(navigationStyles).toMatch(/\.brand-wordmark\s*\{[^}]*width:\s*min\(20rem,\s*22vw\)/);
```

同时让测试用的 `matchMedia` 查询改为 `(max-width: 1280px)`。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npm --workspace @qingshaonian/web test -- --run src/__tests__/BuildClean.test.js src/__tests__/PublicMegaDrawer.test.jsx`

Expected: FAIL，当前仍使用 1120px 和对称三列布局。

- [ ] **Step 3: 实现稳定桌面布局与提前折叠**

```css
.site-header-inner { grid-template-columns: minmax(14rem, auto) minmax(0, 1fr) auto; }
.brand-wordmark { width: min(20rem, 22vw); }
.primary-navigation-links { gap: clamp(.625rem, 1vw, 1.125rem); }
@media (max-width: 1280px) { /* 保留现有抽屉切换规则 */ }
```

- [ ] **Step 4: 运行聚焦测试并确认 GREEN**

Run: `npm --workspace @qingshaonian/web test -- --run src/__tests__/BuildClean.test.js src/__tests__/PublicMegaDrawer.test.jsx`

Expected: PASS。

- [ ] **Step 5: 提交响应式修复**

```bash
git add apps/web/src/styles/navigation.css apps/web/src/__tests__/BuildClean.test.js apps/web/src/__tests__/PublicMegaDrawer.test.jsx
git commit -m "fix(web): align public header across breakpoints"
```

---

### Task 4: 全量验证与 ECS 部署

**Files:**
- Modify: `docs/superpowers/plans/2026-08-12-event-information-poster-header.md`（勾选执行结果）
- Verify: `apps/web/src/**`

**Interfaces:**
- Consumes: Tasks 1–3 的公开站构建产物。
- Produces: 通过测试、真实浏览器验收并部署到 `aerogp.cn` 的版本。

- [ ] **Step 1: 运行全量测试和构建**

Run: `npm --workspace @qingshaonian/web test -- --run`

Expected: 全部 PASS。

Run: `npm run build`

Expected: exit 0，公开站和管理端构建成功。

Run: `git diff --check`

Expected: 无输出。

- [ ] **Step 2: 本地真实浏览器验收**

检查 1440、1224、390px：

- `/about?event=wz-aerospace-2026` 为海报背景且标题“大赛简介”；
- `/rules?event=wz-aerospace-2026` 为海报背景且标题“大赛章程”；
- 1224px 使用紧凑抽屉，登录和报名入口不裁切；
- 390px 无横向滚动，抽屉键盘与触控可用。

- [ ] **Step 3: 部署到现有 ECS**

使用仓库现有发布脚本和 SSH 别名 `aerogp` 构建新 release、切换容器，并保留上一 release 作为回滚点。不得修改数据库业务数据。

- [ ] **Step 4: 线上冒烟检查**

```text
https://aerogp.cn/about?event=wz-aerospace-2026
https://aerogp.cn/rules?event=wz-aerospace-2026
https://aerogp.cn/
```

确认 HTTP 200、海报加载、导航文案正确、登录与报名入口可用。

- [ ] **Step 5: 记录验证结果并提交**

```bash
git add docs/superpowers/plans/2026-08-12-event-information-poster-header.md
git commit -m "docs(web): record poster header rollout"
```

---

## 2026-08-12 执行记录

- 已统一公开站导航及页面名称：`/about` 为“大赛简介”，`/rules` 为“大赛章程”。
- 已将所选赛事的 `hero` 海报作为两个赛事信息页的装饰性首屏背景；无海报或图片失败时保留蓝紫渐变兜底。
- 已把完整桌面导航稳定在大于 1280px 的视口，1280px 及以下改用紧凑抽屉，避免品牌、导航和登录/报名入口互相挤压。
- TDD 聚焦测试及 Web 全量测试通过：10 个测试文件、204/204；Admin 全量测试通过：50 个测试文件、581/581；Web/Admin 生产构建成功，`git diff --check` 无输出。
- API 在 Windows 全量运行到尾部后遇到既有 `libuv` 测试进程退出断言；本次相对线上版本没有 API 源码差异。Linux Docker 镜像构建、升级预检、版本一致性验证和完整远程 smoke 均通过。
- 已部署提交 `3f42f4c96b51e6a3bd8ba2633f3373f7e725949c`。发布前生成并校验 PostgreSQL 备份、uploads 备份、旧源码归档及 API/Web 回滚镜像；未执行 `docker compose down -v`，未删除或重建业务卷。
- 线上 `/about`、`/rules`、主页与后台均返回 200；版本接口与 `.release` 一致；PostgreSQL、API、Web、Backup 均为 healthy。完整 smoke 覆盖登录、组织隔离、报名、图片/视频上传、证书历史及测试数据清理。
- 内置浏览器在 1280px DOM 验收中确认标题“大赛简介”、海报媒体、空 `alt`、无横向溢出与抽屉入口；多视口连续截图通道随后超时。1440/1280/390 的布局契约由响应式自动化测试覆盖，未把超时截图作为通过证据。
