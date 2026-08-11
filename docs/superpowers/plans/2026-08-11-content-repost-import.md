# 官网内容快速转载 Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在“官网内容 → 内容发布”中加入安全、可预检查、可编辑的微信公众号与公开新闻网页转载流程，抓取正文和图片后只保存为草稿，并在公开详情页明确显示来源。

**Architecture:** 新增一个独立的内容导入子系统。API 先通过 SSRF 防护抓取 HTML，使用 Readability 与微信专用规则提取文章，把图片下载到有期限的暂存目录并持久化导入批次；管理员确认后，服务端把选中的图片转成现有 `media_assets`，重写正文图片地址，最后在一次数据库变更中创建草稿与来源信息。管理端使用“粘贴链接 → 预检查 → 保存草稿”三步界面；公开端只消费已进入 `content_posts` 的来源字段，不接触导入批次。

**Tech Stack:** Node.js/Express、PostgreSQL、`node:http`/`node:https`、`dns/promises`、`@mozilla/readability`、`jsdom`、Sharp、Vue 3/Vitest、React 18/Vitest。

---

## 数据和接口约定

正式内容新增字段：

```js
{
  sourceUrl: null,
  sourceUrlFingerprint: null,
  sourceName: "",
  sourceAuthor: "",
  sourcePublishedAt: null,
  importedAt: null
}
```

导入批次在 `db.siteContentImportBatches` 中使用以下形状：

```js
{
  id: "SCI...",
  createdBy: "U...",
  sourceUrl: "https://...",
  normalizedSourceUrl: "https://...",
  sourceUrlFingerprint: "sha256-hex",
  sourceType: "wechat" | "web",
  sourceName: "来源名称",
  sourceAuthor: "作者",
  sourcePublishedAt: null,
  title: "标题",
  summary: "摘要",
  bodyTemplateHtml: "<p>...<img src=\"@@SITE_IMPORT_IMAGE:IMG1@@\"></p>",
  warnings: [],
  images: [{
    id: "IMG1",
    originalUrl: "https://...",
    resolvedUrl: "https://...",
    originalName: "image.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 123,
    width: 1200,
    height: 800,
    stagePath: "/data/uploads/site-content-import-staging/SCI.../IMG1.jpg",
    status: "ready" | "filtered" | "failed" | "deleted",
    reasonCode: null,
    reason: ""
  }],
  status: "ready" | "committed" | "cancelled" | "expired",
  createdAt: "ISO",
  expiresAt: "ISO"
}
```

管理接口：

```text
POST   /api/admin/content-imports/inspect
GET    /api/admin/content-imports/:batchId/images/:imageId
POST   /api/admin/content-imports/:batchId/images/:imageId/retry
DELETE /api/admin/content-imports/:batchId/images/:imageId
POST   /api/admin/content-imports/:batchId/commit
DELETE /api/admin/content-imports/:batchId
```

所有失败均返回既有 `{ message, code }` JSON 错误格式；UI 只按 `code` 映射稳定中文提示。

---

### Task 1: 加入文章解析依赖与测试夹具

**Files:**
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`
- Create: `apps/api/test/fixtures/site-content-import/wechat-article.html`
- Create: `apps/api/test/fixtures/site-content-import/generic-news.html`
- Create: `apps/api/test/fixtures/site-content-import/malicious-page.html`

**Step 1: 添加依赖声明**

在 API 运行时依赖中加入：

```json
"@mozilla/readability": "^0.6.0",
"jsdom": "^26.1.0"
```

使用与当前 Node 运行环境兼容的锁定版本；不要依赖管理端的 devDependency。

**Step 2: 添加最小但真实的 HTML 夹具**

- 微信夹具包含 `#js_content`、`#activity-name`、`#js_name`、`publish_time`、正文图片的 `data-src`。
- 通用新闻夹具包含 `<article>`、Open Graph、JSON-LD `NewsArticle`、正文图和装饰图。
- 恶意夹具包含脚本、iframe、事件属性、跟踪像素和外链视频。

**Step 3: 安装并确认锁文件**

Run: `npm install --no-audit --no-fund`

Expected: `package-lock.json` 只新增解析依赖及其传递依赖。

**Step 4: Commit**

```bash
git add apps/api/package.json package-lock.json apps/api/test/fixtures/site-content-import
git commit -m "build: add content import parser dependencies"
```

### Task 2: 实现 URL 规范化与 SSRF 地址策略

**Files:**
- Create: `apps/api/src/services/site-content-import/url-policy.js`
- Create: `apps/api/test/site-content-import-url-policy.test.js`

**Step 1: 写失败测试**

覆盖：

- 仅允许 `http:`/`https:`，禁止用户名密码、非 80/443 端口和无主机名 URL。
- 删除 fragment、规范 hostname 大小写、移除默认端口、排序查询参数并去除 `utm_*`、`spm` 等跟踪参数。
- IPv4 loopback/private/link-local/CGNAT/metadata 与 IPv6 loopback/link-local/ULA/IPv4-mapped 均拒绝。
- DNS 返回的任一 A/AAAA 是非公网地址时整次请求拒绝，不能只挑一个公网地址绕过。
- 规范化 URL 的 SHA-256 指纹稳定一致。

测试接口：

```js
normalizeImportUrl(rawUrl)
sourceUrlFingerprint(normalizedUrl)
isPublicAddress(address)
resolvePublicImportTarget(url, { lookup })
```

**Step 2: 运行测试确认失败**

Run: `npm test -w apps/api -- test/site-content-import-url-policy.test.js`

Expected: FAIL，模块不存在。

**Step 3: 最小实现**

返回固定结构，供后续抓取器 pin DNS：

```js
{
  url: new URL(normalizedUrl),
  hostname,
  addresses: [{ address, family }],
  selectedAddress: { address, family }
}
```

阻断错误统一使用 `code = "IMPORT_URL_INVALID"` 或 `"IMPORT_URL_BLOCKED"`，并附 `status = 422`。

**Step 4: 运行测试**

Run: `npm test -w apps/api -- test/site-content-import-url-policy.test.js`

Expected: PASS。

**Step 5: Commit**

```bash
git add apps/api/src/services/site-content-import/url-policy.js apps/api/test/site-content-import-url-policy.test.js
git commit -m "feat: enforce safe content import urls"
```

### Task 3: 实现带 DNS pinning 的公网资源抓取器

**Files:**
- Create: `apps/api/src/services/site-content-import/public-fetch.js`
- Create: `apps/api/test/site-content-import-public-fetch.test.js`

**Step 1: 写失败测试**

使用本地假 transport/lookup，不访问公网，覆盖：

- 请求连接使用已验证的 IP，但 `Host` 和 TLS `servername` 保留原域名。
- 每次重定向都重新规范化、解析并验证，最多 3 跳。
- 总超时 10 秒。
- HTML 解压后最多 5 MB；图片按调用方传入的 5 MB 上限读取。
- 仅接受预期 Content-Type；HTML 非文本返回 `IMPORT_UNSUPPORTED_CONTENT`。
- 超时、超限分别返回 `IMPORT_FETCH_TIMEOUT`、`IMPORT_RESPONSE_TOO_LARGE`。

目标接口：

```js
fetchPublicResource(rawUrl, {
  expected: "html" | "image",
  maxBytes,
  timeoutMs = 10_000,
  maxRedirects = 3,
  resolveTarget = resolvePublicImportTarget,
  transport
})
```

**Step 2: 确认失败**

Run: `npm test -w apps/api -- test/site-content-import-public-fetch.test.js`

Expected: FAIL。

**Step 3: 最小实现**

使用 `node:http`/`node:https`，通过 request `lookup` 回调 pin 住 `selectedAddress`；支持 gzip/deflate/br 解压并对解压后字节计数。返回：

```js
{ finalUrl, status, headers, buffer }
```

不要使用全局 `fetch`，避免 DNS 校验后连接时再次解析造成 rebinding。

**Step 4: 运行测试**

Run: `npm test -w apps/api -- test/site-content-import-public-fetch.test.js`

Expected: PASS。

**Step 5: Commit**

```bash
git add apps/api/src/services/site-content-import/public-fetch.js apps/api/test/site-content-import-public-fetch.test.js
git commit -m "feat: add pinned public resource fetcher"
```

### Task 4: 提取微信与通用新闻正文

**Files:**
- Create: `apps/api/src/services/site-content-import/article-extractor.js`
- Create: `apps/api/test/site-content-import-article-extractor.test.js`

**Step 1: 写失败测试**

基于 Task 1 夹具验证：

- 微信优先读取 `#activity-name`、`#js_name`、`#js_content`、微信发布时间和 `data-src`。
- 通用页面优先 JSON-LD/Open Graph，再用 Readability 回退。
- 输出标题、摘要、作者、来源名、原发布时间、正文模板、图片候选。
- 正文脚本、iframe、form、style、事件属性和外部视频被移除。
- B 站 iframe 也不保留；导入后仍由现有单独的 B 站按钮插入。
- 无可识别正文返回 `IMPORT_ARTICLE_NOT_FOUND`。

目标接口：

```js
extractImportedArticle({ html, finalUrl })
// -> { sourceType, title, summary, sourceName, sourceAuthor,
//      sourcePublishedAt, bodyHtml, images }
```

**Step 2: 确认失败**

Run: `npm test -w apps/api -- test/site-content-import-article-extractor.test.js`

Expected: FAIL。

**Step 3: 最小实现**

用 JSDOM 构建 DOM；把相对 URL 转为绝对 URL；每个正文图片替换为唯一 token：

```html
<img src="@@SITE_IMPORT_IMAGE:IMG1@@" alt="...">
```

先移除危险节点与属性，再仅保留与 `sanitizeContentHtml` 相容的标签。不要把外部图片 URL直接返回给管理端 HTML，避免浏览器自行请求第三方。

**Step 4: 运行测试**

Run: `npm test -w apps/api -- test/site-content-import-article-extractor.test.js`

Expected: PASS。

**Step 5: Commit**

```bash
git add apps/api/src/services/site-content-import/article-extractor.js apps/api/test/site-content-import-article-extractor.test.js
git commit -m "feat: extract imported article content"
```

### Task 5: 建立导入批次数据库模型

**Files:**
- Create: `apps/api/src/data/migrations/016-site-content-imports.sql`
- Modify: `apps/api/src/data/schema.sql`
- Modify: `apps/api/src/data/seed.js`
- Modify: `apps/api/src/data/postgres-store.js`
- Modify: `apps/api/test/postgres-store.test.js`

**Step 1: 写失败测试**

扩展 PostgreSQL store round-trip 测试，断言：

- `content_posts` 的六个来源字段能读写。
- `site_content_import_batches` 能把 `warnings`、`images` JSONB 精确读写。
- `ensureDbShape` 为旧 JSON/测试数据补默认字段与空数组。
- 删除批次时 `deleteMissing` 正确清理数据库行。

**Step 2: 确认失败**

Run: `npm test -w apps/api -- test/postgres-store.test.js`

Expected: FAIL，新表/字段不存在。

**Step 3: 编写迁移**

迁移内容：

```sql
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS source_url_fingerprint TEXT;
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS source_name TEXT NOT NULL DEFAULT '';
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS source_author TEXT NOT NULL DEFAULT '';
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMPTZ;
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS content_posts_source_url_fingerprint_unique
  ON content_posts(source_url_fingerprint) WHERE source_url_fingerprint IS NOT NULL;
```

新增 `site_content_import_batches`，包含上述批次字段、`warnings JSONB`、`images JSONB`、状态约束、`created_by` 外键、过期索引。同步更新完整 schema。

**Step 4: 扩展内存形状与 PostgreSQL 映射**

- `seedDb.siteContentImportBatches = []`。
- `ensureDbShape` 补来源默认值和批次数组。
- `read` 的 Promise.all、row map、`write` upsert、`deleteMissing` 全部覆盖新表/字段。
- 把新表加入 PostgreSQL store 初始化所需表清单。

**Step 5: 运行测试**

Run: `npm test -w apps/api -- test/postgres-store.test.js`

Expected: PASS。

**Step 6: Commit**

```bash
git add apps/api/src/data apps/api/test/postgres-store.test.js
git commit -m "feat: persist content import batches"
```

### Task 6: 实现安全暂存目录与图片筛选

**Files:**
- Create: `apps/api/src/files/site-content-import-storage.js`
- Create: `apps/api/src/services/site-content-import/image-import.js`
- Create: `apps/api/test/site-content-import-storage.test.js`
- Create: `apps/api/test/site-content-import-images.test.js`

**Step 1: 写暂存目录失败测试**

覆盖目录穿越、符号链接、重复文件、读取、删除单图、删除批次，以及删除失败时可返回供 cleanup journal 使用的绝对路径。

接口：

```js
saveStagedImportImage({ batchId, imageId, extension, buffer })
readStagedImportImage({ batchId, imageId, stagePath })
deleteStagedImportImage({ batchId, imageId, stagePath })
deleteStagedImportBatch({ batchId })
```

目录固定为 `${UPLOAD_ROOT}/site-content-import-staging/:batchId/`，复用 `storage.js` 的路径安全模式，不导出任意路径读取能力。

**Step 2: 写图片处理失败测试**

覆盖：JPG/PNG/WebP、伪造 MIME、单张 5 MB、最多 20 张、批次 50 MB、二维码/avatar/logo/广告/1px 跟踪图/极端比例/过小图片过滤，以及正常正文图保留。过滤结果必须带 `reasonCode` 与中文 `reason`。

接口：

```js
stageArticleImages({ batchId, candidates, fetchResource, saveImage, imageProcessor })
retryArticleImage({ batch, imageId, fetchResource, saveImage, imageProcessor })
```

**Step 3: 确认失败**

Run: `npm test -w apps/api -- test/site-content-import-storage.test.js test/site-content-import-images.test.js`

Expected: FAIL。

**Step 4: 最小实现**

使用 `file-type` 验证真实类型、Sharp 读取尺寸并自动旋转规范化；失败图片不终止整篇检查，但记录为 `failed`。第一张 `ready` 图片作为默认封面候选，不在此阶段创建 `media_assets`。

**Step 5: 运行测试**

Run: `npm test -w apps/api -- test/site-content-import-storage.test.js test/site-content-import-images.test.js`

Expected: PASS。

**Step 6: Commit**

```bash
git add apps/api/src/files/site-content-import-storage.js apps/api/src/services/site-content-import/image-import.js apps/api/test/site-content-import-storage.test.js apps/api/test/site-content-import-images.test.js
git commit -m "feat: stage and filter imported article images"
```

### Task 7: 实现导入业务服务和原子提交

**Files:**
- Create: `apps/api/src/services/site-content-imports.js`
- Modify: `apps/api/src/services/system-storage.js`
- Modify: `apps/api/src/services/site-admin.js`
- Create: `apps/api/test/site-content-imports.test.js`
- Modify: `apps/api/test/system-storage.test.js`

**Step 1: 写失败测试**

覆盖完整服务行为：

- `inspectContentImport` 在抓取前查原始规范 URL，抓取后再按 final/canonical URL 查重。
- 相同指纹返回 `IMPORT_DUPLICATE_SOURCE`，错误 details 含现有 `contentId`。
- 每管理员 10 次/分钟限流。
- 磁盘 >=80% 返回 warning，>=90% 返回 `IMPORT_STORAGE_CRITICAL` 并不下载图片。
- 批次归创建管理员所有，过期返回 `IMPORT_BATCH_EXPIRED`。
- 删除/重试只改变目标图片。
- commit 只接受 `ready` 且未删除的图片，把 token 改写为 `/api/public/media/:id`，再走 `sanitizeContentHtml` 和 `contentBodyMedia` 验证。
- commit 创建 `status: "draft"` 内容，绝不接受客户端传入 published/scheduled。
- 封面和正文图片使用现有 `saveSiteMedia`，目的分别为 `content-cover`、`content-body`。
- 内容、媒体记录、attachments、批次 committed 状态与 audit log 一起写入。
- 任一媒体或数据库步骤失败时删除本次新文件；删除失败写入 `fileCleanupJournal`，不能留下部分内容。

目标导出：

```js
inspectContentImport(deps, { adminId, sourceUrl })
retryContentImportImage(deps, { adminId, batchId, imageId })
deleteContentImportImage(deps, { adminId, batchId, imageId })
commitContentImport(deps, { adminId, batchId, eventId, type, title, summary, slug, selectedImageIds, coverImageId })
cancelContentImport(deps, { adminId, batchId })
expireContentImportBatches(deps)
```

**Step 2: 确认失败**

Run: `npm test -w apps/api -- test/site-content-imports.test.js test/system-storage.test.js`

Expected: FAIL。

**Step 3: 扩展磁盘策略**

在 `system-storage.js` 提取通用容量判断：

```js
assertContentImportCapacity(status)
// warning at 80%, throw IMPORT_STORAGE_CRITICAL at 90%
```

保留现有视频上传行为不变。

**Step 4: 实现服务**

复用 `createContent` 的字段校验规则，但增加一个内部可注入媒体创建步骤；不要通过 HTTP 调用自己的内容或媒体路由。批次提交完成后立即尽力删除 staging，失败写 journal。

**Step 5: 运行测试**

Run: `npm test -w apps/api -- test/site-content-imports.test.js test/system-storage.test.js test/site-admin.test.js`

Expected: PASS，现有内容创建不回归。

**Step 6: Commit**

```bash
git add apps/api/src/services/site-content-imports.js apps/api/src/services/system-storage.js apps/api/src/services/site-admin.js apps/api/test/site-content-imports.test.js apps/api/test/system-storage.test.js
git commit -m "feat: commit imported content as drafts"
```

### Task 8: 暴露管理员导入接口并自动清理过期批次

**Files:**
- Create: `apps/api/src/routes/site-content-imports.js`
- Modify: `apps/api/src/server.js`
- Create: `apps/api/test/site-content-import-routes.test.js`
- Modify: `apps/api/test/authorization.test.js`
- Modify: `apps/api/test/mutation-architecture.test.js`

**Step 1: 写失败路由测试**

覆盖六个接口、管理员鉴权、强制修改密码拦截、批次所有权、JSON 错误码、图片预览 MIME/缓存头、重复链接 details 和 commit DTO。

图片预览必须：

```text
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
Content-Disposition: inline
```

**Step 2: 确认失败**

Run: `npm test -w apps/api -- test/site-content-import-routes.test.js test/authorization.test.js test/mutation-architecture.test.js`

Expected: FAIL。

**Step 3: 实现路由工厂**

```js
createSiteContentImportRouter({
  store, requireAdmin, requirePasswordReady,
  asyncRoute, mutationAsyncRoute, makeId, now,
  fetchResource, readStorageStatus
})
```

路由只解析请求与返回 DTO，所有规则留在 Task 7 服务。

**Step 4: 接入服务器清理**

- 在 `/api` 下挂载路由。
- 启动时执行一次 `expireContentImportBatches`。
- 使用 `setInterval(..., 15 * 60_000).unref()` 清理 `expiresAt <= now` 的批次和 staging。
- 清理失败进入现有 cleanup journal；不要让定时器异常退出进程。

**Step 5: 运行测试**

Run: `npm test -w apps/api -- test/site-content-import-routes.test.js test/authorization.test.js test/mutation-architecture.test.js`

Expected: PASS。

**Step 6: Commit**

```bash
git add apps/api/src/routes/site-content-imports.js apps/api/src/server.js apps/api/test/site-content-import-routes.test.js apps/api/test/authorization.test.js apps/api/test/mutation-architecture.test.js
git commit -m "feat: expose content import administration api"
```

### Task 9: 管理端加入“转载内容”入口与三步流程

**Files:**
- Modify: `apps/admin/src/components/ContentListPanel.vue`
- Modify: `apps/admin/src/components/__tests__/ContentListPanel.test.js`
- Create: `apps/admin/src/lib/content-import-errors.js`
- Create: `apps/admin/src/lib/__tests__/content-import-errors.test.js`
- Create: `apps/admin/src/components/ContentImportPanel.vue`
- Create: `apps/admin/src/components/__tests__/ContentImportPanel.test.js`
- Modify: `apps/admin/src/pages/SiteContentPage.vue`
- Modify: `apps/admin/src/pages/__tests__/SiteContentPage.test.js`
- Modify: `apps/admin/src/styles/admin.css`

**Step 1: 写列表入口失败测试**

断言“转载内容”位于“新建内容”旁边，点击 emit `import`，已有新建、筛选、编辑行为不变。

Run: `npm test -w apps/admin -- ContentListPanel.test.js`

Expected: FAIL。

**Step 2: 写错误码映射测试**

为规范中所有稳定错误码提供短中文文案和处理建议；未知错误回退 API message。

Run: `npm test -w apps/admin -- content-import-errors.test.js`

Expected: FAIL。

**Step 3: 写导入面板失败测试**

组件 props/emits：

```js
defineProps({ events: Array })
defineEmits(["cancel", "committed"])
```

验证：

- 第一步只有 URL、使用说明和“检查链接”。
- 检查中禁用重复提交。
- 第二步显示标题、摘要、作者、来源、日期、正文预览、图片状态和磁盘 warning。
- 图片可删除、失败项可重试；选一张 ready 图为封面。
- 标题、摘要、归属赛事、类型、slug 可编辑。
- “保存为草稿”明确提示不会直接发布。
- duplicate error 提供“打开已有内容”，emit `committed(existingId)`。
- 成功 commit 后 emit 新内容 id；取消会 DELETE 尚未提交批次。

Run: `npm test -w apps/admin -- ContentImportPanel.test.js`

Expected: FAIL。

**Step 4: 最小实现组件与页面状态**

把 `SiteContentPage` 的 `contentContext` 扩展为：

```text
none | existing | new | import
```

- `ContentListPanel @import="importContent"`。
- import context 渲染 `ContentImportPanel`，不参与草稿官网预览按钮。
- commit 后切到 existing 并打开 `ContentEditorPanel`，管理员可继续调整和发布。
- 切换 tab/返回列表时取消未提交批次；若 DELETE 失败显示提示但允许离开。

**Step 5: 样式**

新增 `.content-import-*`，沿用当前 panel、form-actions、message、primary 设计；桌面为正文预览与图片侧栏双列，小屏单列。被过滤/失败图片不得看起来可提交。

**Step 6: 运行管理端测试**

Run: `npm test -w apps/admin -- ContentListPanel.test.js ContentImportPanel.test.js SiteContentPage.test.js content-import-errors.test.js`

Expected: PASS。

**Step 7: Commit**

```bash
git add apps/admin/src
git commit -m "feat: add guided content repost workflow"
```

### Task 10: 在公开内容页显示转载来源

**Files:**
- Modify: `apps/api/src/services/public-site-view.js`
- Modify: `apps/api/test/public-site-service.test.js`
- Modify: `apps/web/src/pages/ContentDetailPage.jsx`
- Create: `apps/web/src/pages/__tests__/ContentDetailPage.test.jsx`
- Modify: `apps/web/src/styles/content.css`

**Step 1: 写 API DTO 失败测试**

断言列表摘要不泄露导入内部字段；详情只新增：

```js
source: {
  name: "温州发布",
  author: "作者",
  url: "https://合法原文地址",
  publishedAt: "ISO"
}
```

非转载内容 `source: null`。URL 必须再次确认是 HTTP(S) 才输出。

**Step 2: 写 Web 失败测试**

断言转载详情标题下显示“来源”“原文链接”“原文发布时间”和版权提示；链接使用 `target="_blank" rel="noopener noreferrer"`。普通内容不显示来源块。

**Step 3: 确认失败**

Run: `npm test -w apps/api -- test/public-site-service.test.js`

Run: `npm test -w apps/web -- --run ContentDetailPage.test.jsx`

Expected: FAIL。

**Step 4: 最小实现并加样式**

来源块放在标题元信息与正文之间，文案：

```text
本文转载自“来源名称”，版权归原作者及原平台所有；如有侵权请联系删除。
```

**Step 5: 运行测试**

Run: `npm test -w apps/api -- test/public-site-service.test.js`

Run: `npm test -w apps/web -- --run ContentDetailPage.test.jsx`

Expected: PASS。

**Step 6: Commit**

```bash
git add apps/api/src/services/public-site-view.js apps/api/test/public-site-service.test.js apps/web/src/pages/ContentDetailPage.jsx apps/web/src/pages/__tests__/ContentDetailPage.test.jsx apps/web/src/styles/content.css
git commit -m "feat: show original source on reposted content"
```

### Task 11: 补齐审计、清理与异常恢复测试

**Files:**
- Modify: `apps/api/src/services/resource-cleanup.js`
- Modify: `apps/api/test/resource-cleanup.test.js`
- Modify: `apps/api/test/site-content-imports.test.js`
- Modify: `apps/api/test/mutation-architecture.test.js`

**Step 1: 写失败测试**

覆盖：

- inspect、retry、delete image、commit、cancel、expire 的审计 action 和 actor。
- 过期批次删除数据库行和目录。
- 正在 commit 的批次不会被过期清理重复删除。
- staging 删除失败 journal 分类为 `site-content-import-staging`，后续资源清理可重试并移除 marker。
- commit 成功但最终 staging 删除失败不会回滚正式内容，只记 journal。

**Step 2: 确认失败**

Run: `npm test -w apps/api -- test/resource-cleanup.test.js test/site-content-imports.test.js test/mutation-architecture.test.js`

Expected: FAIL。

**Step 3: 最小实现**

只扩展现有 cleanup journal 的受管目录白名单和处理分支；必须再次校验路径在 `site-content-import-staging` 内，不能让数据库中的任意路径触发删除。

**Step 4: 运行测试**

Run: `npm test -w apps/api -- test/resource-cleanup.test.js test/site-content-imports.test.js test/mutation-architecture.test.js`

Expected: PASS。

**Step 5: Commit**

```bash
git add apps/api/src/services/resource-cleanup.js apps/api/test/resource-cleanup.test.js apps/api/test/site-content-imports.test.js apps/api/test/mutation-architecture.test.js
git commit -m "test: cover content import cleanup and audit"
```

### Task 12: 全量验证、浏览器验收与部署准备

**Files:**
- Modify if needed: `docs/superpowers/specs/2026-08-11-content-repost-import-design.md`
- Modify if needed: `docs/superpowers/plans/2026-08-11-content-repost-import.md`

**Step 1: API 全量测试**

Run: `npm test -w apps/api`

Expected: 所有 API 测试通过。

**Step 2: 管理端全量测试**

Run: `npm test -w apps/admin`

Expected: 所有管理端测试通过。

**Step 3: 官网全量测试**

Run: `npm test -w apps/web -- --run`

Expected: 所有官网测试通过。

**Step 4: 生产构建**

Run: `npm run build`

Expected: web/admin Vite 构建成功，无新增警告。

**Step 5: 本地浏览器验收**

启动项目后验证：

1. 内容列表同时显示“转载内容”和“新建内容”。
2. 微信文章链接可预检查，标题/来源/作者/正文/图片正常。
3. 普通新闻链接可预检查；广告、二维码和跟踪图有明确过滤提示。
4. 删除和重试图片后刷新仍保留批次状态。
5. 保存后只生成草稿，并自动打开原内容编辑器。
6. 发布后公开页面显示站内图片、来源、原文链接与版权提示。
7. 重复导入同一链接会打开已有内容，不新建第二篇。
8. 内网、metadata、非法重定向和超大响应均被拒绝。

**Step 6: 代码审查**

使用 `superpowers:requesting-code-review`，重点检查 SSRF、路径安全、批次所有权、原子提交、HTML 清洗和回滚。

**Step 7: 最终验证与提交**

使用 `superpowers:verification-before-completion` 重新运行必要命令，确认 `git status --short` 只含预期修改；如有验收修正，提交：

```bash
git add -A
git commit -m "fix: complete content repost import verification"
```

**Step 8: 部署顺序**

1. 在服务器备份 PostgreSQL 与 `/data/uploads`。
2. 拉取分支代码并安装锁定依赖：`npm ci --omit=dev`（构建阶段需完整依赖时先 `npm ci`）。
3. 先执行 migration 016，再启动新 API。
4. 构建并替换 web/admin 静态资源。
5. 重启服务，检查 `/api/health`、导入接口鉴权、官网内容详情。
6. 用一篇微信文章和一篇普通新闻做生产烟雾测试，草稿确认后删除测试内容与导入批次。

---

## 实施约束

- 不将外部 HTML、外部图片 URL 或 iframe 原样保存到正式内容。
- 不在前端抓取目标网页，不依赖 CORS 或浏览器扩展。
- 不把预检查批次当作正式内容或正式媒体。
- 不绕过现有 `createContent`、`sanitizeContentHtml`、`contentBodyMedia`、`saveSiteMedia` 的约束。
- 不允许导入流程直接发布；必须进入现有编辑/发布检查。
- 不在日志、错误响应或审计详情中保存完整 HTML、图片二进制或敏感请求头。
- 所有网络与文件依赖都通过参数注入，使测试不访问真实公网和真实生产目录。
