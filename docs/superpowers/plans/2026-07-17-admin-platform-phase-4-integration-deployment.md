# AeroGP 管理平台阶段四：集成、资源治理与测试服务器发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成后台模块化、操作日志、历史赛事附件清理和危险删除，建立数据库与上传文件双备份，并安全发布到现有阿里云测试服务器。

**Architecture:** 关键写操作统一写入 audit log；历史赛事资源先统计、再标记清理、最后删除物理文件。`App.vue` 只负责 session 和顶层页面切换，业务页面独立。部署前同时备份 PostgreSQL、上传 volume 和当前源代码，迁移失败或健康检查失败时使用备份回滚。

**Tech Stack:** Node.js/Express、PostgreSQL、Vue 3、Docker Compose、Nginx、PowerShell、POSIX shell、Node Test Runner、Vitest。

## Global Constraints

- 不删除当前赛事；归档后才能清理附件或彻底删除。
- 赛事清理只处理该赛事的证书和导入文件；组织资质属于组织，不跟随某届赛事删除。
- 组织资质只有在组织已停用且管理员单独确认时才允许清理。
- 清理后的证书保留名称、奖项、成绩和 `cleanedAt`，用户看到“原文件已清理”。
- 彻底删除赛事必须提交完整赛事名称，用户、组织和成员关系不得随赛事删除。
- 部署前必须有可验证的数据库 dump、上传目录压缩包和源代码快照。
- 公网仍只开放 22 和 80；API 4300 与 PostgreSQL 5432 不能映射到宿主机。

---

### Task 1: 增加操作日志、后台概览和统一危险操作记录

**Files:**
- Create: `apps/api/src/data/migrations/004-audit-logs.sql`
- Create: `apps/api/src/services/audit.js`
- Create: `apps/api/src/routes/dashboard.js`
- Create: `apps/api/test/audit-dashboard.test.js`
- Create: `apps/admin/src/pages/DashboardPage.vue`
- Create: `apps/admin/src/pages/__tests__/DashboardPage.test.js`
- Modify: `apps/api/src/data/schema.sql`
- Modify: `apps/api/src/data/seed.js`
- Modify: `apps/api/src/data/postgres-store.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/admin/src/App.vue`

**Interfaces:**
- Produces: `recordAudit(db, { actor, action, targetType, targetId, summary, createdAt })`。
- Produces: `GET /api/admin/dashboard?eventId=` 和 `GET /api/admin/audit-logs`。
- Consumes: 前三个阶段的事件、组织、报名、证书和导入批次。

- [ ] **Step 1: 写日志和概览失败测试**

  测试管理员审核组织、批量发布证书和临时关闭赛事后分别产生一条 audit log；普通用户不能读取日志。概览断言：

  ```js
  assert.deepEqual(payload.counts, {
    registrations: 2,
    pendingRegistrations: 1,
    pendingOrganizations: 0,
    draftCertificates: 0
  });
  assert.equal(typeof payload.registrationWindow.open, "boolean");
  ```

  Run: `npm test -w apps/api -- --test-name-pattern="audit dashboard"`

  Expected: FAIL。

- [ ] **Step 2: 增加 audit_logs 表和 store 映射**

  `004-audit-logs.sql`：

  ```sql
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS audit_logs_target_idx ON audit_logs(target_type, target_id);
  ```

  file store 增加 `auditLogs ||= []`。保留最近日志不做自动删除；管理员列表默认按时间倒序分页。

- [ ] **Step 3: 在关键操作中记录日志**

  `recordAudit()`：

  ```js
  export function recordAudit(db, { actor, action, targetType, targetId, summary, createdAt = new Date().toISOString() }) {
    const row = {
      id: `A${crypto.randomUUID()}`,
      actorUserId: actor?.id || null,
      actorName: actor?.name || "系统",
      action,
      targetType,
      targetId,
      summary,
      createdAt
    };
    db.auditLogs.unshift(row);
    return row;
  }
  ```

  接入组织审核、报名审核、赛事状态、Excel commit、证书发布/撤回、证书删除、附件清理和赛事删除。日志摘要不得保存密码、session、文件路径或完整手机号。

- [ ] **Step 4: 实现 dashboard API 与页面**

  API 返回当前/选中赛事、报名窗口、统计数量、最近五条导入和最近十条操作。`DashboardPage.vue` 显示状态卡片并提供到待审核组织、待审核报名和未发布证书的快捷跳转。

- [ ] **Step 5: 运行测试并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="audit dashboard"`

  Run: `npm test -w apps/admin -- --run DashboardPage`

  Expected: PASS。

  ```bash
  git add apps/api apps/admin/src/pages/DashboardPage.vue apps/admin/src/pages/__tests__/DashboardPage.test.js apps/admin/src/App.vue
  git commit -m "feat: add admin dashboard and audit log"
  ```

### Task 2: 实现附件统计、历史清理和赛事危险删除

**Files:**
- Create: `apps/api/src/services/resource-cleanup.js`
- Create: `apps/api/src/routes/resources.js`
- Create: `apps/api/test/resource-cleanup.test.js`
- Create: `apps/admin/src/components/ResourceCleanupPanel.vue`
- Create: `apps/admin/src/components/DangerConfirmationDialog.vue`
- Create: `apps/admin/src/components/__tests__/ResourceCleanupPanel.test.js`
- Modify: `apps/api/src/routes/events.js`
- Modify: `apps/api/src/routes/organizations.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/admin/src/pages/EventManagementPage.vue`
- Modify: `apps/admin/src/pages/OrganizationManagementPage.vue`

**Interfaces:**
- Produces: `GET /api/admin/events/:id/storage`、`POST /api/admin/events/:id/cleanup`、`DELETE /api/admin/events/:id`。
- Produces: `POST /api/admin/organizations/:id/credential-cleanup`。
- Consumes: certificate/import/organization file metadata and audit service。

- [ ] **Step 1: 写资源清理失败测试**

  使用临时上传目录创建两届赛事证书文件，断言清理归档赛事只删除目标赛事文件，保留另一届和组织资质；证书记录仍存在且 `cleanedAt` 非空。未归档赛事清理返回 409，删除当前赛事返回 409，确认名称不一致返回 422。

  ```js
  const cleanup = await fetch(`${baseUrl}/api/admin/events/${archived.id}/cleanup`, withSession(admin.cookie, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categories: ["certificates", "imports"] })
  }));
  assert.equal(cleanup.status, 200);
  assert.equal(await fileExists(targetCertificate.filePath), false);
  assert.equal(await fileExists(otherEventCertificate.filePath), true);
  assert.equal(await fileExists(organizationCredential.filePath), true);
  ```

  Run: `npm test -w apps/api -- --test-name-pattern="resource cleanup"`

  Expected: FAIL。

- [ ] **Step 2: 实现资源统计和两阶段清理**

  `summarizeEventStorage(db, eventId)` 通过 registrations 找到 certificates 和 import batches，返回文件数与总字节。清理时先收集文件记录并把证书 `cleanedAt`、路径和 storedName 更新为清理状态；数据库写入成功后逐个删除物理文件，失败项返回 `failedFiles` 并写 audit log，下一次清理可以重试。

  响应：

  ```js
  { certificateFiles: 18, importFiles: 2, totalBytes: 8451200, deletedFiles: 20, failedFiles: [] }
  ```

- [ ] **Step 3: 实现组织资质独立清理**

  只允许 `organization.status === 'disabled'`。请求必须提交 `{ confirmName: organization.name }`；清理后资质元数据保留 `cleanedAt`，组织仍可查询但重新启用前必须上传新资质并重新审核。

- [ ] **Step 4: 实现彻底删除赛事**

  条件：赛事已归档、不是 current、`confirmName === event.name`。删除顺序：收集文件 → 删除 certificate import errors/certificates/results/registrations/project_groups/projects/import_batches/event → 提交数据库 → 删除物理文件 → 记录 audit。用户、组织、membership 不删除。

  如果物理文件删除失败，API 返回 `200` 并附 `failedFiles`，数据库删除已完成，日志记录残留路径供服务器管理员清理。

- [ ] **Step 5: 实现资源和危险操作 UI**

  归档赛事详情显示证书、导入文件数量和磁盘占用；“清理附件”先展示影响范围并二次确认；“彻底删除”要求输入完整赛事名称。组织资质清理只在停用组织详情中出现。

- [ ] **Step 6: 运行测试并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="resource cleanup"`

  Run: `npm test -w apps/admin -- --run ResourceCleanupPanel`

  Expected: PASS。

  ```bash
  git add apps/api/src/services/resource-cleanup.js apps/api/src/routes/resources.js apps/api/src/routes/events.js apps/api/src/routes/organizations.js apps/api/src/server.js apps/api/test/resource-cleanup.test.js apps/admin/src
  git commit -m "feat: clean archived event resources safely"
  ```

### Task 3: 完成后台模块化和用户侧历史页面

**Files:**
- Create: `apps/admin/src/pages/UserManagementPage.vue`
- Create: `apps/admin/src/pages/RegistrationRecordsPage.vue`
- Create: `apps/admin/src/pages/MyCertificatesPage.vue`
- Create: `apps/admin/src/pages/OrganizationConsolePage.vue`
- Create: `apps/admin/src/pages/__tests__/AppNavigation.test.js`
- Create: `apps/admin/src/styles/admin.css`
- Create: `apps/admin/src/styles/forms.css`
- Create: `apps/admin/src/styles/tables.css`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/main.js`
- Modify: `apps/admin/src/styles.css`

**Interfaces:**
- Produces: 顶层 `App.vue` 只协调 `useSession()`、当前 view 和页面事件。
- Produces: 用户/组织页面从 session API 读取数据，不读取管理员全量 API。
- Consumes: 前三阶段所有页面与 API。

- [ ] **Step 1: 写角色导航失败测试**

  `AppNavigation.test.js` 分别 mock admin、ordinary、organization session，断言：管理员可见七个后台模块；普通用户只见报名、报名记录、证书；组织 pending 只见审核进度；组织 approved 可见组织控制台。另为 `UserManagementPage` 断言状态筛选、组织关系入口和报名历史入口存在。

  ```js
  expect(adminWrapper.text()).toContain("赛事管理");
  expect(ordinaryWrapper.text()).not.toContain("组织用户管理");
  expect(pendingOrgWrapper.text()).toContain("组织资料正在审核");
  expect(pendingOrgWrapper.text()).not.toContain("邀请成员");
  ```

  Run: `npm test -w apps/admin -- --run AppNavigation`

  Expected: FAIL，现有 App 仍包含全部业务模板和旧角色分支。

- [ ] **Step 2: 抽取剩余页面**

  把用户管理、报名记录、本人证书和组织控制台分别移动到独立组件。每个页面只接收最小 props 或自行调用 API；不共享可变表单对象。`UserManagementPage` 保留创建、修改、启用、停用和查询，详情抽屉增加该用户的组织关系与跨赛事报名记录。`MyCertificatesPage` 对 cleaned 文件显示“原文件已清理”，对图片和 PDF 使用统一下载接口。

- [ ] **Step 3: 简化 App 和样式入口**

  `App.vue` 保留：

  ```vue
  <AuthPage v-if="!user" @authenticated="session.restore" />
  <AdminShell v-else-if="user.type === 'admin'" v-model:view="view">
    <component :is="adminPages[view]" @navigate="view = $event" />
  </AdminShell>
  <UserShell v-else v-model:view="view">
    <component :is="userPages[view]" />
  </UserShell>
  ```

  `styles.css` 只导入 reset、通用 token、`admin.css`、`forms.css` 和 `tables.css`。删除已无 DOM 使用的旧选择器。

- [ ] **Step 4: 运行测试、构建并提交**

  Run: `npm test -w apps/admin`

  Run: `npm run build`

  Expected: PASS；`App.vue` 不再包含报名表、证书表或组织表的具体字段模板。

  ```bash
  git add apps/admin/src
  git commit -m "refactor: split admin and user application pages"
  ```

### Task 4: 增加上传文件备份、升级预检和恢复验证

**Files:**
- Create: `deploy/backup-uploads.sh`
- Create: `deploy/verify-uploads-backup.sh`
- Create: `deploy/preflight-admin-upgrade.sh`
- Modify: `compose.yaml`
- Modify: `deploy/backup-postgres.sh`
- Modify: `deploy/remote-smoke-test.sh`
- Modify: `deploy/verify-config.ps1`
- Modify: `docs/deployment/aliyun-test.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `docker compose run --rm backup /bin/sh /scripts/backup-uploads.sh once`。
- Produces: `preflight-admin-upgrade.sh` 在切换容器前验证 DB dump、上传归档、session secret 和磁盘空间。
- Consumes: `postgres_data`、`uploads_data` 和 `/opt/aerogp/backups`。

- [ ] **Step 1: 扩展静态部署验证并确认失败**

  `verify-config.ps1` 新增断言：API 有 `SESSION_SECRET`；backup service 只读挂载 `uploads_data:/uploads:ro`；备份目录可写；脚本不把 `.env` 或密码输出到日志。

  Run: `powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1`

  Expected: FAIL，Compose 尚未挂载上传 volume 给 backup。

- [ ] **Step 2: 实现上传目录备份和校验**

  `backup-uploads.sh`：

  ```sh
  #!/bin/sh
  set -eu
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  output="/backups/uploads/aerogp-uploads-${timestamp}.tar.gz"
  mkdir -p /backups/uploads
  tar -C /uploads -czf "$output" .
  test -s "$output"
  find /backups/uploads -type f -name 'aerogp-uploads-*.tar.gz' -mtime +7 -delete
  printf '%s\n' "$output"
  ```

  `verify-uploads-backup.sh` 使用 `tar -tzf` 检查归档可读且拒绝 `../` 路径。Compose backup 增加 `/uploads:ro` 和 `/backups/uploads`。

- [ ] **Step 3: 实现升级预检**

  `preflight-admin-upgrade.sh` 检查：最新数据库 dump 可由 `pg_restore --list` 读取、最新 uploads tar 可列出、`.env` 中 `SESSION_SECRET` 长度至少 32、磁盘剩余空间大于当前 uploads 的两倍加 1 GB、当前四个容器健康。

  失败立即非零退出，不运行 `docker compose up`。

- [ ] **Step 4: 更新远程冒烟测试**

  脚本使用 cookie jar 登录测试管理员，再验证：

  ```sh
  curl -fsS -c /tmp/aerogp-cookie -H 'Content-Type: application/json' \
    -d '{"phone":"13900000000","password":"admin123"}' \
    http://127.0.0.1/api/auth/login
  curl -fsS -b /tmp/aerogp-cookie http://127.0.0.1/api/admin/events
  test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/api/admin/events)" = "401"
  ```

  测试密码从 root-only 环境变量传入时，脚本不得使用 shell trace；正式部署后替换默认管理员密码。

- [ ] **Step 5: 运行配置检查并提交**

  Run: `powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1`

  Expected: PASS。

  Run: `docker compose config --quiet`

  Expected: PASS；若本机没有 `.env`，使用临时 `POSTGRES_PASSWORD` 和 `SESSION_SECRET` 环境变量运行。

  ```bash
  git add deploy compose.yaml docs/deployment/aliyun-test.md .gitignore
  git commit -m "ops: back up uploads before platform upgrades"
  ```

### Task 5: 全量验收并发布到阿里云测试服务器

**Files:**
- Modify: `docs/deployment/aliyun-test.md`
- No application source changes unless a verification step exposes a defect; any defect follows a new failing test before repair。

**Interfaces:**
- Consumes: 阶段一至四全部产物。
- Produces: 服务器 `/opt/aerogp` 上健康的 `web`、`api`、`postgres`、`backup` 服务和验证记录。

- [ ] **Step 1: 本地全量验证**

  Run: `npm test -w apps/api`

  Run: `npm test -w apps/admin`

  Run: `npm run build`

  Run: `powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1`

  Run: `$env:POSTGRES_PASSWORD='test-only-compose-password'; $env:SESSION_SECRET='test-only-session-secret-32-characters'; docker compose config --quiet`

  Expected: 全部 PASS，无未处理 warning 或失败测试。

- [ ] **Step 2: 在服务器创建三类升级前备份并准备 session secret**

  Run:

  ```bash
  ssh aerogp 'cd /opt/aerogp && if ! grep -q "^SESSION_SECRET=" .env; then printf "SESSION_SECRET=%s\n" "$(openssl rand -hex 32)" >> .env; fi && chmod 600 .env'
  ssh aerogp "cd /opt/aerogp && docker compose run --rm backup /bin/sh /scripts/backup-postgres.sh once"
  ssh aerogp 'cd /opt/aerogp && mkdir -p backups/uploads && docker compose exec -T api tar -C /data/uploads -czf - . > backups/uploads/uploads-before-admin-upgrade.tar.gz && tar -tzf backups/uploads/uploads-before-admin-upgrade.tar.gz >/dev/null'
  ssh aerogp "cd /opt/aerogp && tar --exclude='./backups' --exclude='./.env' -czf backups/source-before-admin-upgrade.tgz ."
  scp deploy/preflight-admin-upgrade.sh aerogp:/tmp/preflight-admin-upgrade.sh
  ssh aerogp "cd /opt/aerogp && /bin/sh /tmp/preflight-admin-upgrade.sh"
  ```

  Expected: session secret 已存在且 `.env` 权限为 600；数据库、上传文件和源码备份均非空；预检 PASS。

- [ ] **Step 3: 上传已提交源码并重建容器**

  从本地已提交 commit 生成发布包，不包含 `.git`、`.env`、`backups`、`node_modules` 和上传文件：

  ```bash
  git archive --format=tar.gz -o aerogp-admin-upgrade.tar.gz HEAD
  scp aerogp-admin-upgrade.tar.gz aerogp:/tmp/
  ssh aerogp "cd /opt/aerogp && tar -xzf /tmp/aerogp-admin-upgrade.tar.gz && docker compose config --quiet && docker compose up -d --build"
  ```

  Expected: 构建完成，数据 volume 未重建。

- [ ] **Step 4: 验证数据库迁移、容器和端口**

  Run:

  ```bash
  ssh aerogp "cd /opt/aerogp && docker compose ps && docker compose logs --tail=150 api web postgres backup"
  ssh aerogp "cd /opt/aerogp && /bin/sh deploy/remote-smoke-test.sh"
  ssh aerogp "ss -lntp"
  ```

  Expected: 四个服务 healthy；公开首页、`/admin/`、`/api/public/event` 返回 200；无会话管理员 API 返回 401；登录后返回 200；宿主机只监听预期的 22 和 80，不监听 4300/5432。

- [ ] **Step 5: 执行浏览器角色验收**

  使用测试数据依次验证：

  1. 普通与组织注册表单输入互不影响。
  2. 新组织上传虚构资质，管理员审核后才出现组织控制台。
  3. 创建一届临时赛事，复制赛项并切换 current，再切回原测试赛事。
  4. 普通用户报名时学校可搜索、组织自动匹配、五年级显示小学高段。
  5. 管理员报名表看到指导老师，刷新、筛选和完整 Excel 导出正常。
  6. 导出证书模板，插入两张测试 PNG，预检查、确认导入、预览和批量发布正常。
  7. 手动替换一张为 PDF，撤回、发布、删除另一张均正常。
  8. 普通用户只能下载本人已发布证书。
  9. 归档临时赛事，附件统计和二次确认界面正确；测试环境中只清理专门创建的临时附件。

- [ ] **Step 6: 故障时回滚，成功时记录发布**

  若 API 迁移或健康检查失败，不继续浏览器验收。恢复源码并重建：

  ```bash
  ssh aerogp "cd /opt/aerogp && tar -xzf backups/source-before-admin-upgrade.tgz && docker compose up -d --build"
  ```

  只有数据库数据被新版本破坏时，才按运维手册使用升级前 dump 执行显式 `CONFIRM_RESTORE=yes` 恢复；上传文件同理由升级前 tar 恢复。不得删除 named volumes。

  成功后在 `docs/deployment/aliyun-test.md` 记录发布日期、部署 commit、备份文件名和验证结果，并提交：

  ```bash
  git add docs/deployment/aliyun-test.md
  git commit -m "docs: record admin platform test deployment"
  ```

## 阶段四完成检查

Expected: 后台各业务页面独立可维护；操作有审计；历史赛事可以统计和清理附件；组织资质不会随赛事误删；数据库、上传文件和源码均可回滚；阿里云测试站完成三角色全流程验证。
