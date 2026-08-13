# 大赛章程原文内嵌 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用《大赛章程》完整原文替换公开章程页的三张摘要卡，移除在线预览入口，仅保留原文件下载。

**Architecture:** 章程原文以结构化章节数据保存在现有赛事专属内容文件中，由公开内容模型透传给通用赛事信息页。页面在赛事事实信息之后渲染单一文档正文容器；其他赛事及其他公开信息页继续使用原有通用卡片结构。

**Tech Stack:** React 18、Vite、Vitest、Testing Library、CSS。

## Global Constraints

- 原文内容以 `赛事方案/大赛章程.doc` 为准，不改写章程措辞。
- 删除“在线查看章程”，保留 `.doc` 原文件下载。
- 不影响其他赛事和其他公开信息页面。
- 移动端按单列正文展示，不出现横向溢出。

---

### Task 1: 章程数据与页面展示

**Files:**
- Modify: `apps/web/src/__tests__/PublicPages.test.jsx`
- Modify: `apps/web/src/content/wz-aerospace-2026.js`
- Modify: `apps/web/src/pages/EventInformationPage.jsx`
- Modify: `apps/web/src/styles/event-information.css`
- Modify: `apps/web/src/__tests__/BuildClean.test.js`

**Interfaces:**
- Consumes: `WZ_AEROSPACE_2026_COPY.rulesDocument`
- Produces: `rulesDocument.chapters[]`，每章包含 `heading`、`paragraphs`、可选 `items` 和 `signature`

- [ ] **Step 1: 写失败测试**

断言章程页展示第一章至第九章、完整关键原文和下载链接；不再展示摘要卡及“在线查看章程”；事实信息排在正文之前。

- [ ] **Step 2: 验证 RED**

Run: `npm test -w apps/web -- --run apps/web/src/__tests__/PublicPages.test.jsx`

Expected: FAIL，原因是完整章节尚未渲染且在线预览仍存在。

- [ ] **Step 3: 最小实现**

将九章原文写入赛事专属结构化数据；通用页面在 facts 后渲染正文，章程页不再渲染摘要卡；CSS 提供文档标题、章节分隔、列表和移动端布局。

- [ ] **Step 4: 验证 GREEN**

Run: `npm test -w apps/web -- --run apps/web/src/__tests__/PublicPages.test.jsx apps/web/src/__tests__/BuildClean.test.js`

Expected: PASS。

- [ ] **Step 5: 全量验证、提交与部署**

Run: `npm test -w apps/web -- --run && npm run build && git diff --check`

Expected: 全部通过；随后提交，备份线上数据并部署该精确提交。
