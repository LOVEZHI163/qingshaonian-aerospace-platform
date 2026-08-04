# Organization Membership Invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为普通用户增加“我的组织”，支持用户申请、组织邀请、本人确认、单组织限制、退出和移除，并保持历史赛事数据不变。

**Architecture:** 将当前散落在 `server.js` 的成员关系逻辑提取到独立领域服务，并由一个成员关系路由同时提供新接口和旧接口兼容层。数据库增加“每个普通用户最多一个 active 关系”的部分唯一索引；普通用户和组织负责人分别使用独立页面组件，共享同一套后端状态机。

**Tech Stack:** Node.js 22、Express、PostgreSQL 16、Vue 3、Vitest、Node test runner、Docker Compose。

## Global Constraints

- 组织负责人仍由 `organizations.ownerUserId` 唯一确定，不通过 `memberships.role` 授权。
- 普通用户全局最多只能加入一个组织。
- 组织邀请必须由普通用户本人接受后才能生效。
- 只允许邀请已经注册且状态为 active 的 ordinary 用户。
- 退出或移除不修改历史报名、成绩和证书的组织归属。
- 不增加多级组织管理员、短信通知、邮件通知或通用消息中心。
- 所有成员写操作必须通过现有 mutation lock，身份和组织一律从会话与数据库解析。
- 新增行为严格执行测试先行；每个任务先观察预期失败，再写最小实现。

## File Structure

- Create `apps/api/src/services/memberships.js`：成员关系状态机、单组织约束、安全 DTO 和搜索规则。
- Create `apps/api/src/routes/memberships.js`：普通用户、组织负责人和旧兼容接口的认证与响应映射。
- Create `apps/api/src/data/migrations/011-single-active-membership.sql`：PostgreSQL 单 active 关系约束。
- Modify `apps/api/src/data/schema.sql`：新数据库同步包含该唯一索引。
- Modify `apps/api/src/server.js`：挂载成员路由并删除旧的内联成员处理器。
- Create `apps/api/test/membership-relations.test.js`：双向流程、越权、单组织、退出和历史数据接口测试。
- Modify `apps/api/test/postgres-store.test.js`：数据库级单 active 约束测试。
- Create `apps/admin/src/pages/MyOrganizationPage.vue`：普通用户组织搜索、申请、邀请处理和退出。
- Create `apps/admin/src/pages/__tests__/MyOrganizationPage.test.js`：普通用户组织页面行为测试。
- Modify `apps/admin/src/pages/OrganizationConsolePage.vue`：负责人邀请、分类成员列表和汇总。
- Modify `apps/admin/src/pages/__tests__/OrganizationConsolePage.test.js`：邀请与成员管理行为测试。
- Modify `apps/admin/src/App.vue`：普通用户导航、深链接和“我的组织”页面编排。
- Modify `apps/admin/src/pages/__tests__/AppNavigation.test.js`：角色导航回归。
- Modify `apps/admin/src/__tests__/App.test.js`：完整会话导航回归。
- Modify `apps/admin/src/styles/forms.css`：两个组织关系页面的卡片、筛选和响应式布局。
- Modify `deploy/remote-smoke-test.sh`：加入成员新接口的认证边界检查。
- Modify `apps/api/test/deployment.test.js`：远程冒烟脚本契约测试。

---

### Task 1: PostgreSQL 单组织硬约束

**Files:**
- Create: `apps/api/src/data/migrations/011-single-active-membership.sql`
- Modify: `apps/api/src/data/schema.sql`
- Test: `apps/api/test/postgres-store.test.js`

**Interfaces:**
- Consumes: `memberships(user_id, status)` 现有表。
- Produces: `memberships_single_active_user_idx`，只约束 `user_id IS NOT NULL AND status = 'active'`。

- [ ] **Step 1: Write the failing database test**

在 `apps/api/test/postgres-store.test.js` 增加：

```js
test("PostgreSQL permits pending relations but enforces one active organization per user", async () => {
  await withStore(async (_store, pool) => {
    await pool.query(`INSERT INTO users (id, name, phone, password, type, status, created_at)
      VALUES ('UMEMBER', '成员', '13700009999', 'hash', 'ordinary', 'active', NOW())`);
    await pool.query(`INSERT INTO memberships
      (id, user_id, organization_id, role, status, direction, created_at, updated_at)
      VALUES
      ('MP1', 'UMEMBER', 'O1001', 'member', 'pending', 'user_request', NOW(), NOW()),
      ('MP2', 'UMEMBER', 'O1002', 'member', 'pending', 'organization_invite', NOW(), NOW())`);
    await pool.query("UPDATE memberships SET status = 'active' WHERE id = 'MP1'");
    await assert.rejects(
      pool.query("UPDATE memberships SET status = 'active' WHERE id = 'MP2'"),
      /memberships_single_active_user_idx/
    );
  });
});
```

- [ ] **Step 2: Run the test and verify the missing constraint**

Run:

```bash
npm test -w apps/api -- --test-name-pattern="PostgreSQL permits pending relations"
```

Expected: FAIL because the second active update succeeds.

- [ ] **Step 3: Add the migration and base schema index**

`011-single-active-membership.sql` and `schema.sql` both contain:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS memberships_single_active_user_idx
ON memberships(user_id)
WHERE user_id IS NOT NULL AND status = 'active';
```

- [ ] **Step 4: Run the focused database tests**

Run:

```bash
npm test -w apps/api -- --test-name-pattern="PostgreSQL permits pending relations|PostgreSQL store"
```

Expected: PASS, including migration replay and snapshot persistence tests.

- [ ] **Step 5: Commit the database invariant**

```bash
git add apps/api/src/data/migrations/011-single-active-membership.sql apps/api/src/data/schema.sql apps/api/test/postgres-store.test.js
git commit -m "feat(api): enforce one active organization membership"
```

---

### Task 2: 成员关系领域服务

**Files:**
- Create: `apps/api/src/services/memberships.js`
- Create: `apps/api/test/membership-service.test.js`

**Interfaces:**
- Consumes: 数据快照 `{ users, organizations, memberships, registrations, certificates }`、会话用户、`makeId(prefix)`、`now()`。
- Produces:
  - `listPersonalRelations(db, user): { active, requests, invitations }`
  - `searchOperationalOrganizations(db, query): OrganizationSummary[]`
  - `requestMembership(db, user, input, makeId, now): MembershipMutation`
  - `findInvitationCandidate(db, owner, phone): UserSummary`
  - `inviteMembership(db, owner, input, makeId, now): MembershipMutation`
  - `actAsPersonalUser(db, user, membershipId, action, now): MembershipMutation`
  - `listOwnedMemberships(db, owner): { organization, summary, rows }`
  - `actAsOrganizationOwner(db, owner, membershipId, action, now): MembershipMutation`

`MembershipMutation` 固定为：

```js
{
  row: { id, userId, organizationId, role, status, direction, note, createdAt, updatedAt },
  organization: { id, name, code, contactName, contactPhone },
  cancelled: [{ id, organizationId }],
  changed: true
}
```

- [ ] **Step 1: Write failing service tests for request and invitation creation**

测试文件先定义确定性 fixture：

```js
const fixedNow = "2026-08-04T00:00:00.000Z";
const now = () => fixedNow;
let sequence = 0;
const makeId = (prefix) => `${prefix}-TEST-${++sequence}`;

function fixture() {
  return {
    users: [
      { id: "U1", name: "普通用户", phone: "13700000001", type: "ordinary", status: "active" },
      { id: "UO1", name: "组织负责人一", phone: "13700000011", type: "organization", status: "active" },
      { id: "UO2", name: "组织负责人二", phone: "13700000012", type: "organization", status: "active" }
    ],
    organizations: [
      { id: "O1", name: "组织一", code: "ORG-001", ownerUserId: "UO1", status: "active", reviewStatus: "approved", contactName: "负责人一", contactPhone: "13700000011" },
      { id: "O2", name: "组织二", code: "ORG-002", ownerUserId: "UO2", status: "active", reviewStatus: "approved", contactName: "负责人二", contactPhone: "13700000012" }
    ],
    memberships: [],
    registrations: [],
    certificates: []
  };
}
```

```js
test("ordinary request and owner invitation create pending member relations", () => {
  const db = fixture();
  const request = requestMembership(db, db.users[0], { organizationId: "O1", note: "申请加入" }, makeId, now);
  const invitation = inviteMembership(db, db.users[2], { phone: "13700000001" }, makeId, now);
  assert.equal(request.row.direction, "user_request");
  assert.equal(invitation.row.direction, "organization_invite");
  assert.equal(request.row.status, "pending");
  assert.equal(invitation.row.status, "pending");
  assert.equal(request.row.role, "member");
});
```

覆盖组织必须 approved/active、候选必须 active ordinary、手机号必须完整 11 位、同组织旧关系复用。

- [ ] **Step 2: Run and observe imports fail**

Run:

```bash
node --test apps/api/test/membership-service.test.js
```

Expected: FAIL with missing `services/memberships.js` exports.

- [ ] **Step 3: Implement safe lookup and pending relation creation**

核心创建逻辑必须复用旧关系：

```js
function upsertPending(db, { user, organization, direction, note, makeId, now }) {
  const existing = db.memberships.find((row) => row.userId === user.id && row.organizationId === organization.id);
  if (existing?.status === "active" || existing?.status === "pending") return { row: existing, changed: false };
  const row = existing || { id: makeId("M"), userId: user.id, organizationId: organization.id, createdAt: now() };
  Object.assign(row, {
    invitedPhone: user.phone,
    invitedName: user.name,
    role: "member",
    status: "pending",
    direction,
    note: String(note || "").trim().slice(0, 200),
    updatedAt: now()
  });
  if (!existing) db.memberships.unshift(row);
  return { row, changed: true };
}
```

- [ ] **Step 4: Write failing transition tests**

```js
test("accepting one invitation activates it and rejects every other pending relation", () => {
  const db = fixture();
  db.memberships = [
    { id: "M1", userId: "U1", organizationId: "O1", role: "member", status: "pending", direction: "organization_invite", note: "", createdAt: now(), updatedAt: now() },
    { id: "M2", userId: "U1", organizationId: "O2", role: "member", status: "pending", direction: "organization_invite", note: "", createdAt: now(), updatedAt: now() }
  ];
  const result = actAsPersonalUser(db, db.users[0], "M1", "accept", now);
  assert.equal(result.row.status, "active");
  assert.deepEqual(result.cancelled.map((row) => row.id), ["M2"]);
  assert.equal(db.memberships.find((row) => row.id === "M2").status, "rejected");
});

test("leaving an organization preserves registrations and certificates", () => {
  const db = fixture();
  db.memberships = [{ id: "M1", userId: "U1", organizationId: "O1", role: "member", status: "active", direction: "user_request", note: "", createdAt: now(), updatedAt: now() }];
  db.registrations = [{ id: "R1", personalUserId: "U1", organizationId: "O1", eventId: "E1" }];
  db.certificates = [{ id: "C1", registrationId: "R1", status: "published" }];
  const before = structuredClone({ registrations: db.registrations, certificates: db.certificates });
  actAsPersonalUser(db, db.users[0], "M1", "leave", now);
  assert.deepEqual({ registrations: db.registrations, certificates: db.certificates }, before);
  assert.equal(db.memberships[0].status, "removed");
});
```

另测 `withdraw/reject/approve/cancel/remove`、错误方向、错误操作者、已有其他 active 关系。

- [ ] **Step 5: Run transition tests and verify they fail**

Run:

```bash
node --test apps/api/test/membership-service.test.js
```

Expected: FAIL because transition exports or branches do not exist.

- [ ] **Step 6: Implement the explicit transition table**

使用常量而不是接受客户端目标状态：

```js
const PERSONAL_ACTIONS = {
  withdraw: { direction: "user_request", from: "pending", to: "rejected" },
  accept: { direction: "organization_invite", from: "pending", to: "active" },
  reject: { direction: "organization_invite", from: "pending", to: "rejected" },
  leave: { from: "active", to: "removed" }
};
const OWNER_ACTIONS = {
  approve: { direction: "user_request", from: "pending", to: "active" },
  reject: { direction: "user_request", from: "pending", to: "rejected" },
  cancel: { direction: "organization_invite", from: "pending", to: "rejected" },
  remove: { from: "active", to: "removed" }
};
```

进入 `active` 前调用 `ensureNoOtherActiveMembership(db, row.userId, row.id)`；成功后调用 `rejectOtherPendingMemberships(db, row.userId, row.id, now)`。

- [ ] **Step 7: Run all service tests**

Run:

```bash
node --test apps/api/test/membership-service.test.js
```

Expected: PASS with no warnings.

- [ ] **Step 8: Commit the domain service**

```bash
git add apps/api/src/services/memberships.js apps/api/test/membership-service.test.js
git commit -m "feat(api): add organization membership state machine"
```

---

### Task 3: 新成员接口与旧接口兼容层

**Files:**
- Create: `apps/api/src/routes/memberships.js`
- Create: `apps/api/test/membership-relations.test.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test/authorization.test.js`

**Interfaces:**
- Consumes: Task 2 的八个 service exports、`recordAudit()`、`store`、session guards 和 mutation route。
- Produces: 设计文档中的八个新接口；兼容 `/api/organizations/request`、`/api/memberships/:id` 和 `/api/organizations/:id/members`。

- [ ] **Step 1: Write failing end-to-end API tests**

在 `membership-relations.test.js` 用真实测试服务器覆盖：

```js
function jsonOptions(method, body, cookie) {
  return withSession(cookie, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function registerAndLoginOrdinary(baseUrl, input) {
  const response = await fetch(`${baseUrl}/api/auth/register/ordinary`, jsonOptions("POST", input));
  assert.equal(response.status, 201);
  return loginAs(baseUrl, input.phone, input.password);
}
```

```js
test("organization invitation requires personal acceptance", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const owner = await loginAs(baseUrl, "13800000011", "123456");
    const ordinary = await registerAndLoginOrdinary(baseUrl, { name: "受邀用户", phone: "13700000021", password: "Member21" });
    const candidate = await fetch(`${baseUrl}/api/organization/member-candidate?phone=13700000021`, withSession(owner.cookie));
    assert.equal(candidate.status, 200);
    const invitation = await fetch(`${baseUrl}/api/organization/invitations`, jsonOptions("POST", { phone: "13700000021" }, owner.cookie));
    assert.equal(invitation.status, 201);
    const relation = (await invitation.json()).row;
    assert.equal(relation.status, "pending");
    const beforeAccept = await fetch(`${baseUrl}/api/me/organizations`, withSession(ordinary.cookie));
    assert.deepEqual((await beforeAccept.json()).rows, []);
    const accepted = await fetch(`${baseUrl}/api/me/organization-relations/${relation.id}`, jsonOptions("PATCH", { action: "accept" }, ordinary.cookie));
    assert.equal(accepted.status, 200);
    const afterAccept = await fetch(`${baseUrl}/api/me/organizations`, withSession(ordinary.cookie));
    assert.equal((await afterAccept.json()).rows[0].id, "O1001");
  });
});
```

再覆盖用户申请/组织审批、双方拒绝、撤销、退出、移除、第二组织冲突、其他用户和其他负责人越权、重复操作幂等与审计记录。

- [ ] **Step 2: Run the new API test and verify 404 failures**

Run:

```bash
node --test apps/api/test/membership-relations.test.js
```

Expected: FAIL because `/api/me/organization-relations` and invitation endpoints return 404.

- [ ] **Step 3: Build the membership router**

路由工厂签名：

```js
export function createMembershipsRouter({
  store, requireUser, requirePasswordReady, asyncRoute, mutationAsyncRoute, makeId, now
}) { /* register read routes and mutation routes */ }
```

所有 GET handler 使用 `asyncRoute`；所有 mutation handler 使用 `mutationAsyncRoute`，并固定执行 `readDb()` → service transition → `recordAudit()` → `writeDb()` → safe DTO response。候选手机号使用 `/^1\d{10}$/`，action 只从显式白名单读取。

- [ ] **Step 4: Mount the router and remove inline handlers**

在 `server.js` 注册：

```js
app.use("/api", createMembershipsRouter({
  store: dataStore,
  requireUser,
  requirePasswordReady,
  asyncRoute,
  mutationAsyncRoute,
  makeId: id,
  now
}));
```

删除 `server.js` 中旧的 `/api/organizations`、`/api/organizations/request`、`/api/memberships/:id`、`/api/organizations/:id/members` 内联实现；兼容 URL 由新 router 注册并调用同一 service。

- [ ] **Step 5: Expand authorization boundary tests**

将新接口加入未登录和错误角色矩阵，明确断言普通用户不能调用 owner endpoints，组织负责人不能调用 personal mutation，管理员不能自动获得组织负责人权限。

- [ ] **Step 6: Run focused API suites**

Run:

```bash
node --test apps/api/test/membership-relations.test.js apps/api/test/authorization.test.js apps/api/test/organization-credentials.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit the API surface**

```bash
git add apps/api/src/routes/memberships.js apps/api/src/server.js apps/api/test/membership-relations.test.js apps/api/test/authorization.test.js apps/api/test/organization-credentials.test.js
git commit -m "feat(api): expose bidirectional organization membership"
```

---

### Task 4: 普通用户“我的组织”页面

**Files:**
- Create: `apps/admin/src/pages/MyOrganizationPage.vue`
- Create: `apps/admin/src/pages/__tests__/MyOrganizationPage.test.js`
- Modify: `apps/admin/src/styles/forms.css`

**Interfaces:**
- Consumes:
  - `GET /api/me/organization-relations`
  - `GET /api/organizations/search?q=`
  - `POST /api/me/organization-requests`
  - `PATCH /api/me/organization-relations/:id { action }`
- Produces: `<MyOrganizationPage @error @organization-changed>`，测试标识 `my-organization-page`。

- [ ] **Step 1: Write failing component tests**

```js
it("searches organizations and submits a personal request", async () => {
  apiMock.mockImplementation(async (path, options) => {
    if (path === "/api/me/organization-relations") return { active: null, requests: [], invitations: [] };
    if (path === "/api/organizations/search?q=%E5%AE%9E%E9%AA%8C") return { rows: [{ id: "O1", name: "实验学校", code: "WZ-001" }] };
    if (path === "/api/me/organization-requests" && options?.method === "POST") return { row: { id: "M1", status: "pending" } };
    return { rows: [] };
  });
  const wrapper = mount(MyOrganizationPage);
  await flushPromises();
  await wrapper.get('[data-field="organization-search"]').setValue("实验");
  await wrapper.get('[data-action="search-organizations"]').trigger("click");
  await flushPromises();
  await wrapper.get('[data-action="request-organization-O1"]').trigger("click");
  await flushPromises();
  expect(apiMock).toHaveBeenCalledWith("/api/me/organization-requests", expect.objectContaining({ method: "POST" }));
});
```

另测邀请接受/拒绝、申请撤回、active 卡片退出、错误保留搜索输入、操作后刷新。

- [ ] **Step 2: Run and verify missing component failure**

Run:

```bash
npm test -w apps/admin -- src/pages/__tests__/MyOrganizationPage.test.js
```

Expected: FAIL because `MyOrganizationPage.vue` does not exist.

- [ ] **Step 3: Implement the page state and actions**

组件只维护 `relations`、`query`、`results`、`note`、`loading`、`busyAction` 和 `message`。统一 mutation：

```js
async function updateRelation(row, action) {
  busyAction.value = `${row.id}:${action}`;
  try {
    await api(`/api/me/organization-relations/${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ action })
    });
    await loadRelations();
    emit("organization-changed");
  } catch (error) {
    message.value = error.message || "组织关系操作失败";
  } finally {
    busyAction.value = "";
  }
}
```

`leave` 使用 `window.confirm("确认退出该组织？历史报名、成绩和证书不会删除。")`。

- [ ] **Step 4: Add scoped responsive styles**

新增 `.my-organization-page`、`.organization-relation-grid`、`.organization-result-card`、`.relation-status-list`；宽屏两列，`max-width: 760px` 时单列，不修改通用按钮颜色。

- [ ] **Step 5: Run component tests**

Run:

```bash
npm test -w apps/admin -- src/pages/__tests__/MyOrganizationPage.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit the personal page**

```bash
git add apps/admin/src/pages/MyOrganizationPage.vue apps/admin/src/pages/__tests__/MyOrganizationPage.test.js apps/admin/src/styles/forms.css
git commit -m "feat(admin): add personal organization relations page"
```

---

### Task 5: 组织负责人邀请与成员管理

**Files:**
- Modify: `apps/admin/src/pages/OrganizationConsolePage.vue`
- Modify: `apps/admin/src/pages/__tests__/OrganizationConsolePage.test.js`
- Modify: `apps/admin/src/styles/forms.css`

**Interfaces:**
- Consumes:
  - `GET /api/organization/member-candidate?phone=`
  - `POST /api/organization/invitations`
  - `GET /api/organization/memberships`
  - `PATCH /api/organization/memberships/:id { action }`
- Produces: 现有 `OrganizationConsolePage` 的邀请、申请、正式成员和历史关系模块。

- [ ] **Step 1: Replace the obsolete expectation with failing invitation tests**

```js
it("finds a registered ordinary user and sends an invitation", async () => {
  const wrapper = mount(OrganizationConsolePage);
  await flushPromises();
  await wrapper.get('[data-field="member-phone"]').setValue("13700000021");
  await wrapper.get('[data-action="find-member"]').trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("受邀用户");
  await wrapper.get('[data-action="invite-member"]').trigger("click");
  await flushPromises();
  expect(apiMock).toHaveBeenCalledWith("/api/organization/invitations", expect.objectContaining({ method: "POST" }));
});
```

另测概览数字、申请通过/拒绝、邀请撤销、成员移除、非 operational 组织不显示邀请工具。

- [ ] **Step 2: Run and observe missing controls**

Run:

```bash
npm test -w apps/admin -- src/pages/__tests__/OrganizationConsolePage.test.js
```

Expected: FAIL because `member-phone` and invitation actions do not exist.

- [ ] **Step 3: Switch loading to the owner membership summary**

operational 分支调用 `/api/organization/memberships`，按 `direction/status` 计算或使用响应 `summary` 展示三个数字。资质审核进度仍继续调用 `/api/me/organizations`。

- [ ] **Step 4: Add exact-phone candidate and invite actions**

查询前使用 `/^1\d{10}$/` 给出本地提示；只在返回 `{ user: { id, name, phone } }` 后显示确认邀请按钮。邀请成功后清空候选并刷新成员关系。

- [ ] **Step 5: Map owner actions explicitly**

```js
const ownerActions = {
  approve: "通过申请",
  reject: "拒绝申请",
  cancel: "撤销邀请",
  remove: "移除成员"
};
```

`remove` 必须弹出 `确认移除成员 ${row.user.name}？历史报名和证书不会删除。`；所有 action 请求只发送 `{ action }`。

- [ ] **Step 6: Run organization console tests**

Run:

```bash
npm test -w apps/admin -- src/pages/__tests__/OrganizationConsolePage.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit organization management UI**

```bash
git add apps/admin/src/pages/OrganizationConsolePage.vue apps/admin/src/pages/__tests__/OrganizationConsolePage.test.js apps/admin/src/styles/forms.css
git commit -m "feat(admin): let organization owners invite members"
```

---

### Task 6: 角色导航与会话刷新

**Files:**
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/pages/__tests__/AppNavigation.test.js`
- Modify: `apps/admin/src/__tests__/App.test.js`

**Interfaces:**
- Consumes: Task 4 的 `MyOrganizationPage` 和 `organization-changed` event。
- Produces: ordinary `myOrganization` 深链接与固定导航。

- [ ] **Step 1: Write failing navigation tests**

```js
it("shows the personal organization page without changing event context", async () => {
  const wrapper = await mountFor({ id: "U1", type: "ordinary", name: "普通用户", phone: "13800000001", mustChangePassword: false });
  expect(wrapper.findAll("[data-user-nav]").map((item) => item.text())).toEqual([
    "赛事中心", "我的组织", "报名记录", "证书查询"
  ]);
  await wrapper.get('[data-user-nav="myOrganization"]').trigger("click");
  await flushPromises();
  expect(wrapper.find('[data-testid="my-organization-page"]').exists()).toBe(true);
  expect(new URLSearchParams(window.location.search).get("view")).toBe("myOrganization");
});
```

另测组织用户和管理员看不到该入口、刷新深链接恢复页面、从赛事报名切换不会错误请求报名接口。

- [ ] **Step 2: Run and verify navigation test failure**

Run:

```bash
npm test -w apps/admin -- src/pages/__tests__/AppNavigation.test.js src/__tests__/App.test.js
```

Expected: FAIL because ordinary navigation lacks `myOrganization`.

- [ ] **Step 3: Register the view**

在 `App.vue`：

```js
import MyOrganizationPage from "./pages/MyOrganizationPage.vue";
```

- 把 `myOrganization` 加入 `DEEP_LINK_VIEWS` 和 ordinary allowed view set。
- ordinary navigation 顺序固定为 `eventCenter`、`myOrganization`、`registrationRecords`、`certificates`。
- `userHeaderEvent` 为该页面返回 `{ name: "我的组织", date: "", venue: "", registrationDeadline: "" }`。
- template 渲染 `<MyOrganizationPage v-else-if="currentView === 'myOrganization'" @organization-changed="refreshPersonalOrganization" @error="handleError" />`。
- `refreshPersonalOrganization()` 调用 `session.restore()` 和 `loadAccountEvents()`，使报名页立即获得最新 active 组织。

- [ ] **Step 4: Run navigation and session tests**

Run:

```bash
npm test -w apps/admin -- src/pages/__tests__/AppNavigation.test.js src/__tests__/App.test.js src/state/__tests__/session.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit application integration**

```bash
git add apps/admin/src/App.vue apps/admin/src/pages/__tests__/AppNavigation.test.js apps/admin/src/__tests__/App.test.js
git commit -m "feat(admin): integrate personal organization navigation"
```

---

### Task 7: 部署检查与完整回归

**Files:**
- Modify: `deploy/remote-smoke-test.sh`
- Modify: `apps/api/test/deployment.test.js`

**Interfaces:**
- Consumes: 新成员接口和现有远程管理员测试凭据。
- Produces: 部署前后的自动认证边界检查；不在远程冒烟中永久创建成员关系。

- [ ] **Step 1: Write the failing deployment contract test**

在 `apps/api/test/deployment.test.js` 断言远程冒烟包含：

```js
assert.match(script, /\/api\/me\/organization-relations/);
assert.match(script, /\/api\/organization\/memberships/);
assert.match(script, /organization-relations-unauthenticated=401/);
```

- [ ] **Step 2: Run and observe the missing smoke checks**

Run:

```bash
npm test -w apps/api -- --test-name-pattern="remote smoke"
```

Expected: FAIL because the new URLs are absent.

- [ ] **Step 3: Add non-mutating remote checks**

`remote-smoke-test.sh` 增加：

```sh
assert_status "organization-relations-unauthenticated" 401 GET "/api/me/organization-relations"
assert_status "organization-memberships-admin-forbidden" 403 GET "/api/organization/memberships" "$ADMIN_COOKIE"
```

不得在生产远程冒烟中发送邀请、审批或退出真实成员。

- [ ] **Step 4: Run the full local verification**

Run:

```bash
npm test -w apps/admin
npm test -w apps/api
npm run build
git diff --check
```

Expected: admin and API have zero failed tests; production build exits 0; diff check produces no errors.

- [ ] **Step 5: Commit deployment coverage**

```bash
git add deploy/remote-smoke-test.sh apps/api/test/deployment.test.js
git commit -m "test(deploy): cover organization membership routes"
```

- [ ] **Step 6: Deploy with the existing atomic ECS workflow**

Run preflight and first audit whether historical data violates the new invariant:

```bash
docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc "SELECT user_id || chr(9) || count(*) FROM memberships WHERE user_id IS NOT NULL AND status = '\''active'\'' GROUP BY user_id HAVING count(*) > 1"'
```

Expected: no output. If any row is returned, stop deployment and report the conflicting user IDs; do not silently reject or remove historical relationships.

After the audit passes, synchronize committed files, tag current API and web images for rollback, build both images with `RELEASE_SHA=$(git rev-parse HEAD)`, then execute:

```bash
docker compose up -d --no-deps --wait --wait-timeout 240 api web
EXPECTED_RELEASE="$RELEASE_SHA" BASE_URL=http://127.0.0.1 /bin/sh deploy/verify-release.sh
BASE_URL=http://127.0.0.1 /bin/sh deploy/remote-smoke-test.sh
```

Only after both verifiers pass, atomically write the 40-byte release SHA to `.release`.

- [ ] **Step 7: Verify the public release**

Check `/api/system/version`, `/admin/`, container health, and the hashed admin bundle for “我的组织” and “邀请成员”. Expected release SHA equals the committed local HEAD and both containers report healthy.
