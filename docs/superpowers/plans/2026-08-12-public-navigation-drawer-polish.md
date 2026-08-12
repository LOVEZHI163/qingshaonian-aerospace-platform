# 官网导航抽屉视觉统一实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将三个桌面子抽屉统一为 240px 宽、48px 行高和 16px/600 字体，同时保留既有文案、链接、键盘与移动端行为。

**Architecture:** 继续以 `PUBLIC_PRIMARY_NAVIGATION` 作为唯一导航数据源，仅在共享 `navigation.css` 中收紧桌面抽屉视觉契约。通过现有 CSS 计算测试先建立失败断言，再以最小样式变更通过测试，最后进行全量回归、真实浏览器检查和服务器发布。

**Tech Stack:** React 19、Vite 7、Vitest、Testing Library、CSS、Docker Compose、Caddy。

## Global Constraints

- 文案与链接保持：主页组“赛事服务 / 报名流程 / 关于大赛”，关于组“大赛简介 / 大赛章程”，资讯组“通知公告 / 新闻动态 / 赛事回顾”。
- 桌面抽屉宽度 `15rem`，子项最小高度 `3rem`，字号 `1rem`，字重 `600`。
- 移动端现有手风琴结构和交互不得改变。
- 不修改路由、接口、数据库、后台或业务权限。

---

### Task 1: 建立桌面抽屉视觉回归测试

**Files:**
- Modify: `apps/web/src/__tests__/Accessibility.test.jsx`

**Interfaces:**
- Consumes: `navigationStyleAt(selector, options)` 现有 CSS 计算辅助函数。
- Produces: 桌面抽屉宽度、内边距和链接排版的稳定测试契约。

- [ ] **Step 1: 写入失败断言**

在桌面导航样式用例中断言 `.public-mega-drawer` 的 `inline-size` 为 `15rem`，`.public-mega-drawer-inner` 的 `padding` 为 `0.625rem`，`.public-mega-drawer a` 的 `min-height`、`font-size`、`font-weight` 分别为 `3rem`、`1rem`、`600`。

- [ ] **Step 2: 验证测试按预期失败**

Run: `npm test -w apps/web -- --run src/__tests__/Accessibility.test.jsx`

Expected: FAIL，实际抽屉宽度仍为 `max-content`，链接高度与字重仍为旧值。

- [ ] **Step 3: 提交测试契约与设计文档**

```powershell
git add apps/web/src/__tests__/Accessibility.test.jsx docs/superpowers/specs/2026-08-12-public-navigation-drawer-polish-design.md docs/superpowers/plans/2026-08-12-public-navigation-drawer-polish.md
git commit -m "test(web): define compact drawer visual contract"
```

### Task 2: 统一桌面抽屉视觉

**Files:**
- Modify: `apps/web/src/styles/navigation.css`

**Interfaces:**
- Consumes: Task 1 的 CSS 计算断言。
- Produces: 所有桌面分组共用的固定宽度单列子抽屉。

- [ ] **Step 1: 实施最小样式变更**

将 `.public-mega-drawer` 的 `inline-size` 改为 `15rem`，保留视口最大宽度限制；统一完整圆角与轻微顶间距；将内边距设为 `0.625rem`；链接占满宽度并设置 `min-height: 3rem`、`font-size: 1rem`、`font-weight: 600`。

- [ ] **Step 2: 验证聚焦测试通过**

Run: `npm test -w apps/web -- --run src/__tests__/Accessibility.test.jsx src/__tests__/PublicMegaDrawer.test.jsx src/lib/__tests__/public-navigation.test.js`

Expected: PASS。

- [ ] **Step 3: 运行前端全量回归与构建**

Run: `npm test -w apps/web -- --run`

Run: `npm run build`

Expected: 全部 PASS，构建退出码 0。

- [ ] **Step 4: 提交实现**

```powershell
git add apps/web/src/styles/navigation.css
git commit -m "fix(web): polish public navigation drawers"
```

### Task 3: 浏览器验收与部署

**Files:**
- Modify: `.superpowers/sdd/2026-08-12-per-module-public-navigation/task-6-report.md`（如存在且用于当前发布记录）

**Interfaces:**
- Consumes: Task 2 的前端构建产物。
- Produces: `aerogp.cn` 上已验证的新版导航抽屉。

- [ ] **Step 1: 本地浏览器验收**

在 1440px 和 1329px 分别打开首页，依次展开三个抽屉，确认宽度一致、文字排版一致、无裁切；在 390px 确认手风琴导航无横向滚动。

- [ ] **Step 2: 构建并发布同一版本的 Web 与 API 镜像**

使用服务器既有 SSH、Docker Compose 和 Caddy 发布流程，以当前提交 SHA 作为 `RELEASE_SHA`，不迁移数据、不重建数据库卷。

- [ ] **Step 3: 线上验收**

检查 `https://aerogp.cn/` 三个抽屉、移动菜单、`/api/health` 和发布版本标记均正常。

- [ ] **Step 4: 记录发布结果并提交**

```powershell
git add .superpowers/sdd/2026-08-12-per-module-public-navigation/task-6-report.md
git commit -m "docs(web): record drawer polish rollout"
```
