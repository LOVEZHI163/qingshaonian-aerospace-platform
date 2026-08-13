# 大赛章程在线查看与下载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在温州 2026 赛事“大赛章程”页增加 PDF 在线查看和 DOC 原文件下载入口。

**Architecture:** 赛事内容配置声明可选 `document` 元数据，`buildPublicEventContent` 将其传给公开页模型，`EventInformationPage` 渲染独立文档卡片。原 DOC 和转换后的 PDF 作为 Vite public 静态资源随 Web 镜像部署。

**Tech Stack:** React、Vitest/Testing Library、Vite、LibreOffice、Poppler、Docker Compose。

## Global Constraints

- 仅 `wz-aerospace-2026` 的 `rules` 页面显示章程文件卡片。
- 在线查看必须在新标签页打开 PDF，并设置 `rel="noopener"`。
- 下载入口必须保留原始 DOC，下载名为 `2026年温州市青少年航空航天创新比赛大赛章程.doc`。
- PDF 必须完成逐页渲染检查后才能部署。

---

### Task 1: 章程资源与页面入口

**Files:**
- Create: `apps/web/public/documents/wz-aerospace-2026-rules.doc`
- Create: `apps/web/public/documents/wz-aerospace-2026-rules.pdf`
- Modify: `apps/web/src/content/wz-aerospace-2026.js`
- Modify: `apps/web/src/lib/public-event-content.js`
- Modify: `apps/web/src/pages/EventInformationPage.jsx`
- Modify: `apps/web/src/styles/event-information.css`
- Test: `apps/web/src/__tests__/PublicPages.test.jsx`

**Interfaces:**
- Consumes: `WZ_AEROSPACE_2026_COPY.rulesDocument`，包含 `title`、`previewUrl`、`downloadUrl`、`downloadName`。
- Produces: `buildPublicEventContent(...).document`，供页面文档卡片使用。

- [ ] **Step 1: 写失败测试**

在 `PublicPages.test.jsx` 中渲染 `/rules?event=wz-aerospace-2026`，断言存在“在线查看章程”和“下载章程原文件”；PDF 链接具有 `target="_blank"` 与 `rel="noopener"`，DOC 链接具有中文 `download` 属性。再渲染其他赛事规则页，断言卡片不存在。

- [ ] **Step 2: 验证 RED**

运行 `pnpm --filter @aerogp/web test -- PublicPages.test.jsx`，预期因入口尚未实现而失败。

- [ ] **Step 3: 转换并验证文档**

复制原 DOC 到 public 目录，使用 LibreOffice 转换 PDF；用 `pdfinfo` 核对页数、用 `pdftotext` 核对正文，并用 `pdftoppm` 渲染全部页面进行视觉检查。

- [ ] **Step 4: 最小实现**

将 `rulesDocument` 加入赛事内容配置；模型只在 `rules` 区段返回 `document`；页面渲染文档卡片并增加响应式样式。

- [ ] **Step 5: 验证 GREEN**

运行聚焦测试、Web 全量测试、根目录构建和 `git diff --check`，全部必须通过。

- [ ] **Step 6: 提交**

提交消息：`feat(web): add rules document preview and download`。

### Task 2: 安全部署与线上验收

**Files:**
- Verify: `scripts/deploy/*`
- Verify: `scripts/smoke-test.sh`

**Interfaces:**
- Consumes: Task 1 的 Git 提交归档。
- Produces: `https://aerogp.cn/rules?event=wz-aerospace-2026`、PDF 与 DOC 的线上可访问版本。

- [ ] **Step 1: 部署前保护**

记录当前 release，备份数据库、上传文件和服务器源码，并检查磁盘空间。

- [ ] **Step 2: 构建并切换**

上传 Git archive 到服务器 staging 目录，预检后构建 Web/API 镜像并切换服务。

- [ ] **Step 3: 验证线上服务**

执行 release 验证和完整 smoke；请求规则页、PDF、DOC，要求全部返回 200，PDF 为 `application/pdf`，DOC 内容长度非零。

- [ ] **Step 4: 完成 release 标记**

仅在全部验证通过后写入新 commit 的 `.release`，并再次确认健康状态。

