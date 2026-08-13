# 大赛介绍与组织机构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在温州 2026 赛事简介页增加全宽的“大赛介绍”和“组织机构”模块。

**Architecture:** 在赛事专属内容配置中加入两个带 `wide: true` 的 section；公共内容规范化函数保留该布局元数据；页面组件将元数据映射为 CSS 类，由既有两列栅格控制桌面全宽与移动单列。

**Tech Stack:** React、Vitest、Testing Library、CSS Grid、Vite。

## Global Constraints

- 仅修改 `wz-aerospace-2026` 的专属内容。
- 使用用户提供的正式文字，不改写机构名称。
- 新增模块位于事实卡片之后、现有短内容卡片之前。
- 桌面全宽、移动单列且不得产生横向溢出。

---

### Task 1: 新增正式内容与全宽布局语义

**Files:**
- Modify: `apps/web/src/content/wz-aerospace-2026.js`
- Modify: `apps/web/src/lib/public-event-content.js`
- Modify: `apps/web/src/pages/EventInformationPage.jsx`
- Modify: `apps/web/src/styles/event-information.css`
- Test: `apps/web/src/lib/__tests__/public-event-content.test.js`
- Test: `apps/web/src/__tests__/PublicPages.test.jsx`
- Test: `apps/web/src/__tests__/BuildClean.test.js`

**Interfaces:**
- Consumes: `buildPublicEventContent(section, { event, detail, site })`。
- Produces: section 可选字段 `wide: boolean`，页面类名 `event-information-section-wide`。

- [ ] **Step 1: Write the failing tests**

断言温州赛事 `about` 的前两个 section 为“大赛介绍”和“组织机构”、正文完整且 `wide: true`；断言页面对应 article 带全宽类；断言 CSS 将该类设置为 `grid-column: 1 / -1`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run apps/web/src/lib/__tests__/public-event-content.test.js apps/web/src/__tests__/PublicPages.test.jsx apps/web/src/__tests__/BuildClean.test.js`

Expected: FAIL，原因是新增内容和全宽类尚不存在。

- [ ] **Step 3: Write minimal implementation**

在赛事专属配置中加入两个 `wide: true` section；在 `normalizedSection` 中保留该布尔值；在页面 article 上按值添加 `event-information-section-wide`；CSS 设置 `grid-column: 1 / -1`。

- [ ] **Step 4: Run focused and full verification**

Run: `npm test -- --run apps/web/src/lib/__tests__/public-event-content.test.js apps/web/src/__tests__/PublicPages.test.jsx apps/web/src/__tests__/BuildClean.test.js`

Run: `npm test -- --run`

Run: `npm run build`

Expected: 全部通过且构建成功。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/content/wz-aerospace-2026.js apps/web/src/lib/public-event-content.js apps/web/src/pages/EventInformationPage.jsx apps/web/src/styles/event-information.css apps/web/src/lib/__tests__/public-event-content.test.js apps/web/src/__tests__/PublicPages.test.jsx apps/web/src/__tests__/BuildClean.test.js docs/superpowers/specs/2026-08-13-about-introduction-organization-design.md docs/superpowers/plans/2026-08-13-about-introduction-organization.md
git commit -m "feat(web): add event introduction and organization"
```
