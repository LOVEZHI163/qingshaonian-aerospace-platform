# 官网图片媒体管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox state and must be verified before completion.

**Goal:** 在“官网内容”内增加独立的图片媒体管理页，让平台管理员可以查询图片引用、预览下载、安全替换、单张或批量删除未引用图片。

**Architecture:** 保留现有 `media_assets` 与磁盘目录结构，以 API 服务层统一计算引用清单和迁移引用；后台新增一个媒体管理面板并复用现有管理员鉴权。替换操作创建新媒体记录，再原子迁移数据库引用，最后清理旧文件，避免已发布页面出现断图。

**Tech Stack:** Node.js、Express、Vue 3、Vitest、Node test runner、现有 JSON/PostgreSQL store abstraction、Sharp。

## Global Constraints

- 仅管理官网图片，不包含参赛作品、视频、证书或组织资质文件。
- 保持现有 `GET /api/admin/site-media?kind=image&limit=100&q=` 调用兼容。
- 被引用图片禁止直接删除；替换必须迁移全部引用。
- 每个任务先写失败测试，再写最小实现，并运行聚焦测试。
- 不修改生产服务器，直到本地全量测试与构建通过。

---

## Task 1: 媒体引用清单与管理列表

**Files:**
- Modify: `apps/api/src/services/site-media.js`
- Modify: `apps/api/src/routes/site-media.js`
- Test: `apps/api/test/site-media.test.js`

- [ ] 为首页主视觉、分享图、赛事封面、文章封面、文章附件和正文图片补充结构化引用测试。
- [ ] 为分页、用途、赛事、引用状态筛选和汇总数据补充 API 失败测试。
- [ ] 实现 `mediaReferences`，并让旧的 `mediaReference` 保持兼容。
- [ ] 扩展列表 DTO、分页和 summary，同时保留旧查询返回 `rows` 的行为。
- [ ] 运行 `node --test test/site-media.test.js`。

## Task 2: 下载与安全批量删除

**Files:**
- Modify: `apps/api/src/routes/site-media.js`
- Test: `apps/api/test/site-media.test.js`

- [ ] 添加管理员下载原图的鉴权、文件名和安全响应测试。
- [ ] 添加最多 100 张的批量删除测试，覆盖未引用删除、被引用跳过、重复 ID 和无效输入。
- [ ] 抽取复用的安全删除函数，保持单张删除原有语义。
- [ ] 实现下载和批量删除路由。
- [ ] 运行聚焦 API 测试。

## Task 3: 安全替换图片并迁移引用

**Files:**
- Modify: `apps/api/src/services/site-media.js`
- Modify: `apps/api/src/routes/site-media.js`
- Test: `apps/api/test/site-media.test.js`

- [ ] 添加全部引用类型迁移、正文 HTML 替换和无引用替换测试。
- [ ] 添加新文件保存失败、数据库写入失败时旧媒体仍可用的回滚测试。
- [ ] 实现引用迁移函数和 `POST /api/admin/site-media/:id/replace`。
- [ ] 确保新媒体继承旧媒体的用途、赛事和可见性，并返回新 ID 与迁移数量。
- [ ] 运行聚焦 API 测试。

## Task 4: 后台媒体管理面板

**Files:**
- Create: `apps/admin/src/components/SiteMediaManagementPanel.vue`
- Create: `apps/admin/src/components/__tests__/SiteMediaManagementPanel.test.js`
- Modify: `apps/admin/src/styles/admin.css`

- [ ] 添加列表加载、筛选、分页、引用详情、预览下载、替换、删除和批量操作组件测试。
- [ ] 实现统计卡、筛选栏、响应式图片网格、引用详情和操作反馈。
- [ ] 单张及批量删除必须明确显示跳过原因；替换使用文件选择器并要求确认。
- [ ] 760px 以下单列显示，关键按钮触控高度不少于 44px。
- [ ] 运行组件聚焦测试。

## Task 5: 集成“媒体管理”页签

**Files:**
- Modify: `apps/admin/src/pages/SiteContentPage.vue`
- Modify: `apps/admin/src/pages/__tests__/SiteContentPage.test.js`

- [ ] 添加第四页签、键盘导航和只在该页显示媒体管理面板的测试。
- [ ] 集成面板，避免媒体页受草稿预览按钮影响。
- [ ] 刷新按钮在媒体页刷新媒体列表。
- [ ] 运行 `SiteContentPage` 聚焦测试与 admin 全量测试。

## Task 6: 全量验证与部署

**Files:**
- Update: `docs/superpowers/plans/2026-08-14-site-media-management.md`（记录验证结果）

- [ ] 运行 API、admin、web 全量测试。
- [ ] 运行根目录构建和 `git diff --check`。
- [ ] 在本地真实浏览器验证桌面与 390px 移动端媒体管理主流程。
- [ ] 审查变更并提交代码。
- [ ] 部署到 ECS，运行 release verify 和远端 smoke。
- [ ] 在 `https://aerogp.cn/admin/?view=siteContent` 验证“媒体管理”页签、列表与安全操作入口。

