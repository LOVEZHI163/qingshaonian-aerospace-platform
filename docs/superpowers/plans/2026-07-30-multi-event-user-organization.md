# Multi-Event User and Organization Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将普通用户、组织负责人和平台管理员升级为显式选择赛事、严格按赛事隔离数据，并支持组织自助加入赛事及个人/组织重复报名自动合并。

**Architecture:** 保留现有 Express、Vue、React 和 PostgreSQL/JSON 双存储结构，在全局账户层与赛事业务层之间新增组织赛事参与关系。报名以 `createdByUserId`、`personalUserId`、`organizationId` 三个字段拆分创建人和访问归属；证书权限统一从报名归属推导。前端以赛事中心和 URL 中的 `eventId` 作为唯一赛事上下文，平台管理端保留原有功能。

**Tech Stack:** Node.js 22、Express 4、PostgreSQL 16、pg/pg-mem、Vue 3、Vite 6、Vitest、React 18、Docker Compose、Nginx。

## Global Constraints

- 账户类型固定为 `ordinary`、`organization`、`admin`。
- 一个组织负责人账号只能负责一个组织，一个组织只能有一个负责人账号。
- 组织负责人拥有该组织全部权限；普通成员没有组织后台权限；不实现其他组织管理角色。
- 组织资质通过且组织启用后，可对已发布、未归档赛事自助加入，立即生效且操作幂等。
- 组织加入赛事后不实现退出、暂停、撤销和逐场委派。
- 所有赛事业务请求显式携带 `eventId`，不得回退到隐含当前赛事。
- 同一学生、同一赛事、同一赛项只允许一条报名；学生键为规范化姓名、学校、年级、手机号。
- 个人和组织重复提交只合并归属，不改变审核状态、成绩、证书、创建人和首次创建渠道。
- 归档赛事禁止新增和修改报名，但保留普通用户证书查询和组织历史证书下载。
- 平台管理员现有官网、赛事、赛项、组别、组织、报名、成绩、证书、用户、审计和资源清理能力全部保留。
- 测试环境发布时清除测试账户、组织、成员、报名、成绩、证书、业务审计和关联测试文件；保留赛事、赛项、组别、官网设置、赛事视觉和公开内容。
- 所有业务改动采用测试先行、最小实现、独立提交；不得把密码、会话密钥或阿里云凭证写入源码、日志或 Git。

---

## File Structure

### API and data

- Create `apps/api/src/data/migrations/007-multi-event-accounts.sql`: PostgreSQL 表结构迁移、唯一约束和冗余证书归属字段删除。
- Modify `apps/api/src/data/schema.sql`: 新安装环境的最终表结构。
- Modify `apps/api/src/data/seed.js`: 与新模型一致的最小测试种子及 JSON 存储形状。
- Modify `apps/api/src/data/postgres-store.js`: 新参与表和新报名字段的双向映射。
- Modify `apps/api/src/data/index.js`: 生产 PostgreSQL 禁止数据库为空时自动写入演示数据。
- Create `apps/api/src/services/access-control.js`: 三类账户、唯一组织负责人、组织参与和赛事只读/可写守卫。
- Create `apps/api/src/services/account-events.js`: 账户赛事中心、组织加入赛事和组织赛事摘要。
- Create `apps/api/src/routes/account-events.js`: `/api/me/events` 与组织赛事工作台路由。
- Modify `apps/api/src/services/organizations.js`: 注册组织时执行唯一负责人规则。
- Modify `apps/api/src/routes/organizations.js`: 普通成员申请/审核和组织详情参与统计。
- Modify `apps/api/src/services/registrations.js`: 精确重复键、创建/合并算法和双归属授权。
- Modify `apps/api/src/routes/registrations.js`: 普通用户与组织负责人显式赛事路由。
- Modify `apps/api/src/routes/certificates.js`: 证书查询、下载权限和组织历史证书接口。
- Modify `apps/api/src/services/certificates.js`: 删除证书冗余归属写入。
- Modify `apps/api/src/services/certificate-imports.js`: 导入证书只保存 `registrationId`。
- Modify `apps/api/src/routes/dashboard.js`: 管理统计接受显式赛事筛选。
- Modify `apps/api/src/server.js`: 注册新路由并移除旧管理角色和混合归属逻辑。
- Create `apps/api/src/services/test-business-cleanup.js`: 测试业务数据预览、事务清理和文件清理日志。
- Create `apps/api/src/cli/cleanup-test-business-data.js`: 带显式确认参数的部署清理命令。
- Create `apps/api/src/cli/bootstrap-admin.js`: 清理后通过标准输入一次性创建平台管理员。

### Vue account/admin application

- Create `apps/admin/src/components/EventContextSwitcher.vue`: 通用赛事选择器和状态标签。
- Create `apps/admin/src/pages/EventCenterPage.vue`: 普通用户与组织负责人的全局赛事中心。
- Create `apps/admin/src/pages/OrganizationEventWorkspacePage.vue`: 单场赛事中的组织报名、名单、成绩和证书工作台。
- Create `apps/admin/src/components/OrganizationAthleteRegistrationForm.vue`: 组织代学生报名表单。
- Modify `apps/admin/src/App.vue`: 按角色进入赛事中心、保存 URL 赛事上下文并保留管理员导航。
- Modify `apps/admin/src/pages/RegistrationPage.vue`: 普通用户显式赛事报名和可关联组织提示。
- Modify `apps/admin/src/pages/RegistrationRecordsPage.vue`: 普通用户按赛事读取自己的当前报名。
- Modify `apps/admin/src/pages/MyCertificatesPage.vue`: 普通用户证书查询和组织历史证书模式。
- Modify `apps/admin/src/pages/OrganizationConsolePage.vue`: 唯一组织负责人、成员申请审核和赛事入口。
- Modify `apps/admin/src/pages/OrganizationManagementPage.vue`: 管理员查看组织加入赛事及统计。
- Modify `apps/admin/src/pages/RegistrationManagementPage.vue`: 管理员强制选择赛事后加载、导出和审核。
- Modify `apps/admin/src/pages/CertificateManagementPage.vue`: 管理员强制选择赛事后管理证书。
- Modify `apps/admin/src/pages/DashboardPage.vue`: 全局概览与赛事筛选统计分离。
- Modify `apps/admin/src/styles.css` and `apps/admin/src/styles/admin.css`: 赛事中心、切换器和组织工作台响应式样式。

### Public website and deployment

- Modify `apps/web/src/components/SiteHeader.jsx`: 保持并测试清晰的“用户登录”入口。
- Modify `apps/web/src/__tests__/Accessibility.test.jsx`: 登录入口的桌面和移动端可访问性回归。
- Modify `deploy/preflight-admin-upgrade.sh`: 检查清理命令、迁移和备份条件。
- Modify `deploy/remote-smoke-test.sh`: 验证三类账户赛事中心和显式赛事接口。
- Modify `docs/deployment/aliyun-test.md`: 记录升级、清理、验证和回滚步骤。

---

### Task 1: Persist the Multi-Event Ownership Model

**Files:**
- Create: `apps/api/src/data/migrations/007-multi-event-accounts.sql`
- Modify: `apps/api/src/data/schema.sql`
- Modify: `apps/api/src/data/seed.js`
- Modify: `apps/api/src/data/postgres-store.js`
- Modify: `apps/api/src/data/index.js`
- Test: `apps/api/test/postgres-store.test.js`
- Test: `apps/api/test/data-store.test.js`

**Interfaces:**
- Produces: `db.organizationEventParticipations: OrganizationEventParticipation[]`.
- Produces: registration fields `createdByUserId`, `personalUserId`, `organizationId`, `createdVia`.
- Produces: PostgreSQL uniqueness on `(owner_user_id)` and `(event_id, project_id, athlete_key)`.
- Consumes: existing `ensureDbShape(db)` and `createPostgresStore(pool)` snapshot conventions.

- [ ] **Step 1: Write failing PostgreSQL schema tests**

Add assertions to `apps/api/test/postgres-store.test.js`:

```js
test("multi-event account schema constrains ownership and registration identity", async () => {
  await withStore(async (store, pool) => {
    const tables = new Set((await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `)).rows.map((row) => row.table_name));
    assert.equal(tables.has("organization_event_participations"), true);

    const columns = new Set((await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'registrations'
    `)).rows.map((row) => row.column_name));
    for (const name of ["created_by_user_id", "personal_user_id", "created_via"]) {
      assert.equal(columns.has(name), true, `missing registrations.${name}`);
    }
    assert.equal(columns.has("user_id"), false);

    const certificateColumns = new Set((await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'certificates'
    `)).rows.map((row) => row.column_name));
    assert.equal(certificateColumns.has("user_id"), false);
    assert.equal(certificateColumns.has("organization_id"), false);

    await assert.rejects(pool.query(
      "INSERT INTO organizations (id,name,code,owner_user_id,status,created_at) VALUES ('O-X','X','X','U2001','active',NOW())"
    ));
  });
});
```

Add a JSON-shape test to `apps/api/test/data-store.test.js`:

```js
assert.deepEqual(db.organizationEventParticipations, []);
assert.equal(db.registrations.every((row) => "createdByUserId" in row), true);
assert.equal(db.registrations.every((row) => !("userId" in row)), true);
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/postgres-store.test.js test/data-store.test.js
```

Expected: FAIL because the participation table and new registration fields do not exist.

- [ ] **Step 3: Add the final schema and migration**

Create `007-multi-event-accounts.sql` with the concrete migration:

```sql
ALTER TABLE organizations
  ADD CONSTRAINT organizations_owner_user_id_key UNIQUE (owner_user_id);

CREATE TABLE organization_event_participations (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  joined_by_user_id TEXT NOT NULL REFERENCES users(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, event_id)
);
CREATE INDEX organization_event_participations_event_id_idx
  ON organization_event_participations(event_id);

ALTER TABLE registrations
  ADD COLUMN created_by_user_id TEXT REFERENCES users(id),
  ADD COLUMN personal_user_id TEXT REFERENCES users(id),
  ADD COLUMN created_via TEXT;

UPDATE registrations r
SET created_by_user_id = r.user_id,
    personal_user_id = CASE WHEN u.type = 'ordinary' THEN r.user_id ELSE NULL END,
    created_via = CASE WHEN u.type = 'organization' THEN 'organization' ELSE 'personal' END
FROM users u
WHERE u.id = r.user_id;

ALTER TABLE registrations
  ALTER COLUMN created_by_user_id SET NOT NULL,
  ALTER COLUMN created_via SET NOT NULL,
  ADD CONSTRAINT registrations_created_via_check
    CHECK (created_via IN ('personal', 'organization')),
  ADD CONSTRAINT registrations_owner_check
    CHECK (personal_user_id IS NOT NULL OR organization_id IS NOT NULL),
  ADD CONSTRAINT registrations_event_project_athlete_key
    UNIQUE (event_id, project_id, athlete_key),
  DROP COLUMN user_id;

DROP INDEX IF EXISTS registrations_user_id_idx;
CREATE INDEX registrations_personal_user_id_idx
  ON registrations(personal_user_id);

ALTER TABLE certificates
  DROP COLUMN user_id,
  DROP COLUMN organization_id;
DROP INDEX IF EXISTS certificates_user_id_idx;
```

Update `schema.sql` to match this final state. Keep `memberships.role` as `TEXT` during this task; Task 2 narrows accepted application values after seed cleanup.

- [ ] **Step 4: Update JSON seed and PostgreSQL mapping**

In `seed.js`, add:

```js
organizationEventParticipations: [],
```

Convert seeded registrations:

```js
{
  createdByUserId: "U1001",
  personalUserId: "U1001",
  organizationId: "O1001",
  createdVia: "personal"
}
```

Add a second organization account `U2002` and assign `O1002.ownerUserId = "U2002"` so the seed itself satisfies the one-owner/one-organization constraint. Update fixed seed-count assertions from three users to four. Remove certificate `userId` and `organizationId`. In `ensureDbShape` initialize the new array and normalize only the new registration fields.

In `postgres-store.js`, include `organization_event_participations` in `readDb()`, map snake_case fields to the exact camelCase names, write them before registrations, and delete missing participation rows before deleting organizations/events.

Change the store factory to accept `seedOnEmpty`:

```js
export function createPostgresStore(pool, { seedOnEmpty = true } = {}) {
  // Existing tests keep deterministic seeds; production passes false.
}
```

In `data/index.js`:

```js
return createPostgresStore(pool, {
  seedOnEmpty: env.NODE_ENV === "test" || env.SEED_DEMO_DATA === "true"
});
```

When `seedOnEmpty` is false, initialization creates schema and migrations but leaves an empty `users` table empty. Add a test for this behavior so post-cleanup production cannot recreate demonstration users, organizations or registrations.

- [ ] **Step 5: Run focused and full data tests**

Run:

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/postgres-store.test.js test/data-store.test.js test/certificate-schema.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit the data model**

```powershell
git add apps/api/src/data apps/api/test/postgres-store.test.js apps/api/test/data-store.test.js apps/api/test/certificate-schema.test.js
git commit -m "feat: persist multi-event account ownership"
```

---

### Task 2: Enforce the Simplified Account and Organization Roles

**Files:**
- Create: `apps/api/src/services/access-control.js`
- Modify: `apps/api/src/services/organizations.js`
- Modify: `apps/api/src/routes/organizations.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/data/seed.js`
- Test: `apps/api/test/authorization.test.js`
- Test: `apps/api/test/organization-credentials.test.js`
- Create: `apps/api/test/multi-event-access-control.test.js`

**Interfaces:**
- Produces: `organizationForOwner(db, userId)`.
- Produces: `requireOrdinaryUser(user)`.
- Produces: `requireOrganizationOwner(db, user)`.
- Produces: `requireOrganizationEventParticipation(db, user, eventId, options)`.
- Produces: `requireWritableEvent(db, eventId, clock)`.
- Consumes: `businessError(status, message, code)` from `services/events.js`.

- [ ] **Step 1: Replace manager-role tests with fixed-role tests**

Remove the test that grants a manager organization authority. Add:

```js
test("only the unique organization owner can review ordinary membership requests", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");

    const request = await fetch(
      `${baseUrl}/api/organizations/request`,
      jsonOptions("POST", { organizationId: "O1001", note: "申请加入" }, ordinary.cookie)
    );
    assert.equal(request.status, 201);
    const membership = (await request.json()).row;
    assert.equal(membership.role, "member");

    const ownerMembers = await fetch(
      `${baseUrl}/api/organizations/O1001/members`,
      withSession(owner.cookie)
    );
    assert.equal(ownerMembers.status, 200);

    const ordinaryMembers = await fetch(
      `${baseUrl}/api/organizations/O1001/members`,
      withSession(ordinary.cookie)
    );
    assert.equal(ordinaryMembers.status, 403);

    const approved = await fetch(
      `${baseUrl}/api/memberships/${membership.id}`,
      jsonOptions("PATCH", { status: "active" }, owner.cookie)
    );
    assert.equal(approved.status, 200);

    const removedInvitationEndpoint = await fetch(
      `${baseUrl}/api/organizations/invite`,
      jsonOptions("POST", {
        organizationId: "O1001",
        phone: "13700000088",
        name: "不再支持的组织邀请"
      }, owner.cookie)
    );
    assert.equal(removedInvitationEndpoint.status, 404);
  });
});
```

Add a service test:

```js
assert.equal(organizationForOwner(db, "U2001").id, "O1001");
assert.throws(
  () => requireOrganizationOwner(db, { id: "U1001", type: "ordinary" }),
  (error) => error.status === 403
);
```

- [ ] **Step 2: Run tests and confirm the legacy manager path fails the new expectation**

Run:

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/authorization.test.js test/organization-credentials.test.js test/multi-event-access-control.test.js
```

Expected: FAIL because manager invitations and manager authorization are still accepted.

- [ ] **Step 3: Implement centralized access-control functions**

Create `access-control.js`:

```js
import { businessError } from "./events.js";

export function organizationForOwner(db, userId) {
  return db.organizations.find((row) => row.ownerUserId === userId) || null;
}

export function requireOrdinaryUser(user) {
  if (user?.type !== "ordinary") {
    throw businessError(403, "仅普通用户可以个人报名", "ORDINARY_USER_REQUIRED");
  }
  return user;
}

export function requireOrganizationOwner(db, user) {
  if (user?.type !== "organization") {
    throw businessError(403, "仅组织负责人可以执行此操作", "ORGANIZATION_OWNER_REQUIRED");
  }
  const organization = organizationForOwner(db, user.id);
  if (!organization) {
    throw businessError(403, "当前账号没有负责的组织", "ORGANIZATION_OWNER_REQUIRED");
  }
  return organization;
}

export function requireWritableEvent(db, eventId) {
  const event = db.events.find((row) => row.id === eventId);
  if (!event || event.status !== "published") {
    throw businessError(404, "赛事不存在或尚未发布", "EVENT_NOT_AVAILABLE");
  }
  if (event.archivedAt || event.status === "archived") {
    throw businessError(409, "赛事已归档，只允许查看历史信息", "EVENT_ARCHIVED");
  }
  return event;
}

export function requireOrganizationEventParticipation(db, user, eventId, { writable = false } = {}) {
  const organization = requireOrganizationOwner(db, user);
  const event = writable
    ? requireWritableEvent(db, eventId)
    : db.events.find((row) => row.id === eventId);
  if (!event) throw businessError(404, "赛事不存在", "EVENT_NOT_AVAILABLE");
  const participation = db.organizationEventParticipations.find(
    (row) => row.organizationId === organization.id && row.eventId === eventId
  );
  if (!participation) {
    throw businessError(403, "组织尚未加入该赛事", "ORGANIZATION_NOT_JOINED");
  }
  return { organization, event, participation };
}
```

- [ ] **Step 4: Remove management roles from organization flows**

Change organization registration so it creates the organization and owner account without an owner membership row. Remove `/api/organizations/invite`; ordinary users create membership requests through `/api/organizations/request`, and the server always writes `role: "member"` regardless of untrusted body fields.

Replace all authorization that checks `owner`/`manager` membership with `organization.ownerUserId === req.user.id`. Keep platform administrator override only in administrator routes.

Add a registration guard:

```js
if (db.organizations.some((row) => row.ownerUserId === user.id)) {
  throw new OrganizationError(409, "一个组织账号只能负责一个组织");
}
```

- [ ] **Step 5: Run authorization and organization tests**

Run:

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/authorization.test.js test/organization-credentials.test.js test/multi-event-access-control.test.js
```

Expected: PASS, including rejection of manager roles and second organizations.

- [ ] **Step 6: Commit simplified roles**

```powershell
git add apps/api/src/services/access-control.js apps/api/src/services/organizations.js apps/api/src/routes/organizations.js apps/api/src/server.js apps/api/src/data/seed.js apps/api/test
git commit -m "feat: enforce single organization ownership"
```

---

### Task 3: Add Account Event Center and Organization Participation APIs

**Files:**
- Create: `apps/api/src/services/account-events.js`
- Create: `apps/api/src/routes/account-events.js`
- Modify: `apps/api/src/server.js`
- Create: `apps/api/test/account-events.test.js`
- Modify: `apps/api/test/authorization.test.js`

**Interfaces:**
- Produces: `listAccountEvents(db, user, clock): { rows: AccountEventRow[] }`.
- Produces: `joinOrganizationEvent(db, user, eventId, now): { row, created }`.
- Produces: `organizationEventSummary(db, organizationId, eventId)`.
- Consumes: access-control functions from Task 2.

- [ ] **Step 1: Write API tests for ordinary and organization accounts**

Create `account-events.test.js` with:

```js
test("ordinary users see every published non-archived event", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const ordinary = await loginAs(baseUrl, "13800000001", "123456");
    const response = await fetch(`${baseUrl}/api/me/events`, withSession(ordinary.cookie));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.rows.every((row) => row.event.status === "published"), true);
    assert.equal(payload.rows.every((row) => !row.event.archivedAt), true);
    assert.equal(payload.rows.every((row) => ["not_started", "open", "closed"].includes(row.registrationState)), true);
  });
});

test("approved organization joins once and receives the same participation on retry", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const first = await fetch(
      `${baseUrl}/api/organization/events/wz-aerospace-2026/join`,
      withSession(owner.cookie, { method: "POST" })
    );
    assert.equal(first.status, 201);
    const second = await fetch(
      `${baseUrl}/api/organization/events/wz-aerospace-2026/join`,
      withSession(owner.cookie, { method: "POST" })
    );
    assert.equal(second.status, 200);
    assert.deepEqual((await second.json()).row, (await first.json()).row);
  });
});
```

Add cases for unapproved organization, disabled organization, draft event, archived event, ordinary user and audit logging.

- [ ] **Step 2: Run the new tests and confirm 404 failures**

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/account-events.test.js test/authorization.test.js
```

Expected: FAIL because `/api/me/events` and the join endpoint do not exist.

- [ ] **Step 3: Implement event-center projections**

In `account-events.js`:

```js
import { isRegistrationOpen } from "../domain/registration-window.js";
import { businessError } from "./events.js";
import { requireOrganizationOwner } from "./access-control.js";

function registrationState(event, clock) {
  const now = clock().getTime();
  if (event.registrationMode === "force_open") return "open";
  if (event.registrationMode === "force_closed") return "closed";
  if (now < Date.parse(event.registrationStartAt)) return "not_started";
  return isRegistrationOpen(event, clock()).open ? "open" : "closed";
}

export function listAccountEvents(db, user, clock = () => new Date()) {
  const rows = db.events
    .filter((event) => event.status === "published" && !event.archivedAt)
    .map((event) => ({
      event,
      registrationState: registrationState(event, clock),
      registrationCount: db.registrations.filter((row) =>
        row.eventId === event.id && (
          row.personalUserId === user.id
          || db.organizations.some((org) =>
            org.ownerUserId === user.id && row.organizationId === org.id
          )
        )
      ).length
    }));
  return { rows };
}
```

For ordinary users, include active memberships with `organizationJoined: boolean`. For organization users, include `participationState: "joined" | "available" | "blocked"` and summary counts.

- [ ] **Step 4: Implement idempotent join and routes**

Implement:

```js
export function joinOrganizationEvent(db, user, eventId, now) {
  const organization = requireOrganizationOwner(db, user);
  if (organization.status !== "active") {
    throw businessError(403, "组织已停用", "ORGANIZATION_DISABLED");
  }
  if (organization.reviewStatus !== "approved") {
    throw businessError(403, "组织资质尚未通过", "ORGANIZATION_NOT_APPROVED");
  }
  const event = db.events.find((row) =>
    row.id === eventId && row.status === "published" && !row.archivedAt
  );
  if (!event) throw businessError(404, "赛事不可加入", "EVENT_NOT_AVAILABLE");
  const existing = db.organizationEventParticipations.find((row) =>
    row.organizationId === organization.id && row.eventId === eventId
  );
  if (existing) return { row: existing, created: false };
  const row = {
    organizationId: organization.id,
    eventId,
    joinedByUserId: user.id,
    joinedAt: now()
  };
  db.organizationEventParticipations.push(row);
  return { row, created: true };
}
```

Register `createAccountEventsRouter` in `server.js`. The join route must write `organization.event.join` to `audit_logs`.

- [ ] **Step 5: Run event-center and authorization tests**

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/account-events.test.js test/authorization.test.js test/audit-dashboard.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit account event APIs**

```powershell
git add apps/api/src/services/account-events.js apps/api/src/routes/account-events.js apps/api/src/server.js apps/api/test
git commit -m "feat: add account event center APIs"
```

---

### Task 4: Implement Transactional Registration Creation and Ownership Merge

**Files:**
- Modify: `apps/api/src/services/registrations.js`
- Modify: `apps/api/src/routes/registrations.js`
- Modify: `apps/api/src/server.js`
- Create: `apps/api/test/multi-event-registration-merge.test.js`
- Modify: `apps/api/test/registration-management.test.js`
- Modify: `apps/api/test/event-scoped-user-data.test.js`
- Modify: `apps/api/test/authorization.test.js`

**Interfaces:**
- Produces: `createOrMergeRegistration(db, input, actor, channel, context): { row, created, merged }`.
- Produces: ordinary endpoint `POST /api/me/events/:eventId/registrations`.
- Produces: organization endpoint `POST /api/organization/events/:eventId/registrations`.
- Consumes: `requireOrganizationEventParticipation` and `requireWritableEvent`.

- [ ] **Step 1: Write the six merge and conflict tests**

Create fixtures for two users, two organizations, one event and one project. Add:

```js
test("personal first and organization second merge into one registration", async () => {
  const personal = createInput({
    eventId: "E1",
    projectId: "P1",
    athlete: athlete("张三", "实验小学", "五年级", "13800000001")
  });
  const first = createOrMergeRegistration(db, personal, ordinary, "personal", context);
  const second = createOrMergeRegistration(db, personal, owner, "organization", context);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.merged, true);
  assert.equal(db.registrations.length, 1);
  assert.equal(second.row.personalUserId, ordinary.id);
  assert.equal(second.row.organizationId, "O1");
  assert.equal(second.row.createdByUserId, ordinary.id);
  assert.equal(second.row.createdVia, "personal");
});
```

Add tests for:

- organization first, personal second;
- same owner retry returning idempotent success;
- another personal user rejected with `REGISTRATION_OWNED_BY_OTHER_USER`;
- another organization rejected with `REGISTRATION_OWNED_BY_OTHER_ORGANIZATION`;
- concurrent duplicate requests resulting in one persisted row.

Set an existing row to `approved` with result and two certificates, then assert merge does not mutate any of those fields.

- [ ] **Step 2: Run the merge suite and confirm failure**

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/multi-event-registration-merge.test.js
```

Expected: FAIL because the current validator rejects by project type and has no dual ownership.

- [ ] **Step 3: Replace project-type duplicate validation with exact project identity**

Change the duplicate query to:

```js
export function findRegistrationIdentity(db, eventId, projectId, athleteKey) {
  return db.registrations.find((row) =>
    row.eventId === eventId
    && row.projectId === projectId
    && row.athleteKey === athleteKey
  ) || null;
}
```

Do not exclude cancelled rows: the database unique key covers all rows. A cancelled row must be returned for an explicit business decision instead of creating a second identity.

- [ ] **Step 4: Implement create-or-merge**

Implement these exact ownership branches:

```js
function mergePersonal(row, userId) {
  if (row.personalUserId && row.personalUserId !== userId) {
    throw businessError(409, "该报名已关联其他个人账号", "REGISTRATION_OWNED_BY_OTHER_USER");
  }
  if (row.personalUserId === userId) return false;
  row.personalUserId = userId;
  return true;
}

function mergeOrganization(row, organizationId) {
  if (row.organizationId && row.organizationId !== organizationId) {
    throw businessError(409, "该报名已关联其他组织", "REGISTRATION_OWNED_BY_OTHER_ORGANIZATION");
  }
  if (row.organizationId === organizationId) return false;
  row.organizationId = organizationId;
  return true;
}
```

For a new row set:

```js
{
  createdByUserId: actor.id,
  personalUserId: channel === "personal" ? actor.id : null,
  organizationId: channel === "organization" ? organization.id : selectedOrganization?.id || null,
  createdVia: channel,
  status: "pending"
}
```

For merge, change only the missing ownership field and `updatedAt`. Write an audit entry with action `registration.ownership.merge`.

For a personal-channel submission, validate both prospective owners before mutating the row: always merge `personalUserId`, and merge `organizationId` only when the user explicitly selected an active member organization. If no organization was selected, retain any organization already attached by an earlier organization-channel submission. For an organization-channel submission, merge only the owner’s organization. Any personal or organization conflict aborts the whole mutation without partially changing the row.

- [ ] **Step 5: Add explicit ordinary and organization routes**

Routes must derive identity from the session:

```js
router.post("/me/events/:eventId/registrations", ...user, asyncRoute(async (req, res) => {
  const result = await createPersonalRegistration(req.params.eventId, req.body, req.user);
  res.status(result.created ? 201 : 200).json(result);
}));

router.post("/organization/events/:eventId/registrations", ...user, asyncRoute(async (req, res) => {
  const result = await createOrganizationRegistration(req.params.eventId, req.body, req.user);
  res.status(result.created ? 201 : 200).json(result);
}));
```

The personal route calls `requireOrdinaryUser(req.user)`, so organization and administrator accounts cannot personally register. Ordinary organization association requires active membership plus participation. Organization channel requires the owner and participation. Both require the URL `eventId` to match the project event and a writable registration window.

Change reads and patches to `/api/me/events/:eventId/registrations` and `/api/organization/events/:eventId/registrations/:registrationId`.

- [ ] **Step 6: Run registration and authorization suites**

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/multi-event-registration-merge.test.js test/registration-management.test.js test/event-scoped-user-data.test.js test/authorization.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit registration ownership**

```powershell
git add apps/api/src/services/registrations.js apps/api/src/routes/registrations.js apps/api/src/server.js apps/api/test
git commit -m "feat: merge multi-event registration ownership"
```

---

### Task 5: Derive Certificate Access from Registration Ownership

**Files:**
- Modify: `apps/api/src/services/certificates.js`
- Modify: `apps/api/src/services/certificate-imports.js`
- Modify: `apps/api/src/routes/certificates.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test/certificates.test.js`
- Modify: `apps/api/test/certificate-management.test.js`
- Modify: `apps/api/test/certificate-imports.test.js`
- Modify: `apps/api/test/authorization.test.js`
- Create: `apps/api/test/organization-certificate-history.test.js`

**Interfaces:**
- Produces: `canReadCertificate(db, user, certificate)`.
- Produces: `GET /api/me/events/:eventId/certificates`.
- Produces: `GET /api/organization/events/:eventId/certificates`.
- Consumes: `registration.personalUserId`, `registration.organizationId`, owner relationship and participation.

- [ ] **Step 1: Write ownership-derived certificate tests**

Add:

```js
test("a merged registration grants the published certificate to both owners", async () => {
  const registration = {
    id: "R1",
    eventId: "E1",
    personalUserId: "U1",
    organizationId: "O1"
  };
  const certificate = {
    id: "C1",
    registrationId: "R1",
    status: "published",
    filePath: "/safe/c1.png"
  };
  const db = fixture({ registrations: [registration], certificates: [certificate] });

  assert.equal(canReadCertificate(db, { id: "U1", type: "ordinary" }, certificate), true);
  assert.equal(canReadCertificate(db, { id: "OWNER1", type: "organization" }, certificate), true);
  assert.equal(canReadCertificate(db, { id: "U2", type: "ordinary" }, certificate), false);
});
```

Add HTTP tests that organization history can read an archived event but cannot read another organization’s certificate. Draft certificates remain admin-only.

- [ ] **Step 2: Run certificate suites and confirm old fields are required**

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/certificates.test.js test/certificate-management.test.js test/certificate-imports.test.js test/organization-certificate-history.test.js
```

Expected: FAIL because certificate creation and authorization still use certificate `userId` and `organizationId`.

- [ ] **Step 3: Remove redundant certificate ownership writes**

In `upsertCertificate`, retain:

```js
Object.assign(certificate, {
  title,
  fileName: storedFile.originalName || storedFile.fileName,
  storedName: storedFile.storedName,
  filePath: storedFile.filePath,
  awardName: registration.awardName || "",
  rank: registration.rank || "",
  score: registration.score || "",
  status: "draft",
  source: source || "manual",
  importBatchId,
  uploadedAt: now,
  publishedAt: "",
  cleanedAt: ""
});
```

Do not copy either registration owner onto the certificate. Apply the same rule in Excel import and result updates.

- [ ] **Step 4: Implement registration-derived authorization**

Use:

```js
export function canReadCertificate(db, user, certificate) {
  if (user.type === "admin") return true;
  if (certificate.status !== "published") return false;
  const registration = db.registrations.find((row) => row.id === certificate.registrationId);
  if (!registration) return false;
  if (user.type === "ordinary") return registration.personalUserId === user.id;
  if (user.type !== "organization") return false;
  const organization = db.organizations.find((row) => row.ownerUserId === user.id);
  const participation = organization && db.organizationEventParticipations.some((row) =>
    row.organizationId === organization.id && row.eventId === registration.eventId
  );
  return Boolean(
    organization
    && participation
    && registration.organizationId === organization.id
  );
}
```

Organization history requires ownership but does not require an unarchived event. It still validates that the URL `eventId` equals the registration event.

- [ ] **Step 5: Run all certificate tests**

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/certificates.test.js test/certificate-management.test.js test/certificate-imports.test.js test/certificate-workbook.test.js test/organization-certificate-history.test.js test/authorization.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit certificate ownership**

```powershell
git add apps/api/src/services/certificates.js apps/api/src/services/certificate-imports.js apps/api/src/routes/certificates.js apps/api/src/server.js apps/api/test
git commit -m "feat: derive certificate access from registrations"
```

---

### Task 6: Require Explicit Event Context in Administrator APIs

**Files:**
- Modify: `apps/api/src/routes/registrations.js`
- Modify: `apps/api/src/routes/certificates.js`
- Modify: `apps/api/src/routes/dashboard.js`
- Modify: `apps/api/src/routes/organizations.js`
- Modify: `apps/api/src/services/registrations.js`
- Create: `apps/api/test/admin-event-context.test.js`
- Modify: `apps/api/test/registration-export.test.js`
- Modify: `apps/api/test/audit-dashboard.test.js`

**Interfaces:**
- Produces: `requireEventId(db, value): Event`.
- Produces: organization detail payload `eventParticipations[]` with registration/result/certificate counts.
- Consumes: existing administrator session middleware.

- [ ] **Step 1: Write tests rejecting missing or mismatched event IDs**

```js
for (const path of [
  "/api/admin/registrations",
  "/api/admin/certificates",
  "/api/admin/registrations/export.xlsx"
]) {
  const response = await fetch(`${baseUrl}${path}`, withSession(admin.cookie));
  assert.equal(response.status, 422, path);
  assert.equal((await response.json()).code, "EVENT_ID_REQUIRED");
}

const wrongEventPatch = await fetch(
  `${baseUrl}/api/admin/events/E2/registrations/R-E1`,
  jsonOptions("PATCH", { instructor: "测试" }, admin.cookie)
);
assert.equal(wrongEventPatch.status, 404);
```

Add an organization-detail assertion:

```js
assert.deepEqual(payload.row.eventParticipations, [{
  eventId: "E1",
  joinedAt: "2026-07-30T00:00:00.000Z",
  registrationCount: 2,
  resultCount: 1,
  certificateCount: 2
}]);
```

- [ ] **Step 2: Run the admin context tests and confirm failure**

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/admin-event-context.test.js test/registration-export.test.js test/audit-dashboard.test.js
```

Expected: FAIL because some lists accept an empty event filter and update URLs do not include an event.

- [ ] **Step 3: Add one strict event parser**

Use:

```js
export function requireEventId(db, value) {
  const eventId = String(value || "").trim();
  if (!eventId) {
    throw businessError(422, "请选择赛事", "EVENT_ID_REQUIRED");
  }
  const event = db.events.find((row) => row.id === eventId);
  if (!event) throw businessError(404, "赛事不存在", "EVENT_NOT_AVAILABLE");
  return event;
}
```

Apply it to all administrator registration, result, certificate list/export/import/update routes. Update mutation paths to `/api/admin/events/:eventId/registrations/:id/...` and compare both identifiers before mutation.

- [ ] **Step 4: Add organization participation statistics**

In the administrator organization response, calculate each participation:

```js
function participationSummary(db, participation) {
  const registrations = db.registrations.filter((row) =>
    row.eventId === participation.eventId
    && row.organizationId === participation.organizationId
  );
  return {
    ...participation,
    registrationCount: registrations.length,
    resultCount: registrations.filter((row) =>
      row.awardName || row.rank || row.score || row.resultRecordedAt
    ).length,
    certificateCount: db.certificates.filter((certificate) =>
      registrations.some((row) => row.id === certificate.registrationId)
    ).length
  };
}
```

- [ ] **Step 5: Run all administrator API tests**

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/admin-event-context.test.js test/registration-management.test.js test/registration-export.test.js test/certificate-management.test.js test/audit-dashboard.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit administrator event isolation**

```powershell
git add apps/api/src/routes apps/api/src/services/registrations.js apps/api/test
git commit -m "feat: require admin event context"
```

---

### Task 7: Build the Shared Event Center and URL Context

**Files:**
- Create: `apps/admin/src/components/EventContextSwitcher.vue`
- Create: `apps/admin/src/pages/EventCenterPage.vue`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/state/session.js`
- Modify: `apps/admin/src/styles.css`
- Create: `apps/admin/src/components/__tests__/EventContextSwitcher.test.js`
- Create: `apps/admin/src/pages/__tests__/EventCenterPage.test.js`
- Modify: `apps/admin/src/__tests__/App.test.js`

**Interfaces:**
- Produces: `EventContextSwitcher` props `events`, `modelValue`, `includeArchived`; emits `update:modelValue`.
- Produces: `EventCenterPage` prop `accountType`; emits `open-event` with `{ eventId, mode }`.
- Consumes: `GET /api/me/events`.

- [ ] **Step 1: Write event-center component tests**

```js
it("renders one to three concurrent events and emits the selected event", async () => {
  apiMock.mockResolvedValue({
    rows: [
      { event: { id: "E1", name: "赛事一" }, registrationState: "open", registrationCount: 1 },
      { event: { id: "E2", name: "赛事二" }, registrationState: "not_started", registrationCount: 0 },
      { event: { id: "E3", name: "赛事三" }, registrationState: "closed", registrationCount: 2 }
    ]
  });
  const wrapper = mount(EventCenterPage, { props: { accountType: "ordinary" } });
  await flushPromises();
  expect(wrapper.findAll("[data-event-card]")).toHaveLength(3);
  await wrapper.get('[data-event-card="E2"] [data-action="open"]').trigger("click");
  expect(wrapper.emitted("open-event")[0][0]).toEqual({ eventId: "E2", mode: "registration" });
});
```

In `App.test.js`, assert ordinary and organization users default to `eventCenter`, while administrators still default to `overview`.

- [ ] **Step 2: Run component tests and confirm missing components**

```powershell
npm.cmd test -w apps/admin -- src/components/__tests__/EventContextSwitcher.test.js src/pages/__tests__/EventCenterPage.test.js src/__tests__/App.test.js
```

Expected: FAIL because the new pages do not exist and current default view opens registration/organization directly.

- [ ] **Step 3: Implement the reusable switcher**

`EventContextSwitcher.vue` must use a native labeled `<select>` and emit only a valid event ID:

```vue
<script setup>
const props = defineProps({
  events: { type: Array, default: () => [] },
  modelValue: { type: String, default: "" },
  includeArchived: { type: Boolean, default: false }
});
const emit = defineEmits(["update:modelValue"]);
</script>

<template>
  <label class="event-context-switcher">
    当前赛事
    <select
      :value="modelValue"
      data-event-switcher
      @change="emit('update:modelValue', $event.target.value)"
    >
      <option value="" disabled>请选择赛事</option>
      <option
        v-for="row in events.filter((item) => includeArchived || !item.event.archivedAt)"
        :key="row.event.id"
        :value="row.event.id"
      >{{ row.event.name }}</option>
    </select>
  </label>
</template>
```

- [ ] **Step 4: Implement the event center and App routing**

Render status labels `未开始`、`报名中`、`已截止`; organization cards additionally render `可加入`、`已加入`、`资质不可用`.

In `App.vue`:

```js
function defaultView(user = currentUser.value) {
  if (!user) return "login";
  return user.type === "admin" ? "overview" : "eventCenter";
}

function openAccountEvent({ eventId, mode }) {
  selectedEventId.value = eventId;
  currentView.value = mode;
}
```

Synchronize non-admin URL state:

```js
url.searchParams.set("view", view);
if (selectedEventId.value) url.searchParams.set("eventId", selectedEventId.value);
else url.searchParams.delete("eventId");
```

Refreshing `/admin/?view=registration&eventId=E2` must restore E2 only after the logged-in account is authorized for that view.

- [ ] **Step 5: Add responsive styles and run tests**

```powershell
npm.cmd test -w apps/admin -- src/components/__tests__/EventContextSwitcher.test.js src/pages/__tests__/EventCenterPage.test.js src/__tests__/App.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit shared event navigation**

```powershell
git add apps/admin/src/components/EventContextSwitcher.vue apps/admin/src/pages/EventCenterPage.vue apps/admin/src/App.vue apps/admin/src/state/session.js apps/admin/src/styles.css apps/admin/src/components/__tests__ apps/admin/src/pages/__tests__ apps/admin/src/__tests__/App.test.js
git commit -m "feat: add account event center"
```

---

### Task 8: Upgrade the Ordinary User Event Workflow

**Files:**
- Modify: `apps/admin/src/pages/RegistrationPage.vue`
- Modify: `apps/admin/src/pages/RegistrationRecordsPage.vue`
- Modify: `apps/admin/src/pages/MyCertificatesPage.vue`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/styles/forms.css`
- Modify: `apps/admin/src/pages/__tests__/RegistrationPage.event-context.test.js`
- Create: `apps/admin/src/pages/__tests__/OrdinaryEventWorkflow.test.js`

**Interfaces:**
- Consumes: `/api/me/events/:eventId/registrations` and `/api/me/events/:eventId/certificates`.
- Produces: ordinary UI that never submits without its selected event ID.
- Consumes: event-center membership rows with `organizationJoined`.

- [ ] **Step 1: Write ordinary workflow tests**

```js
it("submits through the selected ordinary-user event endpoint", async () => {
  const wrapper = mount(RegistrationPage, { props: { eventId: "E2" } });
  await flushPromises();
  await fillAthlete(wrapper);
  await wrapper.get("form.form-panel").trigger("submit");
  await flushPromises();
  expect(apiMock).toHaveBeenCalledWith(
    "/api/me/events/E2/registrations",
    expect.objectContaining({ method: "POST" })
  );
});

it("explains why an active member cannot associate an unjoined organization", async () => {
  apiMock.mockResolvedValueOnce(contextWithOrganization({
    id: "O1",
    name: "实验小学",
    organizationJoined: false
  }));
  const wrapper = mount(RegistrationPage, { props: { eventId: "E2" } });
  await flushPromises();
  expect(wrapper.text()).toContain("该组织尚未加入本赛事");
  expect(wrapper.get('option[value="O1"]').attributes("disabled")).toBeDefined();
});
```

Add tests that records and certificates request E2 and never fall back to E1.

- [ ] **Step 2: Run tests and confirm old route calls fail**

```powershell
npm.cmd test -w apps/admin -- src/pages/__tests__/RegistrationPage.event-context.test.js src/pages/__tests__/OrdinaryEventWorkflow.test.js
```

Expected: FAIL because the page posts to `/api/registrations` and does not represent participation availability.

- [ ] **Step 3: Switch ordinary pages to explicit endpoints**

Use:

```js
await api(`/api/me/events/${encodeURIComponent(props.eventId)}/registrations`, {
  method: "POST",
  body: JSON.stringify({
    organizationId: form.organizationId || null,
    athlete: form.athlete,
    projectId: form.projectId,
    instructor: form.instructor
  })
});
```

Reject rendering the form when `eventId` is empty. Disable organizations where `organizationJoined !== true`, but retain the option text so the user understands the relationship.

Load records and certificates only from their event-scoped endpoints. Keep certificate lookup available independently for published historical certificates; do not add a historical registration list.

- [ ] **Step 4: Update App navigation**

Ordinary navigation becomes:

```js
[
  ["eventCenter", "赛事中心"],
  ["registration", "报名"],
  ["registrationRecords", "当前报名"],
  ["certificates", "证书查询"]
]
```

Hide registration/records actions until an event is selected. “返回赛事中心” clears `eventId`.

- [ ] **Step 5: Run ordinary workflow and App tests**

```powershell
npm.cmd test -w apps/admin -- src/pages/__tests__/RegistrationPage.event-context.test.js src/pages/__tests__/OrdinaryEventWorkflow.test.js src/__tests__/App.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit the ordinary workflow**

```powershell
git add apps/admin/src/pages/RegistrationPage.vue apps/admin/src/pages/RegistrationRecordsPage.vue apps/admin/src/pages/MyCertificatesPage.vue apps/admin/src/App.vue apps/admin/src/styles/forms.css apps/admin/src/pages/__tests__ apps/admin/src/__tests__/App.test.js
git commit -m "feat: scope ordinary users to selected events"
```

---

### Task 9: Build the Organization Event Workspace

**Files:**
- Create: `apps/admin/src/components/OrganizationAthleteRegistrationForm.vue`
- Create: `apps/admin/src/pages/OrganizationEventWorkspacePage.vue`
- Modify: `apps/admin/src/pages/OrganizationConsolePage.vue`
- Modify: `apps/admin/src/pages/RegistrationRecordsPage.vue`
- Modify: `apps/admin/src/pages/MyCertificatesPage.vue`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/styles.css`
- Create: `apps/admin/src/pages/__tests__/OrganizationEventWorkspacePage.test.js`
- Modify: `apps/admin/src/pages/__tests__/OrganizationManagementPage.test.js`
- Modify: `apps/admin/src/__tests__/App.test.js`

**Interfaces:**
- Consumes: organization join and workspace APIs from Tasks 3–5.
- Produces: event workspace tabs `registration`, `records`, `results`, `certificates`.
- Produces: event-center `join-event` action.

- [ ] **Step 1: Write organization join and workspace tests**

```js
it("joins an available event and opens its workspace", async () => {
  apiMock.mockImplementation(async (path, options) => {
    if (path === "/api/organization/events/E2/join" && options.method === "POST") {
      return { row: { organizationId: "O1", eventId: "E2" }, created: true };
    }
    if (path === "/api/organization/events/E2/workspace") {
      return { event: { id: "E2", name: "赛事二" }, summary: {}, registrations: [] };
    }
    return { rows: [] };
  });
  const wrapper = mount(OrganizationEventWorkspacePage, { props: { eventId: "E2" } });
  await flushPromises();
  expect(apiMock).toHaveBeenCalledWith("/api/organization/events/E2/workspace");
  expect(wrapper.text()).toContain("赛事二");
});
```

Add tests for:

- organization registration endpoint;
- own list export;
- results read-only display;
- archived event only showing results/certificates;
- one organization only, with no manager role or organization selector.

- [ ] **Step 2: Run organization UI tests and confirm missing page**

```powershell
npm.cmd test -w apps/admin -- src/pages/__tests__/OrganizationEventWorkspacePage.test.js src/pages/__tests__/OrganizationManagementPage.test.js src/__tests__/App.test.js
```

Expected: FAIL because the organization event workspace does not exist.

- [ ] **Step 3: Implement organization registration form**

Submit only the athlete data and project:

```js
await api(`/api/organization/events/${encodeURIComponent(props.eventId)}/registrations`, {
  method: "POST",
  body: JSON.stringify({
    athlete: form.athlete,
    projectId: form.projectId,
    instructor: form.instructor
  })
});
```

Do not expose a personal/organization toggle or organization selector. Display server merge success distinctly:

```js
message.value = payload.merged
  ? "已与现有个人报名合并，未重复创建"
  : "组织报名已提交";
```

- [ ] **Step 4: Implement workspace tabs**

`OrganizationEventWorkspacePage` loads the workspace summary first and then uses:

```text
GET /api/organization/events/:eventId/registrations
GET /api/organization/events/:eventId/export
GET /api/organization/events/:eventId/certificates
```

The results tab reads result fields from the registration list. The export action uses `apiBlob` and the existing `downloadBlob` helper. For archived events, omit the registration form and edit buttons.

- [ ] **Step 5: Simplify organization console and App navigation**

`OrganizationConsolePage` manages:

- current organization and qualification state;
- ordinary member requests;
- credential resubmission.

Remove organization selectors and manager-role columns. App navigation becomes:

```js
[
  ["eventCenter", "赛事中心"],
  ["organizationWorkspace", "赛事工作台"],
  ["organization", "组织与成员"],
  ["certificates", "历史证书"]
]
```

- [ ] **Step 6: Run organization and App tests**

```powershell
npm.cmd test -w apps/admin -- src/pages/__tests__/OrganizationEventWorkspacePage.test.js src/pages/__tests__/OrganizationManagementPage.test.js src/pages/__tests__/AuthPage.test.js src/__tests__/App.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit the organization workspace**

```powershell
git add apps/admin/src/components/OrganizationAthleteRegistrationForm.vue apps/admin/src/pages/OrganizationEventWorkspacePage.vue apps/admin/src/pages/OrganizationConsolePage.vue apps/admin/src/pages/RegistrationRecordsPage.vue apps/admin/src/pages/MyCertificatesPage.vue apps/admin/src/App.vue apps/admin/src/styles.css apps/admin/src/pages/__tests__ apps/admin/src/__tests__/App.test.js
git commit -m "feat: add organization event workspace"
```

---

### Task 10: Add a Unified Administrator Event Context

**Files:**
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/pages/DashboardPage.vue`
- Modify: `apps/admin/src/pages/OrganizationManagementPage.vue`
- Modify: `apps/admin/src/pages/RegistrationManagementPage.vue`
- Modify: `apps/admin/src/pages/CertificateManagementPage.vue`
- Modify: `apps/admin/src/components/AdminShell.vue`
- Modify: `apps/admin/src/styles/admin.css`
- Create: `apps/admin/src/pages/__tests__/AdminEventContext.test.js`
- Modify: `apps/admin/src/pages/__tests__/RegistrationManagementPage.test.js`
- Modify: `apps/admin/src/pages/__tests__/CertificateManagementPage.test.js`
- Modify: `apps/admin/src/pages/__tests__/OrganizationManagementPage.test.js`

**Interfaces:**
- Consumes: `EventContextSwitcher` from Task 7.
- Produces: one selected administrator `eventId` persisted in the URL.
- Consumes: strict administrator endpoints from Task 6.

- [ ] **Step 1: Write administrator context tests**

```js
it("uses one event selection for registrations, export and certificates", async () => {
  const wrapper = mount(App);
  await flushPromises();
  await wrapper.get('[data-nav="registrations"]').trigger("click");
  await wrapper.get("[data-event-switcher]").setValue("E2");
  await flushPromises();

  expect(apiMock.mock.calls.some(([path]) =>
    path.startsWith("/api/admin/registrations?") && path.includes("eventId=E2")
  )).toBe(true);

  await wrapper.get('[data-action="manage-certificates"]').trigger("click");
  await flushPromises();
  expect(wrapper.get("[data-event-switcher]").element.value).toBe("E2");
  expect(window.location.search).toContain("eventId=E2");
});
```

Add a test that no registration or certificate request is sent before selection, and organization detail renders joined-event statistics.

- [ ] **Step 2: Run administrator UI tests and confirm mixed selectors**

```powershell
npm.cmd test -w apps/admin -- src/pages/__tests__/AdminEventContext.test.js src/pages/__tests__/RegistrationManagementPage.test.js src/pages/__tests__/CertificateManagementPage.test.js src/pages/__tests__/OrganizationManagementPage.test.js
```

Expected: FAIL because each page currently owns separate event state.

- [ ] **Step 3: Lift administrator event state into App**

Create one ref:

```js
const adminEventId = ref(initialEventId);
```

Pass it to event-scoped pages:

```vue
<RegistrationManagementPage
  :event-id="adminEventId"
  @update:event-id="adminEventId = $event"
  @open-certificates="openCertificateManagement"
/>
<CertificateManagementPage
  :event-id="adminEventId"
  :initial-registration-id="certificateRegistrationId"
/>
```

`openCertificateManagement` must retain `registration.eventId` and reject an event mismatch.

- [ ] **Step 4: Remove implicit administrator requests**

Registration and certificate pages show a selection prompt until `eventId` is non-empty. Every list, export, template, import, update, result, publish and delete URL includes that event.

Dashboard keeps its global account/organization summary, but any registration/result/certificate metric receives the selected event explicitly. Organization management remains global and displays each organization’s joined-event statistics.

- [ ] **Step 5: Run the complete administrator suite**

```powershell
npm.cmd test -w apps/admin -- src/pages/__tests__/AdminEventContext.test.js src/pages/__tests__/RegistrationManagementPage.test.js src/pages/__tests__/CertificateManagementPage.test.js src/pages/__tests__/OrganizationManagementPage.test.js src/pages/__tests__/DashboardPage.test.js src/__tests__/App.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit administrator event context**

```powershell
git add apps/admin/src/App.vue apps/admin/src/pages apps/admin/src/components/AdminShell.vue apps/admin/src/styles/admin.css
git commit -m "feat: unify administrator event context"
```

---

### Task 11: Preserve the Public Login Entry and Validate Responsive UX

**Files:**
- Modify: `apps/web/src/components/SiteHeader.jsx`
- Modify: `apps/web/src/__tests__/Accessibility.test.jsx`
- Modify: `apps/web/src/__tests__/HomePage.test.jsx`
- Modify: `apps/web/src/styles/home.css`
- Modify: `apps/admin/src/styles.css`

**Interfaces:**
- Produces: public header link `/admin/` labeled `用户登录`.
- Consumes: existing mobile menu focus and Escape behavior.

- [ ] **Step 1: Add a precise login-entry regression test**

```jsx
it("exposes the account login outside the client router", () => {
  render(<SiteHeader routeKey="/" />);
  const link = screen.getByRole("link", { name: "用户登录" });
  expect(link).toHaveAttribute("href", "/admin/");
  expect(link).toHaveAttribute("data-router-ignore", "true");
});
```

At a mobile viewport, open the menu and assert the login link becomes reachable before the registration CTA.

- [ ] **Step 2: Run public site tests**

```powershell
npm.cmd test -w apps/web -- --run src/__tests__/Accessibility.test.jsx src/__tests__/HomePage.test.jsx
```

Expected: PASS if the existing entry is intact; this is a preservation gate. If the mobile order or accessible label differs, the focused assertion fails.

- [ ] **Step 3: Make only the required presentation adjustment**

Keep:

```jsx
<a className="login-link" href="/admin/" data-router-ignore="true">用户登录</a>
```

Adjust CSS only if the mobile test shows the link is hidden, clipped, or ordered after the registration CTA. Do not change the website brand, navigation, current/concurrent event presentation or public content architecture.

- [ ] **Step 4: Run web and admin responsive tests**

```powershell
npm.cmd test -w apps/web -- --run
npm.cmd test -w apps/admin
```

Expected: all suites PASS.

- [ ] **Step 5: Commit the login-entry gate**

```powershell
git add apps/web/src/components/SiteHeader.jsx apps/web/src/__tests__ apps/web/src/styles/home.css apps/admin/src/styles.css
git commit -m "test: preserve public user login entry"
```

---

### Task 12: Add Safe Test-Business-Data Cleanup

**Files:**
- Create: `apps/api/src/services/test-business-cleanup.js`
- Create: `apps/api/src/cli/cleanup-test-business-data.js`
- Create: `apps/api/src/cli/bootstrap-admin.js`
- Create: `apps/api/test/test-business-cleanup.test.js`
- Create: `apps/api/test/bootstrap-admin.test.js`
- Modify: `deploy/preflight-admin-upgrade.sh`
- Modify: `docs/deployment/aliyun-test.md`

**Interfaces:**
- Produces: `previewTestBusinessCleanup(client): CleanupPreview`.
- Produces: `executeTestBusinessCleanup(client, uploadRoot): CleanupResult`.
- CLI confirmation token: `DELETE-TEST-BUSINESS-DATA`.
- Produces: `bootstrapAdmin(client, { name, phone, password }): PublicUser`.
- Consumes: `DATABASE_URL` and `UPLOAD_ROOT`.

- [ ] **Step 1: Write cleanup preservation tests**

Using pg-mem with events, projects, site settings, users, organizations, registrations and certificates:

```js
test("cleanup removes test business data and preserves public event configuration", async () => {
  const preview = await previewTestBusinessCleanup(client);
  assert.deepEqual(preview.preserved, {
    events: 2,
    projects: 4,
    siteSettings: 1,
    eventPublicProfiles: 2,
    contentPosts: 3
  });
  assert.equal(preview.deleted.users, 3);
  assert.equal(preview.deleted.registrations, 2);

  const result = await executeTestBusinessCleanup(client, uploadRoot);
  assert.equal(result.deleted.users, 3);
  assert.equal((await client.query("SELECT COUNT(*)::int count FROM events")).rows[0].count, 2);
  assert.equal((await client.query("SELECT COUNT(*)::int count FROM users")).rows[0].count, 0);
  assert.equal(await exists(siteMediaPath), true);
  assert.equal(await exists(certificatePath), false);
});
```

Add a test that a failed file deletion creates a `file_cleanup_journal` record and does not roll back the completed database transaction. Add a second fixture without `organization_event_participations` and assert preview/execution safely skip that table, matching the pre-migration production database.

- [ ] **Step 2: Run cleanup tests and confirm missing module**

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/test-business-cleanup.test.js
```

Expected: FAIL because the cleanup service and CLI do not exist.

- [ ] **Step 3: Implement preview and transactional deletion**

The preview returns counts for:

```js
const deletedTables = [
  "certificate_import_errors",
  "certificate_import_batches",
  "certificates",
  "results",
  "registrations",
  "organization_event_participations",
  "memberships",
  "organization_documents",
  "organizations",
  "audit_logs",
  "password_reset_challenges",
  "auth_rate_buckets",
  "file_cleanup_journal",
  "session",
  "users"
];
```

Before deletion, select certificate and organization document paths. Detect each table with `SELECT to_regclass($1)` and skip absent tables, because cleanup runs against the old schema before migration `007` creates `organization_event_participations`. Delete present tables in foreign-key-safe order inside one transaction. After commit, remove only paths whose resolved absolute path stays under `UPLOAD_ROOT`; exclude `site-media`. Failed removal writes a new `file_cleanup_journal` row after the old journal rows have been cleared.

- [ ] **Step 4: Implement explicit CLI confirmation**

The CLI behavior is:

```js
const confirmed = process.argv.includes("--confirm=DELETE-TEST-BUSINESS-DATA");
const preview = await previewTestBusinessCleanup(client);
process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
if (!confirmed) {
  process.stdout.write("Preview only. No data was deleted.\n");
  process.exitCode = 0;
} else {
  const result = await executeTestBusinessCleanup(client, process.env.UPLOAD_ROOT);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
```

Do not print environment variables or connection strings.

- [ ] **Step 5: Strengthen deployment preflight and documentation**

`preflight-admin-upgrade.sh` must assert:

```sh
test -f apps/api/src/cli/cleanup-test-business-data.js \
  || fail "test-business-data cleanup command is missing"
test -f apps/api/src/cli/bootstrap-admin.js \
  || fail "administrator bootstrap command is missing"
grep -q '007-multi-event-accounts.sql' \
  < <(find apps/api/src/data/migrations -maxdepth 1 -type f -printf '%f\n') \
  || fail "multi-event migration is missing"
```

Because `/bin/sh` does not guarantee process substitution, implement the second check portably as:

```sh
test -f apps/api/src/data/migrations/007-multi-event-accounts.sql \
  || fail "multi-event migration is missing"
```

Document exact preview and execution commands:

```sh
docker compose build api
docker compose run --rm --no-deps api \
  node apps/api/src/cli/cleanup-test-business-data.js
docker compose run --rm --no-deps api \
  node apps/api/src/cli/cleanup-test-business-data.js \
  --confirm=DELETE-TEST-BUSINESS-DATA
```

- [ ] **Step 6: Implement and test one-time administrator bootstrap**

`bootstrap-admin.js` accepts `--name=赛事管理员`, `--phone=13900000000`, and `--password-stdin`. It reads one password line from standard input, validates it with the existing password policy, hashes it with `hashPassword`, and inserts:

```js
{
  id: `U${crypto.randomUUID()}`,
  name,
  phone,
  type: "admin",
  status: "active",
  sessionVersion: 0,
  mustChangePassword: false,
  createdAt: new Date().toISOString()
}
```

It refuses to run if any administrator already exists, never echoes the password, and clears the in-memory password reference after hashing. Add tests for successful creation, weak-password rejection, duplicate-admin rejection and output free of the submitted password.

- [ ] **Step 7: Run cleanup and deployment-config tests**

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/test-business-cleanup.test.js test/bootstrap-admin.test.js test/deployment-paths.test.js
powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1
docker compose config --quiet
```

Expected: PASS.

- [ ] **Step 8: Commit the cleanup workflow**

```powershell
git add apps/api/src/services/test-business-cleanup.js apps/api/src/cli/cleanup-test-business-data.js apps/api/src/cli/bootstrap-admin.js apps/api/test/test-business-cleanup.test.js apps/api/test/bootstrap-admin.test.js deploy/preflight-admin-upgrade.sh docs/deployment/aliyun-test.md
git commit -m "feat: add safe test data cleanup"
```

---

### Task 13: Run Full Regression, Review, Deploy, and Verify

**Files:**
- Modify: `deploy/remote-smoke-test.sh`
- Modify: `docs/deployment/aliyun-test.md`
- Test: all API, admin and web tests

**Interfaces:**
- Consumes: all implementation tasks.
- Produces: verified release on `47.99.181.222` with a recorded commit SHA, backup files and smoke results.

- [ ] **Step 1: Extend remote smoke coverage**

After administrator login, dynamically select one published, non-archived event from `/api/admin/events`. Verify:

```sh
assert_status "account-events" 200 \
  -b "$cookie_jar" \
  "$base_url/api/me/events"

assert_status "admin-registrations-event" 200 \
  -b "$cookie_jar" \
  "$base_url/api/admin/registrations?eventId=$(encode "$event_id")"

assert_status "admin-registrations-missing-event" 422 \
  -b "$cookie_jar" \
  "$base_url/api/admin/registrations"
```

Keep the existing health, public site, login, settings and anonymous 401 checks. Do not print response bodies containing account data.

- [ ] **Step 2: Run all local quality gates**

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1
npm.cmd test -w apps/admin
npm.cmd test -w apps/web -- --run
npm.cmd run build
powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1
docker compose config --quiet
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Perform a focused code review**

Review the final diff against the approved design, specifically checking:

```powershell
rg -n "manager|membershipRole.*owner|registration\\.userId|certificate\\.userId|certificate\\.organizationId" apps
rg -n "/api/(registrations|admin/registrations|admin/certificates)" apps/admin/src
rg -n "eventId" apps/api/src/routes apps/admin/src/pages
```

Expected:

- no manager authorization path;
- no registration or certificate legacy ownership field;
- no event-scoped mutation without explicit event ID;
- remaining legacy route strings appear only in intentional rejection or migration tests.

Fix each finding with a failing regression test before changing code.

- [ ] **Step 4: Commit smoke and documentation changes**

```powershell
git add deploy/remote-smoke-test.sh docs/deployment/aliyun-test.md
git commit -m "chore: verify multi-event account deployment"
git status --short
```

Expected: clean working tree.

- [ ] **Step 5: Back up the server before uploading**

```powershell
ssh aerogp "cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-postgres.sh once"
ssh aerogp "cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-uploads.sh once"
ssh aerogp "cd /opt/aerogp && /bin/sh deploy/preflight-admin-upgrade.sh"
ssh aerogp 'cd /opt/aerogp && stamp=$(date -u +%Y%m%dT%H%M%SZ) && tar --exclude=./.env --exclude=./backups -czf "backups/source-before-multi-event-$stamp.tgz" . && api_image=$(docker inspect --format "{{.Image}}" "$(docker compose ps -q api)") && web_image=$(docker inspect --format "{{.Image}}" "$(docker compose ps -q web)") && docker image tag "$api_image" "aerogp-api:rollback-$stamp" && docker image tag "$web_image" "aerogp-web:rollback-$stamp" && printf "%s\n" "$stamp" > backups/multi-event-rollback-stamp'
```

Expected: database, uploads and source backups are created; rollback image tags are recorded; preflight prints `Upgrade preflight passed.`

- [ ] **Step 6: Build the release archive and upload it without secrets**

From the isolated worktree:

```powershell
$worktree = "C:\Users\xiang\Documents\青少年航空网站\.worktrees\multi-event-accounts"
$release = git -C $worktree rev-parse HEAD
$archive = Join-Path $env:TEMP "aerogp-multi-event-$release.tar"
git -C $worktree archive --format=tar --output=$archive HEAD
scp $archive "aerogp:/tmp/aerogp-multi-event.tar"
ssh aerogp "rm -rf /tmp/aerogp-multi-event && install -d -m 700 /tmp/aerogp-multi-event && tar -xf /tmp/aerogp-multi-event.tar -C /tmp/aerogp-multi-event"
```

Do not archive `.env`, backups, uploaded files, node_modules or the root dirty worktree.

- [ ] **Step 7: Stage the candidate source while the old containers keep running**

Replace only the tracked source tree after the backups have passed. Existing containers continue serving their already-built old images until they are explicitly stopped:

```powershell
ssh aerogp "cd /opt/aerogp && find . -mindepth 1 -maxdepth 1 ! -name .env ! -name backups -exec rm -rf -- {} + && cp -a /tmp/aerogp-multi-event/. . && printf '%s\n' '$release' > .release && /bin/sh deploy/preflight-admin-upgrade.sh"
```

Expected: `.env`, `backups`, PostgreSQL volume and uploads volume remain intact; the candidate preflight prints `Upgrade preflight passed.`

- [ ] **Step 8: Preview and execute the approved test-data cleanup**

Build the candidate API image, then stop API/Web writes before the destructive operation:

```powershell
ssh aerogp "cd /opt/aerogp && docker compose build api"
ssh aerogp "cd /opt/aerogp && docker compose stop web api"
ssh aerogp "cd /opt/aerogp && docker compose run --rm --no-deps api node apps/api/src/cli/cleanup-test-business-data.js"
```

Read the printed counts and verify that preserved tables contain events, projects and website content. Then execute:

```powershell
ssh aerogp "cd /opt/aerogp && docker compose run --rm --no-deps api node apps/api/src/cli/cleanup-test-business-data.js --confirm=DELETE-TEST-BUSINESS-DATA"
```

Expected: users, organizations, registrations, results, certificates and their test files become zero/removed; events, projects and site content remain unchanged.

- [ ] **Step 9: Create the replacement platform administrator**

Read a new strong password locally and send it only through SSH/container standard input:

```powershell
$securePassword = Read-Host "新平台管理员密码" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  $plainPassword | ssh aerogp 'cd /opt/aerogp && docker compose run --rm --no-deps -T api node apps/api/src/cli/bootstrap-admin.js --name=赛事管理员 --phone=13900000000 --password-stdin'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  $plainPassword = $null
  $securePassword.Dispose()
}
```

Expected: exactly one active platform administrator is created; no ordinary user, organization, membership or registration is recreated. Keep this password only for the deployment smoke and then store it in the user’s approved password manager.

- [ ] **Step 10: Rebuild and start all candidate services**

Preserve `.env`, `backups` and Docker volumes:

```powershell
ssh aerogp "cd /opt/aerogp && docker compose build --pull && docker compose up -d --wait --wait-timeout 240"
ssh aerogp "cd /opt/aerogp && docker compose ps"
```

Expected: `postgres`, `api`, `web`, and `backup` are healthy. Never run `docker compose down -v`.

- [ ] **Step 11: Run remote smoke and browser acceptance**

Inject the administrator test password through standard input without putting it in the command line, output or Git:

```powershell
$securePassword = Read-Host "管理员测试密码" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  $plainPassword | ssh aerogp 'cd /opt/aerogp && IFS= read -r ADMIN_TEST_PASSWORD && export ADMIN_TEST_PASSWORD && BASE_URL=http://127.0.0.1 /bin/sh deploy/remote-smoke-test.sh'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  $plainPassword = $null
  $securePassword.Dispose()
}
```

Then verify in a browser at desktop and 360px widths:

1. 官网“用户登录”进入 `/admin/`。
2. 普通用户登录后首先看到赛事中心。
3. 组织负责人看到可加入/已加入赛事，不出现组织管理员角色。
4. 组织点击加入后立即进入赛事工作台。
5. 管理员原有导航完整，报名和证书页要求赛事上下文。
6. 切换赛事后列表、导出、成绩和证书不串数据。
7. 归档赛事不可写，历史证书仍可下载。
8. 浏览器控制台无应用错误，页面无横向溢出。

- [ ] **Step 12: Record actual release evidence**

Append the actual values to `docs/deployment/aliyun-test.md`:

- `git rev-parse HEAD`;
- database and uploads backup filenames and validation result;
- cleanup preview/execution counts;
- `docker compose ps` health summary;
- smoke status summary;
- desktop and 360px browser acceptance result;
- rollback image/source reference.

Commit this evidence:

```powershell
git add docs/deployment/aliyun-test.md
git commit -m "docs: record multi-event account release"
```

If deployment verification fails, stop the new API/Web, restore the verified database and upload backups using the documented restore commands, restore the previous source/image, and run `docker compose up -d --wait`.
