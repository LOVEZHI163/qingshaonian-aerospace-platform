# 官网分栏目抽屉导航与头部视觉优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将官网共享全宽大抽屉改为三个独立栏目抽屉，优化头部登录报名布局，并把前后台内容类型名称统一为“通知公告、新闻动态、赛事回顾”。

**Architecture:** 使用 `public-navigation.js` 作为一级导航、子项和直达入口的单一数据源；`SiteHeader` 管理当前展开分组、桌面悬停/点击和移动菜单状态；新的分栏目抽屉组件只渲染当前分组。后台与前台分别复用各自的类型标签常量，内部类型值和 API 不变。

**Tech Stack:** React 18、Vue 3、Vite 6、Vitest、Testing Library、原生 CSS、Docker Compose、Caddy。

## Global Constraints

- 数据库与 API 类型值继续使用 `announcement`、`news`、`recap`。
- 只把可见名称统一为“通知公告”“新闻动态”“赛事回顾”，不迁移历史内容。
- 公开赛事链接保留当前赛事 `event` 参数；账户入口保留 `eventId` 参数。
- 桌面支持悬停、点击和完整键盘操作；手机使用单分组展开的手风琴菜单。
- Logo、导航、操作按钮与页面主体使用相同内容宽度和蓝白视觉体系。
- 不修改用户权限、报名、成绩和证书业务逻辑。

---

### Task 1: 建立导航数据模型

**Files:**
- Modify: `apps/web/src/lib/public-navigation.js`
- Test: `apps/web/src/lib/__tests__/public-navigation.test.js`

**Interfaces:**
- Produces: `PUBLIC_PRIMARY_NAVIGATION`，元素格式为 `{ id, label, path?, accountView?, children? }`。
- Produces: `navigationHref(item, activeEvent)`，为公开链接附加 `event`，为账户链接附加 `eventId`。
- Preserves: `activePrimaryNavigationLabel(location)`、`eventScopedPath`、`accountEntry`。

- [ ] **Step 1: Write the failing navigation model tests**

```js
it("exposes three independent drawer groups and three direct destinations", () => {
  expect(PUBLIC_PRIMARY_NAVIGATION.map(({ label, children }) => [label, children?.map((row) => row.label) || []])).toEqual([
    ["首页", ["赛事服务", "报名流程", "关于大赛"]],
    ["关于大赛", ["赛事简章", "赛事章程"]],
    ["赛事资讯", ["通知公告", "新闻动态", "赛事回顾"]],
    ["获奖查询", []],
    ["联系我们", []],
    ["报名入口", []]
  ]);
});

it("scopes public and account navigation without inventing children for direct links", () => {
  const items = Object.fromEntries(PUBLIC_PRIMARY_NAVIGATION.map((row) => [row.label, row]));
  expect(navigationHref(items["联系我们"], second)).toBe("/contact?event=second");
  expect(navigationHref(items["获奖查询"], second)).toBe("/admin/?view=certificates&eventId=E2");
  expect(navigationHref(items["报名入口"], second)).toBe("/admin/?view=eventCenter&eventId=E2");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -w apps/web -- --run apps/web/src/lib/__tests__/public-navigation.test.js`

Expected: FAIL because `PUBLIC_PRIMARY_NAVIGATION` and `navigationHref` do not exist.

- [ ] **Step 3: Implement the minimal navigation model**

Create literal configuration for the six approved primary entries. Use `/#services`, `/registration-guide`, `/about`, `/rules`, `/announcements`, `/news`, and `/history` for the child paths. Use `accountView: "certificates"` and `accountView: "eventCenter"` for the two account destinations.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test -w apps/web -- --run apps/web/src/lib/__tests__/public-navigation.test.js`

Expected: all tests in the file PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/public-navigation.js apps/web/src/lib/__tests__/public-navigation.test.js
git commit -m "refactor(web): model per-module public navigation"
```

---

### Task 2: 实现桌面分栏目抽屉与移动手风琴

**Files:**
- Modify: `apps/web/src/components/SiteHeader.jsx`
- Replace responsibility: `apps/web/src/components/PublicMegaDrawer.jsx`
- Test: `apps/web/src/__tests__/PublicMegaDrawer.test.jsx`
- Test: `apps/web/src/__tests__/Accessibility.test.jsx`
- Test: `apps/web/src/__tests__/router.test.jsx`

**Interfaces:**
- Consumes: `PUBLIC_PRIMARY_NAVIGATION` and `navigationHref(item, activeEvent)` from Task 1.
- Produces: header state `openGroupId: null | "home" | "about" | "news"` and `mobileOpen: boolean`.
- Component contract: the drawer renderer receives `{ item, open, activeEvent, currentPath, onClose }` and renders only `item.children`.

- [ ] **Step 1: Replace shared-drawer expectations with failing independent-group tests**

Add tests that prove:

```jsx
fireEvent.mouseEnter(screen.getByRole("button", { name: "首页" }));
expect(screen.getByRole("navigation", { name: "首页子导航" })).toBeVisible();
expect(screen.queryByRole("link", { name: "赛事章程" })).not.toBeInTheDocument();

fireEvent.click(screen.getByRole("button", { name: "关于大赛" }));
expect(screen.queryByRole("navigation", { name: "首页子导航" })).not.toBeInTheDocument();
expect(screen.getByRole("navigation", { name: "关于大赛子导航" })).toBeVisible();
```

Also assert:

- “获奖查询”“联系我们”“报名入口” are anchors without `aria-expanded`.
- `Escape` closes the active drawer and restores its own trigger focus.
- clicking outside closes the active drawer.
- route changes close any drawer.
- the mobile menu exposes three accordion buttons, direct links, then “用户登录”和“报名入口” in its action region.
- only one mobile accordion group can be expanded.

- [ ] **Step 2: Run the interaction tests and verify RED**

Run: `npm test -w apps/web -- --run apps/web/src/__tests__/PublicMegaDrawer.test.jsx apps/web/src/__tests__/Accessibility.test.jsx apps/web/src/__tests__/router.test.jsx`

Expected: FAIL because the current header has one menu trigger and one shared drawer.

- [ ] **Step 3: Implement independent desktop triggers and compact drawers**

In `SiteHeader.jsx`:

- derive the primary items from the shared model;
- render a `<button>` only when `children.length > 0` and an `<a>` for direct entries;
- keep hover open separate from click-locked state so a pointer can cross from trigger to drawer;
- use the active trigger ref for focus restoration;
- close on outside pointer, route change, link activation and `Escape`;
- remove the shared featured-event block and duplicated drawer navigation.

In the drawer renderer:

- render exactly one `<nav aria-label="${item.label}子导航">`;
- keep hidden/transitioning content inert;
- set `aria-current` using the normalized current public location.

- [ ] **Step 4: Implement the mobile accordion**

Use the existing hamburger trigger only below 1120px. Render all primary entries in order, but only the three grouped items as accordion buttons. Put account login and registration in a final `mobile-navigation-actions` region. Preserve body scroll locking and focus containment while the mobile menu is open.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -w apps/web -- --run apps/web/src/__tests__/PublicMegaDrawer.test.jsx apps/web/src/__tests__/Accessibility.test.jsx apps/web/src/__tests__/router.test.jsx`

Expected: all focused tests PASS with no act warnings.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/SiteHeader.jsx apps/web/src/components/PublicMegaDrawer.jsx apps/web/src/__tests__/PublicMegaDrawer.test.jsx apps/web/src/__tests__/Accessibility.test.jsx apps/web/src/__tests__/router.test.jsx
git commit -m "feat(web): add per-module public navigation drawers"
```

---

### Task 3: 重排官网头部并统一响应式视觉

**Files:**
- Modify: `apps/web/src/styles/navigation.css`
- Modify if required for shared tokens only: `apps/web/src/styles/tokens.css`
- Test: `apps/web/src/__tests__/Accessibility.test.jsx`

**Interfaces:**
- Consumes the semantic class names produced by Task 2.
- Produces desktop header grid/flex layout, anchored compact panels, mobile menu and action button styling.

- [ ] **Step 1: Add failing CSS contract tests**

Extend accessibility/build tests to load the real navigation stylesheet and assert computed behavior at 1440 and 390 widths:

- desktop primary navigation and account actions remain displayed;
- mobile brand name and hamburger become visible below 1120px;
- mobile direct links remain present rather than being removed with `.site-navigation`;
- navigation panels have a bounded inline size and the mobile panel does not exceed `100vw`.

The production break named by these tests is restoring the old `display:none` rule that removes the full mobile information architecture or a full-width panel that overflows the viewport.

- [ ] **Step 2: Run the CSS/accessibility tests and verify RED**

Run: `npm test -w apps/web -- --run apps/web/src/__tests__/Accessibility.test.jsx`

Expected: FAIL against the existing full-width `.public-mega-drawer` layout.

- [ ] **Step 3: Implement the blue-white aligned header**

- Align `.site-header-inner` with `var(--content-max)`.
- Keep brand left, grouped navigation centered, and `.header-actions` right.
- Style user login as the secondary white button and registration as the high-contrast primary button.
- Position each desktop panel relative to its `.primary-navigation-item`, using `max-inline-size: min(22rem, calc(100vw - 2rem))` and edge-safe alignment.
- Use consistent 44px minimum interactive height, focus ring, radius and spacing variables.
- Make the mobile overlay occupy the available viewport below the header, allow vertical scroll, and prevent horizontal overflow.
- Respect `prefers-reduced-motion: reduce`.

- [ ] **Step 4: Run CSS/accessibility tests and verify GREEN**

Run: `npm test -w apps/web -- --run apps/web/src/__tests__/Accessibility.test.jsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/styles/navigation.css apps/web/src/styles/tokens.css apps/web/src/__tests__/Accessibility.test.jsx
git commit -m "style(web): align responsive public header"
```

---

### Task 4: 统一前台内容类别名称

**Files:**
- Create: `apps/web/src/lib/public-content-labels.js`
- Modify: `apps/web/src/pages/HomePage.jsx`
- Modify: `apps/web/src/pages/ContentListPage.jsx`
- Modify: `apps/web/src/pages/ContentDetailPage.jsx`
- Modify: `apps/web/src/pages/EventDetailPage.jsx`
- Modify: `apps/web/src/lib/public-event-content.js`
- Test: `apps/web/src/__tests__/HomePage.test.jsx`
- Test: `apps/web/src/__tests__/Accessibility.test.jsx`
- Test: `apps/web/src/__tests__/PublicPages.test.jsx`

**Interfaces:**
- Produces: `PUBLIC_CONTENT_TYPE_LABELS = { announcement: "通知公告", news: "新闻动态", recap: "赛事回顾", work: "优秀作品", guide: "参赛指南" }`.
- Produces: `publicContentTypeLabel(type)` with safe fallback to the original type string.

- [ ] **Step 1: Write failing front-end naming tests**

Assert consumer-visible behavior rather than source text:

- homepage headings contain “通知公告”和“新闻动态”;
- `/announcements` document/page title is “通知公告”;
- `/news` page heading is “新闻动态与优秀作品” or the approved equivalent containing “新闻动态”;
- event detail renders `announcement` as “通知公告”, `news` as “新闻动态”, and `recap` as “赛事回顾”;
- fallback descriptions say “通知公告、新闻动态与优秀作品详情”.

- [ ] **Step 2: Run front-end naming tests and verify RED**

Run: `npm test -w apps/web -- --run apps/web/src/__tests__/HomePage.test.jsx apps/web/src/__tests__/Accessibility.test.jsx apps/web/src/__tests__/PublicPages.test.jsx`

Expected: FAIL because several pages still render “赛事公告” and “赛事动态”.

- [ ] **Step 3: Implement shared labels and update all front-end consumers**

Import the shared mapping where content types are rendered. Replace human-facing fallback copy, SEO titles and default descriptions. Do not change route names or API query values.

- [ ] **Step 4: Run front-end naming tests and verify GREEN**

Run the same command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/public-content-labels.js apps/web/src/pages apps/web/src/lib/public-event-content.js apps/web/src/__tests__
git commit -m "refactor(web): unify public content names"
```

---

### Task 5: 统一后台内容类别名称

**Files:**
- Create: `apps/admin/src/lib/content-type-labels.js`
- Modify: `apps/admin/src/components/ContentListPanel.vue`
- Modify: `apps/admin/src/components/ContentEditorPanel.vue`
- Modify: `apps/admin/src/components/ContentImportPanel.vue`
- Modify: `apps/admin/src/components/ContentPublicationReview.vue`
- Test: `apps/admin/src/components/__tests__/ContentListPanel.test.js`
- Test: `apps/admin/src/components/__tests__/ContentEditorPanel.test.js`
- Test: `apps/admin/src/components/__tests__/ContentImportPanel.test.js`
- Test: `apps/admin/src/components/__tests__/ContentPublicationReview.test.js`

**Interfaces:**
- Produces: `CONTENT_TYPE_OPTIONS` ordered as announcement, news, work, recap, guide.
- Produces: `CONTENT_TYPE_LABELS` mapping `announcement` to “通知公告”, `news` to “新闻动态”, and `recap` to “赛事回顾”.

- [ ] **Step 1: Write failing admin naming tests**

Render the real components and assert:

- list filter and row badge display “通知公告”“新闻动态”“赛事回顾”;
- editor and import selectors expose the same labels while option values remain `announcement`, `news`, `recap`;
- publication review renders the same label for the selected content type;
- empty guidance says “新闻动态、通知公告或赛事资料”.

- [ ] **Step 2: Run admin naming tests and verify RED**

Run: `npm test -w apps/admin -- apps/admin/src/components/__tests__/ContentListPanel.test.js apps/admin/src/components/__tests__/ContentEditorPanel.test.js apps/admin/src/components/__tests__/ContentImportPanel.test.js apps/admin/src/components/__tests__/ContentPublicationReview.test.js`

Expected: FAIL because admin labels are currently “公告”“新闻”“回顾”.

- [ ] **Step 3: Implement the shared admin label module**

Replace component-local label maps with imports from `content-type-labels.js`. Preserve the existing option values and form payloads exactly.

- [ ] **Step 4: Run admin naming tests and verify GREEN**

Run the same command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/content-type-labels.js apps/admin/src/components apps/admin/src/components/__tests__
git commit -m "refactor(admin): unify content type labels"
```

---

### Task 6: 全量验证、浏览器验收与部署

**Files:**
- Modify only if verification exposes a regression: files already listed in Tasks 1–5.
- Update: `.superpowers/sdd/2026-08-12-public-drawer-navigation/final-fix-report.md` or create a new adjacent verification report for this iteration.

**Interfaces:**
- Consumes the completed feature branch.
- Produces a tested commit, a deployed Docker release SHA, rollback artifacts and live browser evidence.

- [ ] **Step 1: Run the complete local test and build suite**

```bash
npm test -w apps/web -- --run
npm test -w apps/admin
npm test -w apps/api
npm run build
git diff --check
```

Expected: all tests PASS, build exits 0, and `git diff --check` has no output.

- [ ] **Step 2: Browser-test the local production build**

At 1440px verify all three desktop drawers independently, direct links, login/registration alignment, outside click, hover bridge, keyboard Enter/Tab/Escape and focus restoration. At 1024px and 768px verify the breakpoint. At 390px verify the mobile accordion, fixed information architecture, button order, vertical scroll and no horizontal overflow.

- [ ] **Step 3: Commit verification evidence**

Record exact test counts, viewport results, current commit and any accepted limitations in the verification report, then commit:

```bash
git add .superpowers/sdd/2026-08-12-public-drawer-navigation
git commit -m "test(web): verify per-module public navigation"
```

- [ ] **Step 4: Create rollback-safe server backups**

Over SSH, save a timestamped PostgreSQL dump, uploads archive and source archive under `/opt/aerogp/backups`. Record the current `.release` SHA and tag the currently running API/web images with that SHA before rebuilding.

- [ ] **Step 5: Deploy the exact tested commit**

Archive the commit, copy it to `/opt/aerogp`, preserve server `.env`, backups and uploads, set `RELEASE_SHA` to the commit, then run:

```bash
docker compose build api web
docker compose up -d api web
```

Do not prune volumes or database data.

- [ ] **Step 6: Run live smoke and browser verification**

Verify:

- `https://aerogp.cn/`, `/about`, `/announcements`, `/news`, `/history`, `/contact`, `/admin/` return expected 200/auth behavior;
- API/web release markers equal the deployed commit;
- administrator login and public bootstrap smoke pass;
- the live desktop and mobile navigation match the local browser evidence;
- backend content labels show “通知公告”“新闻动态”“赛事回顾”.

- [ ] **Step 7: Mark release and report rollback points**

Write the tested commit to `/opt/aerogp/.release`, confirm containers are healthy, and report backup file paths, deployed SHA and live URL.
