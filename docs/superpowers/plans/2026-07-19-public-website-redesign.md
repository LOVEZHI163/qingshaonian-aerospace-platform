# 温州市青少年航空航天创新比赛官网升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有单届宣传页升级为蓝白 A2 官方赛事门户，支持同一时间 0–3 场公开赛事、长期内容发布、赛事详情和管理端官网内容维护，同时保持报名、组织、成绩和证书业务可用。

**Architecture:** 继续使用 React 公共站、Vue 管理端、Express API、PostgreSQL 与服务器文件存储。新增官网设置、赛事公开资料、内容文章、媒体资源和附件关联数据单元；公共端通过聚合 API 读取发布快照，管理端通过独立 Router 维护草稿与发布状态。现有赛事仍是业务事实来源，官网资料只补充封面、摘要和可见性；报名入口显式携带 `eventId`，不再假定系统只有一场可报名赛事。

**Tech Stack:** Node.js 22、Express 4、PostgreSQL 16、pg/pg-mem、multer、file-type、sharp、sanitize-html、React 18、Vite 6、Vue 3、Vitest、Vue Test Utils、Node Test Runner、Docker Compose、Nginx。

## Global Constraints

- 长期名称固定为“温州市青少年航空航天创新比赛”，视觉采用蓝底白色 Logo 与名称的 A2 官方门户方案。
- 商标源文件固定为 `D:\中文存储\xwechat_files\lovezhi163_7c10\msg\file\2026-07\官网首页商标.svg`，SHA-256 为 `E6941F0ED7C299D3D993035B20AB0BE15801E438BFEFB4313DA93C00CC2322FB`。
- 名称源文件固定为 `C:\Users\xiang\Documents\青少年航空网站\官网首页名称.svg`，SHA-256 为 `F68844EC3C09A5D2FEB957673A319319327B7A09757423342FB69FA6645B7BFD`。
- 保留现有 React、Vue、Express、PostgreSQL、文件存储、会话认证和 Docker 部署，不引入第三方 CMS，不重写报名、组织、成绩或证书模块。
- 公开首页必须正确处理 0、1、2、3 场可展示赛事；0 场时展示最近回顾，1 场时不渲染空卡片，2–3 场时展示重点赛事和同期赛事。
- 手动重点赛事无效时自动选择“报名开放且截止时间最近”的赛事；无开放赛事时回退到时间最近的公开赛事回顾。
- 所有报名入口必须携带明确的 `eventId`；服务端验证项目确实属于该赛事，不能静默改报“当前赛事”。
- 内容状态固定为 `draft`、`scheduled`、`published`、`offline`；公共接口只返回到达发布时间的 `published` 内容。
- 草稿媒体不可公开读取；富文本必须经过服务端允许列表清洗；删除媒体前必须检查引用并复用文件清理日志。
- 新增 mutation 必须使用现有 mutation lock，管理员接口必须同时经过 `requireAdmin` 与 `requirePasswordReady`，发布、下线和资源清理必须写审计日志。
- 所有业务修改遵循红—绿—重构：先写失败测试，再写最小实现，再运行相关测试和全量测试。
- 不提交 `.superpowers/`、本地预览产物、测试截图、密钥或用户当前工作区中的无关改动。

---

### Task 1: 建立官网内容数据库结构和双存储映射

**Files:**
- Create: `apps/api/src/data/migrations/006-public-site-content.sql`
- Modify: `apps/api/src/data/schema.sql`
- Modify: `apps/api/src/data/seed.js`
- Modify: `apps/api/src/data/postgres-store.js`
- Modify: `apps/api/test/postgres-store.test.js`
- Modify: `apps/api/test/data-store.test.js`

**Interfaces:**
- `readDb()` 新增 `siteSettings`、`eventPublicProfiles`、`contentPosts`、`mediaAssets`、`contentAttachments`。
- `siteSettings` 是单例对象；其余均为数组，并同时支持 PostgreSQL 与 JSON 文件测试库。
- 每个可编辑记录包含整数 `version`，写入时用于冲突检测。

- [ ] **Step 1: 先写存储结构失败测试**

  在 `postgres-store.test.js` 断言迁移后存在五张表、唯一 slug/单例约束和引用索引；在 `data-store.test.js` 断言空 JSON 库经 `ensureDbShape()` 后返回完整空集合和默认站点设置：

  ```js
  assert.deepEqual(db.siteSettings, {
    id: "default",
    platformName: "温州市青少年航空航天创新比赛",
    featuredEventId: null,
    platformIntro: "",
    organizers: [],
    contact: "",
    icp: "",
    seoTitle: "温州市青少年航空航天创新比赛",
    seoDescription: "",
    defaultHeroMediaId: null,
    shareMediaId: null,
    version: 1
  });
  assert.deepEqual(db.contentPosts, []);
  ```

  Run: `npm test -w apps/api -- --test-name-pattern="public site schema|website data shape"`

  Expected: FAIL，提示官网内容表或数据集合不存在。

- [ ] **Step 2: 编写可重复执行的迁移**

  `006-public-site-content.sql` 创建：

  ```sql
  CREATE TABLE IF NOT EXISTS site_settings (
    id TEXT PRIMARY KEY CHECK (id = 'default'),
    platform_name TEXT NOT NULL,
    featured_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
    platform_intro TEXT NOT NULL DEFAULT '',
    organizers JSONB NOT NULL DEFAULT '[]'::jsonb,
    contact TEXT NOT NULL DEFAULT '',
    icp TEXT NOT NULL DEFAULT '',
    seo_title TEXT NOT NULL,
    seo_description TEXT NOT NULL DEFAULT '',
    default_hero_media_id TEXT,
    share_media_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS event_public_profiles (
    event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    slogan TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    is_visible BOOLEAN NOT NULL DEFAULT FALSE,
    display_order INTEGER NOT NULL DEFAULT 0,
    hero_media_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS content_posts (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK (type IN ('announcement','news','work','recap','guide')),
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('draft','scheduled','published','offline')),
    publish_at TIMESTAMPTZ,
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    cover_media_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
    purpose TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('draft','public')),
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    width INTEGER,
    height INTEGER,
    variants JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL,
    cleaned_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS content_attachments (
    content_id TEXT NOT NULL REFERENCES content_posts(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL REFERENCES media_assets(id),
    label TEXT NOT NULL DEFAULT '',
    display_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (content_id, media_id)
  );
  ```

  在创建全部表后补充媒体外键，并建立 `content_posts(status,publish_at)`、`content_posts(event_id,type)`、`event_public_profiles(is_visible,display_order)` 索引。默认 `site_settings` 用 `INSERT ... ON CONFLICT DO NOTHING`，不得覆盖管理员配置。

- [ ] **Step 3: 完成 JSON 与 PostgreSQL 映射**

  `ensureDbShape()` 只补缺失集合和默认字段，不覆盖已有内容；`postgres-store.js` 的 `readDb()` 映射 snake_case 到 camelCase，`writeDb()` 在现有事务中按附件→内容→媒体→公开资料→设置的安全顺序重写，并保持 `version`。

- [ ] **Step 4: 验证并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="public site schema|website data shape|PostgreSQL"`

  Expected: PASS，重复 `initialize()` 不增加重复默认记录。

  Run: `npm test -w apps/api`

  Expected: 全量 API 测试 PASS。

  ```bash
  git add apps/api/src/data apps/api/test/postgres-store.test.js apps/api/test/data-store.test.js
  git commit -m "feat: add public website content data model"
  ```

### Task 2: 实现发布规则、重点赛事选择和安全富文本纯服务

**Files:**
- Create: `apps/api/src/services/public-site.js`
- Create: `apps/api/src/services/content-publishing.js`
- Create: `apps/api/src/content/sanitize.js`
- Create: `apps/api/test/public-site-service.test.js`
- Create: `apps/api/test/content-publishing.test.js`
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- `selectHomeEvents(db, clock): { featuredEvent, concurrentEvents, fallbackEvent, mode }`。
- `isPublicPost(post, now): boolean`、`normalizeContentInput(input, current, now)`、`sanitizeContentHtml(html): string`。
- `mode` 只取 `active` 或 `history`；`concurrentEvents` 最大两条。

- [ ] **Step 1: 安装清洗依赖并写选择规则失败测试**

  Run: `npm install -w apps/api sanitize-html`

  测试覆盖：手动重点有效、手动重点隐藏后自动回退、按报名截止时间选最近、0/1/2/3 场布局、强制开放/关闭、归档赛事只进入历史回顾。

  ```js
  assert.equal(selectHomeEvents(db, now).featuredEvent.id, "E2");
  assert.deepEqual(selectHomeEvents(db, now).concurrentEvents.map((row) => row.id), ["E1", "E3"]);
  assert.equal(selectHomeEvents(noActiveDb, now).mode, "history");
  ```

  Run: `npm test -w apps/api -- --test-name-pattern="home event selection|content visibility|sanitize content"`

  Expected: FAIL，服务模块不存在。

- [ ] **Step 2: 实现赛事选择纯函数**

  可展示赛事必须同时满足公开资料 `isVisible`、赛事未归档且状态为 `published`。手动重点优先；否则只在报名窗口开放的候选中按 `registrationEndAt` 升序、`displayOrder` 升序、`id` 升序确定。没有开放赛事时，`fallbackEvent` 取最近结束的公开或归档赛事，按钮文案为“查看赛事回顾”，绝不返回“立即报名”。

- [ ] **Step 3: 实现状态机和版本冲突**

  `normalizeContentInput()` 验证类型、slug、标题、状态、发布时间和整数排序；`scheduled` 必须有未来 `publishAt`，`published` 无时间时使用当前时间。更新时请求 `version` 必须等于当前版本，否则抛出 `409 CONTENT_VERSION_CONFLICT`，成功后加一。

- [ ] **Step 4: 实现富文本允许列表**

  仅允许 `p,h2,h3,h4,ul,ol,li,strong,em,blockquote,a,img,figure,figcaption,br`；链接只允许 `http,https,mailto`，图片 `src` 只允许本站 `/api/public/media/` 路径；删除 `script/style/iframe`、事件属性、`javascript:` 和任意内联样式。

- [ ] **Step 5: 验证并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="home event selection|content visibility|sanitize content"`

  Expected: PASS，恶意 HTML 的脚本和事件属性均被移除。

  ```bash
  git add apps/api/src/services apps/api/src/content apps/api/test apps/api/package.json package-lock.json
  git commit -m "feat: add website publishing rules"
  ```

### Task 3: 建立官网媒体上传、派生图和受控读取

**Files:**
- Modify: `apps/api/src/files/policy.js`
- Modify: `apps/api/src/files/storage.js`
- Create: `apps/api/src/services/site-media.js`
- Create: `apps/api/src/routes/site-media.js`
- Create: `apps/api/test/site-media.test.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- `SITE_IMAGE_POLICY`: JPEG/PNG/WebP/SVG，10MB；SVG 只允许用户已经批准的品牌文件走构建资产，后台不接受 SVG 上传。
- `SITE_ATTACHMENT_POLICY`: PDF/JPEG/PNG/WebP，20MB。
- `saveSiteMedia({ mediaId, file, purpose })` 生成原图元数据与 `mobile`、`desktop` WebP 变体。
- Admin: `POST /api/admin/site-media`、`DELETE /api/admin/site-media/:id`。
- Public: `GET /api/public/media/:id?variant=mobile|desktop|original`。

- [ ] **Step 1: 写真实性、权限和引用保护失败测试**

  测试扩展名伪装、空文件、超限、恶意 SVG、普通用户上传、草稿媒体公开读取、被文章或首页引用的媒体删除，及不存在变体回退。

- [ ] **Step 2: 安装图片处理依赖并实现存储**

  Run: `npm install -w apps/api sharp`

  使用现有 `validateUpload()` 的签名检测。图片自动纠正方向，生成宽度 768 的 `mobile.webp` 和 1600 的 `desktop.webp`，均禁止放大；原图和变体都写入 `UPLOAD_ROOT/site-media/<mediaId>/`。附件只保存原文件。

- [ ] **Step 3: 实现管理员上传和公开读取**

  上传默认 `visibility: draft`。文章发布或设为公开封面时，把其引用媒体提升为 `public`；内容下线不立即物理删除媒体。公共读取前再次确认媒体为 `public` 且未清理，并设置 `X-Content-Type-Options: nosniff` 和七天缓存。

- [ ] **Step 4: 复用清理日志**

  删除前检查站点设置、赛事公开资料、文章封面和附件引用；有引用返回 409。物理删除失败时写入 `fileCleanupJournal`，不得先丢数据库元数据。

- [ ] **Step 5: 验证并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="site media"`

  Expected: PASS，草稿媒体 404、公开媒体 200、危险文件 422。

  ```bash
  git add apps/api/src/files apps/api/src/services/site-media.js apps/api/src/routes/site-media.js apps/api/src/server.js apps/api/test/site-media.test.js apps/api/package.json package-lock.json
  git commit -m "feat: add managed website media"
  ```

### Task 4: 实现官网管理 API 和发布审计

**Files:**
- Create: `apps/api/src/routes/site-admin.js`
- Create: `apps/api/src/services/site-admin.js`
- Create: `apps/api/test/site-admin.test.js`
- Modify: `apps/api/src/server.js`

**Interfaces:**
- `GET/PATCH /api/admin/site-settings`
- `GET /api/admin/event-public-profiles`
- `PUT /api/admin/event-public-profiles/:eventId`
- `GET/POST /api/admin/content`
- `GET/PATCH/DELETE /api/admin/content/:id`
- `POST /api/admin/content/:id/publish`
- `POST /api/admin/content/:id/offline`

- [ ] **Step 1: 写身份、校验、冲突和审计失败测试**

  对每个写接口验证未登录 401、普通用户 403、临时密码 428。再验证重复 slug 409、无效 eventId 422、版本冲突 409、发布后公共可见、下线后不可见，以及 `content.publish`、`content.offline`、`site.settings.update` 审计记录。

- [ ] **Step 2: 实现设置和赛事公开资料接口**

  设置只接受明确白名单字段；`featuredEventId` 必须引用可见赛事或为 `null`。赛事资料要求稳定 slug，首次创建后更改 slug 时如果已有公开内容则拒绝 409，避免破坏历史链接。

- [ ] **Step 3: 实现文章 CRUD 与发布动作**

  创建默认 `draft`。普通 PATCH 不能伪造 `createdBy/createdAt`。发布动作在一次 mutation lock 中完成：清洗正文、校验附件、将引用媒体标记公开、更新状态/发布时间/版本、记录审计。下线只改状态和审计，不删除文件。

- [ ] **Step 4: 实现可预览草稿响应**

  管理员 `GET /api/admin/content/:id` 返回完整草稿及附件；公共接口不接受 preview query 或管理员 cookie 旁路，避免预览链接泄漏。管理端预览使用本地组件渲染服务端清洗后的 `previewHtml`。

- [ ] **Step 5: 验证并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="site admin|content publish"`

  Expected: PASS。

  Run: `npm test -w apps/api`

  Expected: 全量 API 测试 PASS。

  ```bash
  git add apps/api/src/routes/site-admin.js apps/api/src/services/site-admin.js apps/api/src/server.js apps/api/test/site-admin.test.js
  git commit -m "feat: add website content administration api"
  ```

### Task 5: 建立公共聚合、详情、列表和 SEO API

**Files:**
- Create: `apps/api/src/routes/public-site.js`
- Create: `apps/api/test/public-site-routes.test.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/routes/events.js`
- Modify: `apps/api/test/event-management.test.js`

**Interfaces:**
- `GET /api/public/home`
- `GET /api/public/events/:slug`
- `GET /api/public/content?type=&event=&page=&pageSize=`
- `GET /api/public/content/:slug`
- `GET /api/public/sitemap.xml`
- 保留兼容接口 `GET /api/public/event`，在后续迁移期继续返回旧管理端需要的当前赛事负载。

- [ ] **Step 1: 写 0/1/2/3 场赛事与发布可见性失败测试**

  首页响应固定为：

  ```js
  {
    site,
    mode: "active",
    featuredEvent,
    concurrentEvents: [],
    services,
    announcements,
    news,
    works,
    history
  }
  ```

  分别构造 0、1、2、3 场公开赛事，并验证不会返回草稿、未来定时文章、下线内容、私有媒体路径或内部 `filePath/storedName`。

- [ ] **Step 2: 实现首页聚合**

  首页只返回首屏和各栏目所需字段：公告 5 条、新闻 6 条、作品 6 条、历史 6 条；排序为 `pinned DESC, sortOrder ASC, publishAt DESC, id ASC`。每个事件包含 `registrationWindow` 与带 `eventId` 的服务目标，不在前端重新推算报名状态。

- [ ] **Step 3: 实现赛事和内容详情**

  赛事详情合并现有事件、启用赛项、固定四组、公开资料和绑定文章。内容详情只允许已发布内容并返回公开附件 URL。列表分页最大 50 条，未知类型或页码返回 422。

- [ ] **Step 4: 生成 sitemap**

  只包含首页、固定栏目、可见赛事 slug 和已发布内容 slug；XML 转义标题与 URL。Host 使用 `PUBLIC_SITE_URL`，不信任请求头拼接外部 URL。

- [ ] **Step 5: 验证并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="public home|public content|sitemap|public event"`

  Expected: PASS。

  ```bash
  git add apps/api/src/routes/public-site.js apps/api/src/server.js apps/api/src/routes/events.js apps/api/test/public-site-routes.test.js apps/api/test/event-management.test.js
  git commit -m "feat: expose public website api"
  ```

### Task 6: 让现有报名流程支持明确赛事上下文

**Files:**
- Modify: `apps/api/src/services/events.js`
- Modify: `apps/api/src/services/registrations.js`
- Modify: `apps/api/src/routes/registrations.js`
- Modify: `apps/api/test/registration-management.test.js`
- Modify: `apps/api/test/event-management.test.js`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/pages/RegistrationPage.vue`
- Modify: `apps/admin/src/pages/__tests__/AppNavigation.test.js`
- Create: `apps/admin/src/pages/__tests__/RegistrationPage.event-context.test.js`

**Interfaces:**
- `registrationContext(db, input, clock)` 必须从 `input.eventId` 选择已发布且未归档赛事。
- `GET /api/me/registration-context?eventId=E1`
- `POST /api/registrations/check` 与 `POST /api/registrations` body 必须包含 `eventId`。
- `/admin/?view=registration&eventId=E1` 登录后进入对应赛事报名。

- [ ] **Step 1: 写跨赛事防串报失败测试**

  验证 E1 项目配 E2 eventId 返回 422；已归档、隐藏或报名关闭赛事返回 409；缺失 eventId 在过渡期仅当恰好一场可报名赛事时兼容，否则 422 要求选择赛事。

- [ ] **Step 2: 修改服务端报名上下文**

  新增 `publishedRegistrationEvent(db, eventId)`，替代创建/查重时的 `currentPublishedEvent()`。历史报名编辑仍使用记录自身 `eventId`，不受官网公开资料变化影响。

- [ ] **Step 3: 修改 Vue 登录后的目标恢复**

  `App.vue` 启动时读取 `view` 和 `eventId`，登录成功后把目标传给 `RegistrationPage`；非法视图回退到角色默认页。`RegistrationPage` 的 form 增加 `eventId`，上下文、查重和提交始终发送同一个值，并在页面标题显示赛事名称。

- [ ] **Step 4: 验证兼容性并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="event context|registration"`

  Run: `npm test -w apps/admin -- --run apps/admin/src/pages/__tests__/RegistrationPage.event-context.test.js apps/admin/src/pages/__tests__/AppNavigation.test.js`

  Expected: 全部 PASS，旧单赛事直接登录仍可报名，多赛事深链保持目标赛事。

  ```bash
  git add apps/api/src/services apps/api/src/routes/registrations.js apps/api/test apps/admin/src/App.vue apps/admin/src/pages/RegistrationPage.vue apps/admin/src/pages/__tests__
  git commit -m "feat: scope registration to selected event"
  ```

### Task 7: 增加管理端“官网内容”导航与首页/赛事视觉设置

**Files:**
- Modify: `apps/admin/src/components/AdminShell.vue`
- Modify: `apps/admin/src/App.vue`
- Create: `apps/admin/src/pages/SiteContentPage.vue`
- Create: `apps/admin/src/components/SiteSettingsPanel.vue`
- Create: `apps/admin/src/components/EventPublicProfilePanel.vue`
- Create: `apps/admin/src/pages/__tests__/SiteContentPage.test.js`
- Modify: `apps/admin/src/pages/__tests__/AppNavigation.test.js`
- Modify: `apps/admin/src/styles/admin.css`
- Modify: `apps/admin/src/styles/forms.css`

**Interfaces:**
- 管理员一级导航新增 `siteContent` / “官网内容”。
- 页面内固定三个页签：`homepage`、`events`、`content`，后续 Task 8 接入内容页签。

- [ ] **Step 1: 写导航和设置表单失败测试**

  验证点击“官网内容”不丢失登录态；首页设置能加载/保存；重点赛事下拉只列非归档赛事；赛事视觉列表能设置 slug、公开、顺序、宣传语、摘要和封面。

- [ ] **Step 2: 接入顶层视图**

  在 `AdminShell.vue` 新增导航项，在 `App.vue` 增加 `SiteContentPage` 分支；保持现有赛事设置、组织、报名和证书导航不变。

- [ ] **Step 3: 实现首页设置表单**

  表单显示平台名称只读，允许编辑平台简介、主办单位列表、联系方式、备案号、SEO 标题/摘要、重点赛事和默认/分享封面。保存时发送当前 `version`，409 时提示“配置已被其他管理员更新，请刷新后重试”。

- [ ] **Step 4: 实现赛事视觉设置**

  每场赛事业务字段只读，公开资料独立编辑。上传封面先得到媒体 ID，再保存 profile；移除封面只解除引用，不立即删除文件。

- [ ] **Step 5: 验证并提交**

  Run: `npm test -w apps/admin -- --run apps/admin/src/pages/__tests__/SiteContentPage.test.js apps/admin/src/pages/__tests__/AppNavigation.test.js`

  Expected: PASS。

  ```bash
  git add apps/admin/src
  git commit -m "feat: add website settings administration"
  ```

### Task 8: 增加内容列表、编辑、预览、发布和媒体管理

**Files:**
- Create: `apps/admin/src/components/ContentListPanel.vue`
- Create: `apps/admin/src/components/ContentEditorPanel.vue`
- Create: `apps/admin/src/components/RichTextEditor.vue`
- Create: `apps/admin/src/components/MediaPicker.vue`
- Create: `apps/admin/src/components/ContentPreviewDialog.vue`
- Create: `apps/admin/src/components/__tests__/ContentEditorPanel.test.js`
- Create: `apps/admin/src/components/__tests__/RichTextEditor.test.js`
- Modify: `apps/admin/src/pages/SiteContentPage.vue`
- Modify: `apps/admin/src/styles/admin.css`
- Modify: `apps/admin/src/styles/forms.css`

**Interfaces:**
- 内容页签包含类型、赛事、状态和关键词筛选。
- 编辑器支持标题、slug、归属、类型、摘要、正文、封面、附件、置顶、顺序、状态和发布时间。

- [ ] **Step 1: 写创建、预览、发布和冲突失败测试**

  测试“新建草稿→保存→预览→发布→下线”完整流；验证预览使用 API 返回的清洗 HTML；版本冲突不覆盖用户当前输入；附件顺序与标签可编辑。

- [ ] **Step 2: 实现轻量富文本编辑器**

  使用 `contenteditable` 与固定工具栏（标题、加粗、斜体、列表、链接、引用、图片），不允许粘贴内联样式；保存前只提交 HTML，安全边界仍在 API。支持键盘操作和可见焦点，提供纯文本模式以便修复异常格式。

- [ ] **Step 3: 实现内容列表和编辑器**

  列表明确显示草稿、定时、发布、下线状态；发布和下线均二次确认。定时发布使用 `datetime-local` 转 ISO。删除只允许草稿/下线内容，已发布内容必须先下线。

- [ ] **Step 4: 实现媒体选择与附件**

  上传显示尺寸、类型和大小；封面仅可选图片，附件可选 PDF/图片。删除媒体前展示 API 引用冲突，不在前端假定可删。

- [ ] **Step 5: 验证并提交**

  Run: `npm test -w apps/admin -- --run apps/admin/src/components/__tests__/ContentEditorPanel.test.js apps/admin/src/components/__tests__/RichTextEditor.test.js apps/admin/src/pages/__tests__/SiteContentPage.test.js`

  Expected: PASS。

  Run: `npm run build -w apps/admin`

  Expected: 构建成功。

  ```bash
  git add apps/admin/src
  git commit -m "feat: add website content editor"
  ```

### Task 9: 拆分 React 公共站并建立路由、API 状态和品牌资产

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`
- Create: `apps/web/vitest.config.js`
- Create: `apps/web/src/api/client.js`
- Create: `apps/web/src/router.js`
- Create: `apps/web/src/App.jsx`
- Create: `apps/web/src/components/SiteHeader.jsx`
- Create: `apps/web/src/components/SiteFooter.jsx`
- Create: `apps/web/src/components/AsyncState.jsx`
- Create: `apps/web/src/test/setup.js`
- Create: `apps/web/src/__tests__/router.test.jsx`
- Create: `apps/web/public/brand/mark.svg`
- Create: `apps/web/public/brand/wordmark.svg`
- Modify: `apps/web/src/main.jsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- 客户端路由支持 `/`、`/events/:slug`、`/announcements`、`/news`、`/history`、`/content/:slug`，未知地址显示 404。
- `fetchJson(path, { signal })` 统一处理非 2xx、空响应和取消。

- [ ] **Step 1: 引入公共端测试设施并写路由失败测试**

  Run: `npm install -w apps/web -D vitest jsdom @testing-library/react @testing-library/jest-dom`

  测试直接设置 `window.history`，验证每个 URL 渲染对应页面、站头站尾始终存在、API 错误显示重试而不白屏。

- [ ] **Step 2: 固化用户批准的 SVG**

  先验证两个源文件 SHA-256 与 Global Constraints 一致，再把 SVG 文本作为仓库文件加入 `apps/web/public/brand/`；删除 XML 外部 DOCTYPE，保留 viewBox、路径和原始比例，不改绘图路径。商标和名称通过 CSS `filter`/`currentColor` 方案输出白色或官方蓝色，不维护黑色副本。

- [ ] **Step 3: 拆分入口和路由**

  `main.jsx` 只负责挂载 `App` 和全局样式。路由使用 History API 与 `popstate`，站内链接拦截同源导航；不新增大型 Router 依赖。页面请求必须用 `AbortController` 清理卸载后的响应。

- [ ] **Step 4: 建立全局品牌框架**

  `SiteHeader` 桌面显示商标+完整名称，移动端窄屏仅显示商标并在菜单中显示名称；蓝底白色、固定报名按钮、可访问菜单。`SiteFooter` 显示平台简介、主办单位、联系方式、备案信息和管理入口。

- [ ] **Step 5: 验证并提交**

  Run: `npm test -w apps/web`

  Expected: PASS。

  Run: `npm run build -w apps/web`

  Expected: 构建成功且品牌 SVG 被复制到 dist。

  ```bash
  git add apps/web package-lock.json
  git commit -m "refactor: establish public website application shell"
  ```

### Task 10: 实现 A2 蓝白首页和 0–3 场赛事自适应

**Files:**
- Create: `apps/web/src/pages/HomePage.jsx`
- Create: `apps/web/src/components/FeaturedEvent.jsx`
- Create: `apps/web/src/components/ConcurrentEvents.jsx`
- Create: `apps/web/src/components/ServiceGrid.jsx`
- Create: `apps/web/src/components/ContentSection.jsx`
- Create: `apps/web/src/components/EventStatus.jsx`
- Create: `apps/web/src/__tests__/HomePage.test.jsx`
- Create: `apps/web/src/styles/tokens.css`
- Create: `apps/web/src/styles/home.css`
- Modify: `apps/web/src/App.jsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- `HomePage` 只消费 `/api/public/home`，不硬编码赛事名称、日期、地点、新闻或状态。
- `FeaturedEvent` 根据 `mode` 渲染“立即报名”或“查看赛事回顾”。

- [ ] **Step 1: 写 0/1/2/3 场首页失败测试**

  验证 0 场不显示“报名中”；1 场没有同期赛事空区；2 场显示 1 张同期卡；3 场显示 2 张；服务入口、公告、动态、作品、历史和页脚均从 API 数据渲染。

- [ ] **Step 2: 建立 A2 设计令牌**

  定义官方蓝、深蓝、浅蓝、白色、状态绿、错误红、文字和边框颜色，以及 8px 间距体系、圆角、阴影、内容宽度和焦点环。状态不能只靠颜色，必须同时显示文字和图标/标签。

- [ ] **Step 3: 实现重点赛事与同期赛事**

  首屏使用响应式 `<picture>` 读取媒体变体，标题、主题、日期、地点和状态叠加在蓝白渐变上。1 场时主视觉占完整宽度；2–3 场时下方卡片保持同高；0 场时换回顾文案与历史入口。

- [ ] **Step 4: 实现四个服务入口**

  报名、成绩、证书链接到 `/admin/?view=...&eventId=...`；参赛指南链接到公开 guide 内容或赛事详情。没有可报名赛事时，报名入口显示“暂无开放报名”且链接到历史页，不制造无效登录流程。

- [ ] **Step 5: 实现内容区和轻量动效**

  公告使用紧凑列表，新闻/作品用图片卡片，历史用年份/赛事列表；空数据区显示简短说明且不保留大块空白。进入视口淡入必须遵循 `prefers-reduced-motion`。

- [ ] **Step 6: 验证并提交**

  Run: `npm test -w apps/web -- --run apps/web/src/__tests__/HomePage.test.jsx`

  Run: `npm run build -w apps/web`

  Expected: PASS，首页无硬编码当前赛事数据。

  ```bash
  git add apps/web/src
  git commit -m "feat: build adaptive blue white public homepage"
  ```

### Task 11: 实现赛事、公告、新闻、历史和内容详情页面

**Files:**
- Create: `apps/web/src/pages/EventDetailPage.jsx`
- Create: `apps/web/src/pages/ContentListPage.jsx`
- Create: `apps/web/src/pages/ContentDetailPage.jsx`
- Create: `apps/web/src/pages/HistoryPage.jsx`
- Create: `apps/web/src/components/AttachmentList.jsx`
- Create: `apps/web/src/components/ProjectGroups.jsx`
- Create: `apps/web/src/__tests__/PublicPages.test.jsx`
- Create: `apps/web/src/styles/content.css`
- Modify: `apps/web/src/App.jsx`

**Interfaces:**
- `EventDetailPage` 消费 `/api/public/events/:slug`。
- 列表页面消费 `/api/public/content`，详情消费 `/api/public/content/:slug`。

- [ ] **Step 1: 写页面数据与附件失败测试**

  验证赛事详情展示业务事实、启用赛项、四组、绑定内容和正确 eventId 报名链接；内容列表分页和筛选；详情安全渲染 HTML、图片替代文本和附件下载；不存在资源显示 404。

- [ ] **Step 2: 实现赛事详情**

  页面顺序：主视觉、核心信息、报名状态/按钮、赛事简介、赛项和组别、指南/规程附件、公告/新闻/作品、成绩/证书入口。归档赛事没有报名按钮。

- [ ] **Step 3: 实现公共内容页面**

  `/announcements` 固定 announcement；`/news` 同时提供 news/work 筛选；`/history` 展示历史赛事和 recap。详情正文用经过服务端清洗的 HTML，所有外部链接增加 `rel="noopener noreferrer"`。

- [ ] **Step 4: 验证并提交**

  Run: `npm test -w apps/web -- --run apps/web/src/__tests__/PublicPages.test.jsx`

  Expected: PASS。

  ```bash
  git add apps/web/src
  git commit -m "feat: add public event and content pages"
  ```

### Task 12: 完成响应式、无障碍、SEO 和性能收口

**Files:**
- Create: `apps/web/src/components/Seo.jsx`
- Create: `apps/web/src/__tests__/Accessibility.test.jsx`
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/App.jsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/styles/home.css`
- Modify: `apps/web/src/styles/content.css`
- Modify: `apps/web/vite.config.js`
- Modify: `.env.example`

**Interfaces:**
- 每页动态设置 `title`、description、canonical、Open Graph。
- `VITE_PUBLIC_SITE_URL` 仅用于 canonical；生产值为 `https://aerogp.cn`。

- [ ] **Step 1: 写元数据、键盘和 reduced-motion 失败测试**

  验证主导航跳过链接、移动菜单焦点、关闭后焦点归还、图片 alt、按钮可访问名称、当前页 `aria-current`、状态文字，以及 reduced-motion 下无位移动画。

- [ ] **Step 2: 完成四档响应式**

  在 360、768、1440、1920px 验收：无横向滚动、品牌不变形、导航可用、卡片不溢出、正文行长合理。表格型内容在移动端转卡片或允许局部滚动，不压缩整页。

- [ ] **Step 3: 完成 SEO 和首屏性能**

  首屏重点图使用 `fetchpriority="high"`，其他图 `loading="lazy"`；路由按页面动态 import；Vite 手动拆分 React 与动画包；移除未使用的 `@react-spring/web` 或仅保留必要动画。首页首屏网络资源目标不超过 1.5MB。

- [ ] **Step 4: 构建与尺寸检查**

  Run: `npm test -w apps/web`

  Run: `npm run build -w apps/web`

  Run: `Get-ChildItem apps/web/dist/assets -File | Sort-Object Length -Descending | Select-Object -First 20 Name,Length`

  Expected: 测试/构建 PASS；无单个首屏 JS chunk 超过 300KB gzip 前警戒线，品牌 SVG 比例正确。

  ```bash
  git add apps/web .env.example
  git commit -m "perf: finalize public website quality"
  ```

### Task 13: 扩展部署检查、备份和线上验收

**Files:**
- Modify: `Dockerfile.api`
- Modify: `Dockerfile.web`
- Modify: `compose.yaml`
- Modify: `deploy/nginx.conf`
- Modify: `deploy/preflight-admin-upgrade.sh`
- Modify: `deploy/remote-smoke-test.sh`
- Modify: `deploy/backup-uploads.sh`
- Modify: `docs/deployment/aliyun-test.md`
- Create: `apps/api/test/public-site-deployment.test.js`
- Modify: `apps/api/test/deployment-paths.test.js`
- Modify: `README.md`

**Interfaces:**
- Nginx 继续 SPA fallback，并为 `/api/public/media/` 设置安全响应头和可缓存策略。
- smoke 新增 home API、赛事详情、内容详情、sitemap、品牌资产和管理员官网内容接口。

- [ ] **Step 1: 写部署契约失败测试**

  验证 Docker 镜像包含品牌资产，Nginx 不缓存 HTML、缓存带内容 ID 的媒体，API/PostgreSQL 端口不公开，上传卷备份包含 `site-media`，smoke 不依赖固定赛事 slug。

- [ ] **Step 2: 更新容器和 Nginx**

  API 镜像需包含 sharp 运行依赖并以非 root 用户运行；web 构建传入 `VITE_PUBLIC_SITE_URL=https://aerogp.cn`。Nginx 保持 `/admin/` 与公共 SPA fallback，媒体读取仍通过 API 权限判断，不直接暴露 `/data/uploads`。

- [ ] **Step 3: 更新预检、备份和 smoke**

  升级前必须验证数据库 dump、上传目录备份、空闲空间和所有健康检查。`remote-smoke-test.sh` 顺序验证：`/healthz`、`/`、`/admin/`、`/api/public/home`、响应中的一个赛事详情、`/api/public/sitemap.xml`、管理员登录、`/api/admin/site-settings`、未登录管理 API 401。

- [ ] **Step 4: 本地全量门禁**

  Run: `npm test -w apps/api`

  Run: `npm test -w apps/admin`

  Run: `npm test -w apps/web`

  Run: `npm run build`

  Run: `docker compose config --quiet`

  Expected: 全部 PASS，无未处理警告和密钥输出。

- [ ] **Step 5: 阿里云发布**

  在服务器 `/opt/aerogp`：先运行数据库与上传备份及 `deploy/preflight-admin-upgrade.sh`；随后拉取本次提交，执行 `docker compose build --pull`、`docker compose up -d`、等待健康检查，再执行 `ADMIN_TEST_PASSWORD=... BASE_URL=http://127.0.0.1 sh deploy/remote-smoke-test.sh`。失败立即保留新日志，并按 `docs/deployment/aliyun-test.md` 使用已验证备份回滚数据库、上传卷和上一镜像。

- [ ] **Step 6: 浏览器线上验收**

  使用生产域名或测试 IP 验收 360、768、1440、1920px；覆盖 0/1/2/3 场 fixture 或管理配置、Logo/名称、菜单、报名深链、公告/新闻/历史、附件、管理员发布/下线、普通用户/组织用户/管理员三种登录目标。记录发布提交、备份文件名、smoke 输出和验收截图。

- [ ] **Step 7: 提交部署收口**

  ```bash
  git add Dockerfile.api Dockerfile.web compose.yaml deploy docs/deployment/aliyun-test.md apps/api/test/public-site-deployment.test.js apps/api/test/deployment-paths.test.js README.md
  git commit -m "chore: deploy redesigned public website"
  ```

## Final Verification Gate

- [ ] 运行 `git diff --check`，Expected: 无输出。
- [ ] 运行 API、Admin、Web 全量测试和根构建，Expected: 全部成功。
- [ ] 检查 `git status --short`，Expected: 仅包含明确保留的用户本地文件，不包含 `.superpowers/`、密钥、上传内容或构建目录。
- [ ] 对照设计说明逐项核对：A2 蓝白品牌、用户指定 SVG、0–3 场赛事、重点赛事回退、四服务入口、赛事详情、内容发布、媒体保护、响应式、无障碍、SEO、性能、备份与部署均有实现和自动化/浏览器证据。
- [ ] 在完成全部验收前，不宣称上线完成。
