# AeroGP 管理平台阶段一：基础、安全会话与多届赛事 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不丢失现有数据的前提下建立可迁移的数据基础、服务端会话认证、四组年级规则和可操作的多届赛事管理。

**Architecture:** 保留 Express、PostgreSQL、文件存储回退和 Vue 3。先把纯业务规则提取成可测试模块，再扩展 schema 与 store；认证改为 PostgreSQL 会话和渐进式密码摘要升级；赛事路由独立成 Router，管理端新增赛事页面但仍由现有 `App.vue` 负责顶层视图切换。

**Tech Stack:** Node.js 22、Express 4、PostgreSQL 16、pg/pg-mem、bcryptjs、express-session、connect-pg-simple、Vue 3、Vite 6、Vitest、Vue Test Utils。

## Global Constraints

- 当前赛事必须迁移为第一届当前赛事，现有用户、组织、报名、成绩和证书不得重建或清空。
- 组别名称固定为“小学低段”“小学高段”“中学组”“职高/高中组”。
- 报名控制模式固定为 `automatic`、`force_open`、`force_closed`。
- 所有受保护 API 必须从服务端会话读取身份，不再使用 `actorUserId` 或查询参数中的 `userId` 授权。
- 密码不得继续以明文写入；旧明文密码在首次成功登录时升级为 bcrypt 摘要。
- 本阶段每项业务修改先写失败测试，再实现最小代码，再运行完整相关测试并提交。

---

### Task 1: 固化年级、报名窗口和赛事数据库迁移

**Files:**
- Create: `apps/api/src/domain/grades.js`
- Create: `apps/api/src/domain/registration-window.js`
- Create: `apps/api/src/data/migrations/001-admin-platform.sql`
- Create: `apps/api/test/event-domain.test.js`
- Modify: `apps/api/src/data/schema.sql`
- Modify: `apps/api/src/data/seed.js`
- Modify: `apps/api/src/data/postgres-store.js`
- Modify: `apps/api/test/postgres-store.test.js`

**Interfaces:**
- Produces: `groupForGrade(grade): string | null`、`isRegistrationOpen(event, now): { open: boolean, reason: string }`。
- Produces: `readDb()` 返回 `events`、`projects`、`projectGroups`；每条 registration 增加 `eventId`。
- Consumes: 现有 `createPostgresStore(pool)`、`ensureDbShape(db)` 和种子赛事数据。

- [ ] **Step 1: 写年级映射和报名三态的失败测试**

  新建 `apps/api/test/event-domain.test.js`：

  ```js
  import assert from "node:assert/strict";
  import test from "node:test";

  import { groupForGrade } from "../src/domain/grades.js";
  import { isRegistrationOpen } from "../src/domain/registration-window.js";

  test("maps school grades into the four approved groups", () => {
    assert.equal(groupForGrade("一年级"), "小学低段");
    assert.equal(groupForGrade("六年级"), "小学高段");
    assert.equal(groupForGrade("初三"), "中学组");
    assert.equal(groupForGrade("高二"), "职高/高中组");
    assert.equal(groupForGrade("职高一年级"), "职高/高中组");
    assert.equal(groupForGrade("大学一年级"), null);
  });

  test("registration override wins over scheduled dates", () => {
    const event = {
      registrationStartAt: "2026-10-01T00:00:00.000Z",
      registrationEndAt: "2026-10-31T15:59:59.000Z",
      registrationMode: "automatic"
    };
    assert.equal(isRegistrationOpen(event, new Date("2026-10-15T00:00:00.000Z")).open, true);
    assert.equal(isRegistrationOpen({ ...event, registrationMode: "force_closed" }, new Date("2026-10-15T00:00:00.000Z")).open, false);
    assert.equal(isRegistrationOpen({ ...event, registrationMode: "force_open" }, new Date("2027-01-01T00:00:00.000Z")).open, true);
  });
  ```

- [ ] **Step 2: 扩展 PostgreSQL 结构测试并确认失败**

  在 `postgres-store.test.js` 增加断言：

  ```js
  const eventColumns = await pool.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'events'
  `);
  const names = new Set(eventColumns.rows.map((row) => row.column_name));
  for (const name of ["registration_start_at", "registration_end_at", "registration_mode", "status", "is_current", "archived_at"]) {
    assert.equal(names.has(name), true, `missing events.${name}`);
  }

  const db = await store.readDb();
  assert.equal(db.events.filter((event) => event.isCurrent).length, 1);
  assert.equal(db.registrations.every((row) => row.eventId), true);
  ```

  Run: `npm test -w apps/api -- --test-name-pattern="grade|registration override|PostgreSQL"`

  Expected: FAIL，提示 domain 模块不存在或赛事字段缺失。

- [ ] **Step 3: 实现纯业务规则**

  `grades.js` 使用规范化后的完整值匹配，不用模糊数字猜测：

  ```js
  export const GRADE_GROUPS = [
    { id: "primary_lower", name: "小学低段", grades: ["一年级", "二年级", "三年级"] },
    { id: "primary_upper", name: "小学高段", grades: ["四年级", "五年级", "六年级"] },
    { id: "middle_school", name: "中学组", grades: ["初一", "初二", "初三"] },
    { id: "high_vocational", name: "职高/高中组", grades: ["高一", "高二", "高三", "职高一年级", "职高二年级", "职高三年级"] }
  ];

  export function groupForGrade(value) {
    const grade = String(value || "").trim();
    return GRADE_GROUPS.find((group) => group.grades.includes(grade))?.name || null;
  }
  ```

  `registration-window.js`：

  ```js
  export function isRegistrationOpen(event, now = new Date()) {
    if (event.registrationMode === "force_open") return { open: true, reason: "管理员临时开放" };
    if (event.registrationMode === "force_closed") return { open: false, reason: "管理员临时关闭" };
    const current = now.getTime();
    const start = new Date(event.registrationStartAt).getTime();
    const end = new Date(event.registrationEndAt).getTime();
    if (current < start) return { open: false, reason: "报名尚未开始" };
    if (current > end) return { open: false, reason: "报名已截止" };
    return { open: true, reason: "报名进行中" };
  }
  ```

- [ ] **Step 4: 编写可重复执行的赛事迁移并更新 store**

  `001-admin-platform.sql` 至少包含：

  ```sql
  ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_start_at TIMESTAMPTZ;
  ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_end_at TIMESTAMPTZ;
  ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_mode TEXT NOT NULL DEFAULT 'automatic';
  ALTER TABLE events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';
  ALTER TABLE events ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE events ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
  ALTER TABLE events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

  UPDATE events
  SET registration_start_at = COALESCE(registration_start_at, created_at),
      registration_end_at = COALESCE(registration_end_at, (registration_deadline || ' 23:59:59+08')::timestamptz);
  ALTER TABLE events ALTER COLUMN registration_start_at SET NOT NULL;
  ALTER TABLE events ALTER COLUMN registration_end_at SET NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS events_single_current_key
    ON events ((is_current)) WHERE is_current = TRUE;

  ALTER TABLE projects ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS instructor_required BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS project_groups (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    group_name TEXT NOT NULL,
    PRIMARY KEY (project_id, group_name)
  );
  ```

  `initialize()` 在 `schema.sql` 后按文件名顺序执行 migrations。只在事件不存在时插入种子赛事，不能在每次启动时覆盖管理员编辑。首次迁移将 `wz-aerospace-2026` 设为当前赛事，补齐起止时间，并为全部现有项目写入四个组别。

  `readDb()` 映射：

  ```js
  {
    events: eventRows,
    projects: projectRows.map((row) => ({ ...row, allowedGroups: groupsByProject[row.id] || [] })),
    registrations: registrationRows.map((row) => ({ ...mappedRegistration, eventId: row.event_id }))
  }
  ```

- [ ] **Step 5: 运行测试并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="grade|registration override|PostgreSQL"`

  Expected: PASS，且空库只有一个当前赛事。

  Run: `npm test -w apps/api`

  Expected: 全部现有 API 测试 PASS。

  ```bash
  git add apps/api/src/domain apps/api/src/data apps/api/test/event-domain.test.js apps/api/test/postgres-store.test.js
  git commit -m "feat: add multi-event data foundation"
  ```

### Task 2: 建立密码摘要和服务端会话

**Files:**
- Create: `apps/api/src/auth/passwords.js`
- Create: `apps/api/src/auth/session.js`
- Create: `apps/api/src/auth/password-reset.js`
- Create: `apps/api/src/auth/sms.js`
- Create: `apps/api/src/data/migrations/002-auth-security.sql`
- Create: `apps/api/test/auth-session.test.js`
- Create: `apps/api/test/password-reset.test.js`
- Modify: `apps/api/src/data/index.js`
- Modify: `apps/api/src/data/postgres-store.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Modify: `compose.yaml`
- Modify: `deploy/bootstrap-secrets.sh`

**Interfaces:**
- Produces: `hashPassword(password)`、`verifyPassword(password, storedHash)`、`isLegacyPassword(storedHash)`。
- Produces: `requireUser(req,res,next)`、`requireAdmin(req,res,next)`；认证成功后 `req.user` 为当前用户。
- Produces: `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`。
- Produces: 管理员临时密码重置，以及阿里云短信验证码自助重置；两种改密方式都会使旧会话失效。
- Consumes: `dataStore.pool` 用于生产 PostgreSQL session store。

- [ ] **Step 1: 安装认证依赖并写失败测试**

  Run: `npm install -w apps/api bcryptjs express-session connect-pg-simple`

  `auth-session.test.js` 使用临时文件库启动 API，并验证：

  ```js
test("login upgrades a legacy password and restores the user from a session", async () => {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13900000000", password: "admin123" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, /^aerogp\.sid=/);

    const denied = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(allowed.status, 200);
  });
  ```

  Run: `npm test -w apps/api -- --test-name-pattern="login upgrades"`

  Expected: FAIL，当前登录不创建 session cookie，也没有 `/api/auth/me`。

- [ ] **Step 2: 实现密码工具**

  `passwords.js`：

  ```js
  import bcrypt from "bcryptjs";

  export const isLegacyPassword = (value) => !String(value || "").startsWith("$2");
  export const hashPassword = (value) => bcrypt.hash(String(value), 12);

  export async function verifyPassword(value, stored) {
    if (isLegacyPassword(stored)) return String(value) === String(stored);
    return bcrypt.compare(String(value), stored);
  }
  ```

  注册、重置密码和管理员创建用户全部调用 `hashPassword()`。登录成功且检测到旧明文时，立即写回摘要后再创建 session。

- [ ] **Step 3: 实现 session middleware**

  `dataStore` 在 PostgreSQL 模式暴露只读 `pool` 属性。`session.js`：

  ```js
  import session from "express-session";
  import connectPgSimple from "connect-pg-simple";

  export function createSessionMiddleware({ env, dataStore }) {
    const secret = env.SESSION_SECRET || (env.NODE_ENV === "test" ? "test-session-secret-32-characters" : "");
    if (!secret) throw new Error("SESSION_SECRET is required");
    const PgStore = connectPgSimple(session);
    const store = dataStore.kind === "postgres"
      ? new PgStore({ pool: dataStore.pool, createTableIfMissing: true })
      : new session.MemoryStore();
    return session({
      name: "aerogp.sid",
      secret,
      store,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 8 * 60 * 60 * 1000 }
    });
  }

  export function requireUser(req, res, next) {
    if (!req.user) return res.status(401).json({ error: "请先登录" });
    next();
  }

  export function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: "请先登录" });
    if (req.user.type !== "admin") return res.status(403).json({ error: "只有管理员可以执行此操作" });
    next();
  }
  ```

  session middleware 后增加用户解析 middleware：按 `req.session.userId` 从 store 读取 active 用户并写入 `req.user`。

- [ ] **Step 4: 增加登录、退出和当前用户接口**

  登录成功执行：

  ```js
  req.session.userId = user.id;
  await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
  res.json({ user: publicUser(user) });
  ```

  退出使用 `req.session.destroy()`；`GET /api/auth/me` 返回当前会话用户或 `401`。API 响应不得包含密码字段。

  `.env.example` 增加 `SESSION_SECRET=`；`bootstrap-secrets.sh` 使用 `openssl rand -hex 32` 生成并写入 root-only `.env`；Compose 把该变量传入 API。

- [ ] **Step 5: 实现安全的双路径密码重置**

  删除或禁用公开的“姓名 + 手机号直接重置密码”接口，并为用户增加 `sessionVersion` 与 `mustChangePassword`。登录恢复会话时必须校验 session 中的版本；任何改密成功都递增版本并使旧会话失效。

  管理员接口为 `POST /api/admin/users/:id/reset-password`，只允许管理员调用，生成或接收符合规则的临时密码，并把 `mustChangePassword` 设为 `true`。

  短信自助接口为 `POST /api/auth/password-reset/sms/request` 和 `POST /api/auth/password-reset/sms/confirm`。验证码为 6 位，有效期 5 分钟，最多尝试 5 次；同手机号冷却 60 秒且每小时最多 5 次，来源 IP 每小时最多 20 次。验证码、尝试次数与限流事件持久化到 PostgreSQL，并依靠事务/原子写入支持多实例；文件测试库提供等价持久接口。申请接口返回统一正文和等价时序，不暴露手机号是否存在；短信发送进入异步派发，测试注入 fake SMS provider，不连接真实网络。

  阿里云短信使用官方 `@alicloud/dysmsapi20170525` SDK，凭据只从 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`、`ALIYUN_SMS_SIGN_NAME`、`ALIYUN_SMS_TEMPLATE_CODE` 读取，Endpoint 为 `dysmsapi.aliyuncs.com`。未配置时 `/api/public/features` 返回 `smsPasswordResetEnabled: false`，管理员重置不受影响。

  密码必须为 8–64 位并至少包含一个字母和一个数字。登录失败按 IP 与手机号限流，并在查询用户前检查限制；未知手机号执行 dummy bcrypt 校验，避免通过响应时间枚举账户。所有异步路由必须把错误交给 Express 错误处理中间件；退出时销毁会话并清理 cookie；生产 `SESSION_SECRET` 至少 32 字节。Cookie 根据反向代理后的 HTTP/HTTPS 自动设置 `Secure`。

- [ ] **Step 6: 运行认证测试并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="login upgrades"`

  Expected: PASS；无 cookie 访问 `/api/auth/me` 为 401，登录 cookie 恢复用户为 200。

  ```bash
  git add apps/api .env.example compose.yaml deploy/bootstrap-secrets.sh package-lock.json
  git commit -m "feat: secure API with server sessions"
  ```

### Task 3: 把现有受保护 API 全部切换到会话授权

**Files:**
- Create: `apps/api/test/helpers/api-client.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test/admin-users.test.js`
- Modify: `apps/api/test/certificates.test.js`
- Modify: `apps/api/test/data-store.test.js`

**Interfaces:**
- Produces: `loginAs(baseUrl, phone, password): Promise<{ cookie: string, user: object }>`。
- Produces: `GET /api/me/registrations`、`GET /api/me/certificates`，身份只来自 session。
- Produces: `POST /api/auth/change-password`；临时密码用户完成改密前只能访问当前用户、退出和改密接口。
- Consumes: Task 2 的 `requireUser`、`requireAdmin` 和 `req.user`。

- [ ] **Step 1: 新建测试客户端并先改一个管理员用例**

  `test/helpers/api-client.js`：

  ```js
  export async function loginAs(baseUrl, phone, password) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, password })
    });
    const payload = await response.json();
    return { cookie: response.headers.get("set-cookie").split(";")[0], user: payload.user };
  }

  export const withSession = (cookie, options = {}) => ({
    ...options,
    headers: { ...(options.headers || {}), Cookie: cookie }
  });
  ```

  把 `admin-users.test.js` 第一个创建用户请求改为携带管理员 cookie，不再提交 `actorUserId`。先运行该测试，确认当前路由因仍读取 actor 字段而失败。

- [ ] **Step 2: 给现有路由应用权限 middleware**

  路由规则固定为：

  ```js
  app.get("/api/users", requireAdmin, listUsers);
  app.post("/api/admin/users", requireAdmin, createUser);
  app.patch("/api/admin/users/:id", requireAdmin, updateUser);
  app.delete("/api/admin/users/:id", requireAdmin, deleteUser);
  app.get("/api/me/registrations", requireUser, listOwnRegistrations);
  app.get("/api/me/certificates", requireUser, listOwnCertificates);
  ```

  组织成员接口通过 `requireUser` 后，再检查 `req.user` 是否是目标组织 active owner/manager 或 admin。证书下载不再读取 `actorUserId` 查询参数。

  组织报名/证书列表必须同时限制 `registration.organizationId === 目标组织` 与报名用户是该组织 active member，不能因为用户同时加入多个组织而泄露私人或其他组织记录。角色层级固定：owner/admin 可邀请或管理 manager/member；manager 只能邀请或管理 member，不能创建 owner、不能移除 owner/manager；负责人转移留给独立流程。

  所有 `/api/admin/*`、全部报名列表/导出、证书管理和用户管理接口使用 `requireAdmin`。普通报名、重复检查、组织申请、本人报名/证书和证书下载使用 `requireUser`，写入的 `userId` 一律来自 `req.user.id`。`GET /api/organizations` 不再公开 memberships，只向已登录用户返回组织公开搜索字段。

  增加 `requirePasswordReady`：当 `req.user.mustChangePassword=true` 时，除 `/api/auth/me`、`/api/auth/logout`、`/api/auth/change-password` 外，受保护接口返回 `428` 与稳定错误码 `PASSWORD_CHANGE_REQUIRED`。本人改密必须校验当前密码，并拒绝新密码与当前密码相同；成功后递增 `sessionVersion`、清除 `mustChangePassword`，使其他旧会话失效并更新当前 session 版本。

- [ ] **Step 3: 更新所有 API 测试请求**

  管理员测试统一使用 `13900000000/admin123` 登录；组织负责人使用 `13800000011/123456`；普通用户使用 `13800000001/123456`。增加以下反向断言：

  ```js
  const ordinary = await loginAs(baseUrl, "13800000001", "123456");
  const forbidden = await fetch(`${baseUrl}/api/admin/users`, withSession(ordinary.cookie));
  assert.equal(forbidden.status, 403);
  ```

- [ ] **Step 4: 运行全量 API 测试并提交**

  Run: `npm test -w apps/api`

  Expected: 全部 PASS，生产路由和测试代码中 `rg "actorUserId|\?userId=|req\.query\.userId|req\.body\.userId" apps/api/src/server.js apps/api/test` 无结果。覆盖未登录 401、普通用户访问管理员接口 403、跨用户证书下载 403、非组织管理者 403、临时密码用户 428 及成功改密后其他 session 失效。

  ```bash
  git add apps/api/src/server.js apps/api/test
  git commit -m "refactor: authorize API routes from sessions"
  ```

### Task 4: 实现多届赛事与赛项管理 API

**Files:**
- Create: `apps/api/src/routes/events.js`
- Create: `apps/api/src/services/events.js`
- Create: `apps/api/test/event-management.test.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/data/postgres-store.js`

**Interfaces:**
- Produces: `GET/POST /api/admin/events`、`PATCH /api/admin/events/:id`、`POST /api/admin/events/:id/copy`、`POST /api/admin/events/:id/current`、`POST /api/admin/events/:id/archive`。
- Produces: `POST /api/admin/events/:eventId/projects`、`PATCH/DELETE /api/admin/projects/:id`。
- Produces: `GET /api/public/event` 返回 `{ event, projects, grades, registrationWindow }`。
- Consumes: Task 1 的组别与报名窗口函数、Task 2 的管理员 session。

- [ ] **Step 1: 写赛事 CRUD 失败测试**

  测试完整场景：管理员新建草稿赛事、复制当前赛事、设置新赛事为 current、临时关闭、归档旧赛事；复制结果包含赛项但没有报名。核心断言：

  ```js
  assert.equal(created.status, "draft");
  assert.equal(copy.projects.length, source.projects.length);
  assert.equal(copy.registrationCount, 0);
  assert.equal(events.filter((row) => row.isCurrent).length, 1);
  assert.equal(publicPayload.registrationWindow.open, false);
  assert.equal(publicPayload.registrationWindow.reason, "管理员临时关闭");
  ```

  同时测试已有报名的赛项 `DELETE` 返回 `409`，停用 `PATCH` 返回 `200`。

  报名 API 必须真正消费赛事配置：只允许当前已发布赛事在实时窗口开放时报名；项目必须属于当前赛事、已启用且允许所选固定组别；新报名写入当前 `eventId`。临时开放/关闭不能只影响页面展示。

  Run: `npm test -w apps/api -- --test-name-pattern="event management"`

  Expected: FAIL，赛事管理路由不存在。

- [ ] **Step 2: 实现赛事服务的事务规则**

  `events.js` service 导出：

  ```js
  export async function setCurrentEvent(db, eventId) {
    const target = db.events.find((row) => row.id === eventId);
    if (!target) throw Object.assign(new Error("赛事不存在"), { status: 404 });
    for (const event of db.events) event.isCurrent = event.id === eventId;
    target.status = "published";
    target.updatedAt = new Date().toISOString();
    return target;
  }

  export function copyEvent(db, sourceId, input, makeId) {
    const source = db.events.find((row) => row.id === sourceId);
    if (!source) throw Object.assign(new Error("赛事不存在"), { status: 404 });
    const event = { ...source, id: makeId("E"), name: input.name, status: "draft", isCurrent: false, archivedAt: "" };
    const projects = db.projects.filter((row) => row.eventId === sourceId).map((row) => ({ ...row, id: makeId("P"), eventId: event.id }));
    db.events.push(event);
    db.projects.push(...projects);
    return { event, projects, registrationCount: 0 };
  }
  ```

  所有管理操作在一次 `readDb`/`writeDb` 周期中完成；PostgreSQL store 保持一次事务写入。

  复制赛事同时复制项目及其 `projectGroups`，项目使用新 ID；不复制报名、证书或成绩。设置当前赛事后数据库中必须恰好一条 `isCurrent=true`，并使用 PostgreSQL 唯一约束兜底。

- [ ] **Step 3: 建立 Router 和输入校验**

  路由统一使用 `requireAdmin` 和 `requirePasswordReady`。赛事写入只接受允许字段；起止时间必须是严格 ISO 8601 时间且开始早于截止；`null`/非对象请求体返回 422；报名模式和值域严格校验。项目 `allowedGroups` 必须是四个固定组别的非空子集，项目类型只允许 `individual/team`。已有报名的项目不可硬删除，但可停用。

  PostgreSQL 启动兼容只为“完全没有 project_groups”的旧赛项一次性补齐四组；已由管理员保存的子集不得在重启/initialize 后被补回。种子组别也只在项目首次创建时写入。

  ```js
  router.patch("/events/:id", async (req, res, next) => {
    try {
      const db = await store.readDb();
      const event = updateEvent(db, req.params.id, req.body);
      await store.writeDb(db);
      res.json({ row: event });
    } catch (error) {
      next(error);
    }
  });
  ```

- [ ] **Step 4: 让公开赛事接口读取数据库**

  移除 `EVENT/PROJECTS/GRADES` 的静态响应和报名校验依赖。只返回 `isCurrent && status === "published"` 的赛事、该赛事启用项目、四个固定组别和实时 `registrationWindow`。为保持官网兼容，赛事 payload 继续提供 `date`、`venue`、`registrationDeadline`、`contact`，其中 `date` 来自数据库 `dateLabel`，`registrationDeadline` 来自 `registrationEndAt` 的北京时间日期。没有当前赛事时返回 `503` 和明确错误。

- [ ] **Step 5: 运行测试并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="event management|registration override"`

  Expected: PASS。

  Run: `npm test -w apps/api`

  Expected: 全部 PASS。

  ```bash
  git add apps/api/src/routes/events.js apps/api/src/services/events.js apps/api/src/server.js apps/api/src/data/postgres-store.js apps/api/test/event-management.test.js
  git commit -m "feat: manage events and projects"
  ```

### Task 5: 建立管理端测试基础并交付赛事管理页面

**Files:**
- Create: `apps/admin/src/lib/api.js`
- Create: `apps/admin/src/state/session.js`
- Create: `apps/admin/src/components/AdminShell.vue`
- Create: `apps/admin/src/pages/EventManagementPage.vue`
- Create: `apps/admin/src/pages/__tests__/EventManagementPage.test.js`
- Create: `apps/admin/vitest.config.js`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/main.js`
- Modify: `apps/admin/src/styles.css`
- Modify: `apps/admin/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `api(path, options)` 默认 `credentials: "include"`。
- Produces: `useSession()` 暴露 `user`、`restore()`、`login()`、`logout()`。
- Produces: `EventManagementPage` emits `event-changed`，供 App 刷新当前赛事。
- Consumes: Task 4 的赛事 API。

- [ ] **Step 1: 安装 Vue 测试依赖并写页面失败测试**

  Run: `npm install -D -w apps/admin vitest @vue/test-utils jsdom`

  `EventManagementPage.test.js` mock `api`，验证赛事表格、三态按钮和复制操作：

  ```js
  import { mount } from "@vue/test-utils";
  import { describe, expect, it, vi } from "vitest";
  import EventManagementPage from "../EventManagementPage.vue";

  vi.mock("../../lib/api.js", () => ({
    api: vi.fn(async () => ({ rows: [{ id: "E1", name: "2026赛事", registrationMode: "automatic", isCurrent: true }], projects: [] }))
  }));

  it("shows current event and all registration controls", async () => {
    const wrapper = mount(EventManagementPage);
    await new Promise((resolve) => setTimeout(resolve));
    expect(wrapper.text()).toContain("2026赛事");
    expect(wrapper.text()).toContain("自动");
    expect(wrapper.text()).toContain("临时开放");
    expect(wrapper.text()).toContain("临时关闭");
  });
  ```

  Run: `npm test -w apps/admin`

  Expected: FAIL，页面和测试配置不存在。

- [ ] **Step 2: 实现同源 API 与 session state**

  `lib/api.js`：

  ```js
  const API = import.meta.env.VITE_API_URL || "";

  export async function api(path, options = {}) {
    const form = options.body instanceof FormData;
    const response = await fetch(`${API}${path}`, {
      credentials: "include",
      ...options,
      headers: form ? options.headers : { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
    return payload;
  }
  ```

  `state/session.js` 使用模块级 `ref` 保存用户，首次启动调用 `/api/auth/me`；退出清空用户并回到登录页。

- [ ] **Step 3: 实现后台外壳和赛事页面**

  `AdminShell.vue` 提供“概览、赛事管理、赛项与组别、组织用户、报名管理、证书管理、普通用户管理”菜单和插槽。`EventManagementPage.vue` 包含赛事列表、基础资料表单、报名起止时间、三态按钮、当前赛事、复制、归档和赛项编辑区域。

  提交临时关闭时发送：

  ```js
  await api(`/api/admin/events/${selectedId.value}`, {
    method: "PATCH",
    body: JSON.stringify({ registrationMode: "force_closed" })
  });
  await loadEvents();
  emit("event-changed");
  ```

  已有报名的赛项隐藏“删除”，显示“停用”。四组使用固定复选框，不提供自由文本名称。

- [ ] **Step 4: 在 App 中切换管理员新页面**

  登录恢复后管理员默认进入后台概览；菜单切换到 `events` 时加载 `EventManagementPage`。非管理员不能渲染 `AdminShell`。保留普通用户和组织用户的现有页面，后续阶段再拆分。

- [ ] **Step 5: 运行测试、构建并提交**

  Run: `npm test -w apps/admin`

  Expected: PASS。

  Run: `npm run build`

  Expected: web 和 admin 均构建成功。

  ```bash
  git add apps/admin package-lock.json
  git commit -m "feat: add event management console"
  ```

## 阶段一完成检查

Run: `npm test -w apps/api`

Run: `npm test -w apps/admin`

Run: `npm run build`

Expected: 全部 PASS；当前测试赛事、用户与报名仍存在；无会话访问管理员 API 返回 401；管理员可以创建、复制、切换、临时关闭和归档赛事。
