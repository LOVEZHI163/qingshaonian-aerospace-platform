# Organization Workspace Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一组织用户导航，把跨赛事报名记录独立为侧边栏模块，并将单场赛事工作台收敛为清晰、受约束的组织报名页面。

**Architecture:** 新增从登录会话推导负责组织的跨赛事报名查询服务和 `GET /api/organization/registrations` 路由，服务端始终用报名记录持久化的 `organizationId` 做隔离。管理端新增专用 `OrganizationRegistrationRecordsPage`；单场 `OrganizationEventWorkspacePage` 只编排赛事摘要和报名表，报名表从工作台接收组织默认学校和规范年级选项。

**Tech Stack:** Node.js 22、Express 4、Vue 3、Vite 6、Vitest 4、Node test runner、PostgreSQL/JSON store abstraction、Docker Compose、Nginx。

## Global Constraints

- 组织用户侧边栏固定为“赛事工作台、报名记录、组织与成员、证书查询、退出登录”。
- “审核进度”不再作为独立菜单；未审核组织在“组织与成员”查看审核状态。
- 单场赛事页面不再显示“组织报名、报名记录、成绩、证书”横向导航。
- 跨赛事报名记录只返回 `registration.organizationId === 当前负责组织.id` 的记录；不得按姓名、手机号或当前成员关系推断归属。
- 已退出成员在加入期间形成并已绑定该组织的报名继续保留。
- 年级下拉精确包含小学一年级至六年级、初一至初三、高一至高三、职高一年级至职高三年级。
- 年级下拉不联动过滤赛项；服务端继续推导组别并校验赛项适用范围。
- 新建报名默认学校为组织名称但允许修改；编辑时不得覆盖原学校。
- 接口失败只显示简洁中文错误和重试入口，不得渲染 HTML 错误正文。
- 不新增运行时依赖，不修改赛事发布、证书发布、成员邀请或作品文件规格。

---

## File Structure

- `apps/api/src/services/registrations.js`：组织跨赛事记录查询、筛选和分页。
- `apps/api/src/routes/registrations.js`：组织级报名记录路由，从会话推导组织。
- `apps/api/test/organization-registration-history.test.js`：历史归属、隔离、筛选、分页和鉴权。
- `apps/admin/src/App.vue`：固定组织菜单和注册新页面。
- `apps/admin/src/pages/OrganizationRegistrationRecordsPage.vue`：跨赛事记录、筛选、分页和材料操作。
- `apps/admin/src/pages/OrganizationEventWorkspacePage.vue`：只保留赛事信息和组织报名。
- `apps/admin/src/components/OrganizationAthleteRegistrationForm.vue`：规范年级、默认学校和重置。
- `apps/admin/src/pages/__tests__/AppNavigation.test.js`：菜单与路由回归。
- `apps/admin/src/pages/__tests__/OrganizationRegistrationRecordsPage.test.js`：记录页测试。
- `apps/admin/src/pages/__tests__/OrganizationEventWorkspacePage.test.js`：报名页测试。
- `apps/admin/src/styles/admin.css`：卡片、筛选器、分页和响应式样式。
- `deploy/remote-smoke-test.sh`：发布冒烟。
- `docs/deployment/aliyun-test.md`：发布与回滚证据。

---

### Task 1: Add the organization-scoped registration history API

**Files:**
- Modify: `apps/api/src/services/registrations.js`
- Modify: `apps/api/src/routes/registrations.js`
- Create: `apps/api/test/organization-registration-history.test.js`

**Interfaces:**
- Consumes: `requireOrganizationOwner(db, user)` and `withRegistrationSubmission(db, row)`.
- Produces: `listOrganizationRegistrations(db, organizationId, query, clock): { rows, total, page, pageSize, refreshedAt, filterOptions }`.
- Produces: `GET /api/organization/registrations?q=&eventId=&projectId=&status=&page=1&pageSize=25`.

- [ ] **Step 1: Write API tests that prove ownership is stored, not inferred**

Create two events, two organizations and these records:

```js
const rows = [
  { id: "R-OWN-ORG", eventId: "E1", organizationId: "O1001", personalUserId: null, athlete: { name: "组织代报名", school: "本组织", grade: "三年级", phone: "13800001001" }, projectId: "P1", projectName: "纸飞机", status: "pending" },
  { id: "R-OWN-MEMBER", eventId: "E2", organizationId: "O1001", personalUserId: "U-MEMBER", athlete: { name: "退出成员", school: "本组织", grade: "初二", phone: "13800001002" }, projectId: "P2", projectName: "无人机", status: "approved", awardName: "一等奖" },
  { id: "R-FOREIGN", eventId: "E1", organizationId: "O2002", personalUserId: "U-FOREIGN", athlete: { name: "其他组织成员", school: "其他组织", grade: "五年级", phone: "13800001003" }, projectId: "P1", projectName: "纸飞机", status: "pending" },
  { id: "R-PERSONAL", eventId: "E1", organizationId: null, personalUserId: "U-MEMBER", athlete: { name: "无组织个人报名", school: "本组织", grade: "三年级", phone: "13800001002" }, projectId: "P1", projectName: "纸飞机", status: "pending" }
];
```

Assert the owner receives exactly `R-OWN-ORG` and `R-OWN-MEMBER`, including after the member relation is `removed`; foreign and unbound rows never appear; ordinary users receive 403.

- [ ] **Step 2: Run the new API test and verify it fails**

Run: `node --test apps/api/test/organization-registration-history.test.js`

Expected: FAIL because the route and service do not exist.

- [ ] **Step 3: Implement the pure listing service**

```js
export function listOrganizationRegistrations(db, organizationId, query = {}, clock = () => new Date()) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requestedSize = Number.parseInt(query.pageSize, 10);
  const pageSize = Math.min(100, Math.max(10, requestedSize || 25));
  const q = normalizeText(query.q);
  const owned = db.registrations.filter((row) => row.organizationId === organizationId);
  const filtered = owned.filter((row) => {
    if (query.eventId && row.eventId !== query.eventId) return false;
    if (query.projectId && row.projectId !== query.projectId) return false;
    if (query.status && row.status !== query.status) return false;
    if (!q) return true;
    return [row.id, row.athlete?.name, row.athlete?.phone, row.projectName]
      .some((value) => normalizeText(value).includes(q));
  }).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || b.id.localeCompare(a.id));
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize).map((row) => {
    const event = db.events.find((item) => item.id === row.eventId);
    return { ...withRegistrationSubmission(db, row), eventName: event?.name || row.eventId };
  });
  const events = [...new Map(owned.map((row) => {
    const event = db.events.find((item) => item.id === row.eventId);
    return [row.eventId, { id: row.eventId, name: event?.name || row.eventId }];
  })).values()];
  const projects = [...new Map(owned.map((row) => [row.projectId, { id: row.projectId, name: row.projectName || row.projectId }])).values()];
  return { rows, total: filtered.length, page, pageSize, refreshedAt: clock().toISOString(), filterOptions: { events, projects } };
}
```

- [ ] **Step 4: Add the session-derived route**

```js
router.get("/organization/registrations", ...user, asyncRoute(async (req, res) => {
  const db = await store.readDb();
  const organization = requireOrganizationOwner(db, req.user);
  res.json(listOrganizationRegistrations(db, organization.id, req.query, clock));
}));
```

Do not read `req.query.organizationId` and do not broaden the filter by active membership.

- [ ] **Step 5: Test filtering and pagination**

Test `eventId=E2`, `status=approved`, `q=退出成员`, `page=1&pageSize=10` and an out-of-range page. Assert filter options contain only values from the current organization.

- [ ] **Step 6: Run focused API tests**

Run: `node --test apps/api/test/organization-registration-history.test.js apps/api/test/account-events.test.js apps/api/test/authorization.test.js apps/api/test/registration-management.test.js`

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/registrations.js apps/api/src/routes/registrations.js apps/api/test/organization-registration-history.test.js
git commit -m "feat: add organization registration history"
```

---

### Task 2: Stabilize organization navigation and add the records page

**Files:**
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/pages/__tests__/AppNavigation.test.js`
- Create: `apps/admin/src/pages/OrganizationRegistrationRecordsPage.vue`
- Create: `apps/admin/src/pages/__tests__/OrganizationRegistrationRecordsPage.test.js`

**Interfaces:**
- Consumes: `GET /api/organization/registrations`.
- Produces: view key `organizationRecords` and fixed labels `赛事工作台、报名记录、组织与成员、证书查询`.

- [ ] **Step 1: Write failing navigation tests**

For pending and approved organizations:

```js
expect(wrapper.findAll("[data-user-nav]").map((item) => item.text())).toEqual([
  "赛事工作台", "报名记录", "组织与成员", "证书查询"
]);
expect(wrapper.text()).not.toContain("审核进度");
```

Click `[data-user-nav="organizationRecords"]`; assert the page exists and URL has `view=organizationRecords` without `eventId`.

- [ ] **Step 2: Verify failure**

Run: `npm test -w apps/admin -- --run src/pages/__tests__/AppNavigation.test.js`

Expected: FAIL because menus differ and the view is absent.

- [ ] **Step 3: Register the view**

Import the records page, include `organizationRecords` in deep-link and organization allowlists, and return:

```js
[
  ["eventCenter", "赛事工作台"],
  ["organizationRecords", "报名记录"],
  ["organization", "组织与成员"],
  ["certificates", "证书查询"]
]
```

Keep `organizationWorkspace` highlighted as `eventCenter`. Pending organizations may enter `organization`, where the console renders review progress.

- [ ] **Step 4: Write failing records page tests**

Mock `/api/organization/registrations?page=1&pageSize=25` with two events; assert event, athlete, score and award. Change filters and assert encoded query values. Test empty state. Reject with HTML-looking text and assert “报名记录加载失败，请重试” plus retry, without `<!DOCTYPE html>`.

- [ ] **Step 5: Verify failure**

Run: `npm test -w apps/admin -- --run src/pages/__tests__/OrganizationRegistrationRecordsPage.test.js`

Expected: FAIL because the page is absent.

- [ ] **Step 6: Implement listing, filters and pagination**

```js
const filters = reactive({ q: "", eventId: "", projectId: "", status: "", page: 1, pageSize: 25 });
const rows = ref([]);
const total = ref(0);
const filterOptions = reactive({ events: [], projects: [] });
const loading = ref(false);
const error = ref("");
```

Build `URLSearchParams` from non-empty filters and paging. Search/select changes reset page. Disable previous/next outside valid pages. Show score and award in every row.

- [ ] **Step 7: Run tests**

Run: `npm test -w apps/admin -- --run src/pages/__tests__/OrganizationRegistrationRecordsPage.test.js src/pages/__tests__/AppNavigation.test.js`

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/admin/src/App.vue apps/admin/src/pages/OrganizationRegistrationRecordsPage.vue apps/admin/src/pages/__tests__/OrganizationRegistrationRecordsPage.test.js apps/admin/src/pages/__tests__/AppNavigation.test.js
git commit -m "feat: add organization records workspace"
```

---

### Task 3: Constrain grades and default the school

**Files:**
- Modify: `apps/api/src/routes/account-events.js`
- Modify: `apps/api/test/account-events.test.js`
- Modify: `apps/admin/src/components/OrganizationAthleteRegistrationForm.vue`
- Modify: `apps/admin/src/pages/OrganizationEventWorkspacePage.vue`
- Modify: `apps/admin/src/pages/__tests__/OrganizationEventWorkspacePage.test.js`

**Interfaces:**
- Produces workspace `organization: { id, name }`.
- Produces form props `grades` and `defaultSchool`.

- [ ] **Step 1: Write failing tests**

Assert workspace organization identity. Assert grade options exactly equal:

```js
[
  "一年级", "二年级", "三年级", "四年级", "五年级", "六年级",
  "初一", "初二", "初三", "高一", "高二", "高三",
  "职高一年级", "职高二年级", "职高三年级"
]
```

Assert new school defaults to organization, accepts edits, resets after create, and editing preserves the stored school.

- [ ] **Step 2: Verify failure**

Run: `node --test apps/api/test/account-events.test.js`

Run: `npm test -w apps/admin -- --run src/pages/__tests__/OrganizationEventWorkspacePage.test.js`

Expected: FAIL because organization is absent and grade is free text.

- [ ] **Step 3: Return safe organization identity**

Add only `organization: { id: organization.id, name: organization.name }`; do not expose credentials, credit code or owner metadata.

- [ ] **Step 4: Implement form initialization**

```js
const gradeOptions = computed(() => props.grades.flatMap((group) => group.grades || []));
function blankAthlete() {
  return { name: "", school: props.defaultSchool || "", grade: "", phone: "" };
}
```

Editing copies the stored athlete unchanged. New/reset uses `blankAthlete()`. A default-school watcher only fills an empty new form.

- [ ] **Step 5: Replace grade input**

```vue
<select v-model="form.athlete.grade" data-field="athlete-grade" required>
  <option value="" disabled>请选择年级</option>
  <option v-for="grade in gradeOptions" :key="grade" :value="grade">{{ grade }}</option>
</select>
```

Keep `SchoolCombobox` editable. Pass workspace grades and organization name.

- [ ] **Step 6: Run tests**

Run: `node --test apps/api/test/account-events.test.js apps/api/test/registration-management.test.js`

Run: `npm test -w apps/admin -- --run src/pages/__tests__/OrganizationEventWorkspacePage.test.js src/components/__tests__/SchoolCombobox.test.js`

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/account-events.js apps/api/test/account-events.test.js apps/admin/src/components/OrganizationAthleteRegistrationForm.vue apps/admin/src/pages/OrganizationEventWorkspacePage.vue apps/admin/src/pages/__tests__/OrganizationEventWorkspacePage.test.js
git commit -m "feat: constrain organization registration form"
```

---

### Task 4: Simplify and restyle the single-event workspace

**Files:**
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/pages/OrganizationEventWorkspacePage.vue`
- Modify: `apps/admin/src/pages/__tests__/OrganizationEventWorkspacePage.test.js`
- Modify: `apps/admin/src/styles/admin.css`

**Interfaces:**
- Produces event `back-to-events`.
- Produces classes `organization-event-summary-card`, `organization-registration-guide`, `organization-registration-card`.

- [ ] **Step 1: Write failing layout tests**

Assert no `[data-workspace-tab]`, no old results/certificate tabs, return button and three cards. Click return and assert `back-to-events`.

- [ ] **Step 2: Verify failure**

Run: `npm test -w apps/admin -- --run src/pages/__tests__/OrganizationEventWorkspacePage.test.js`

Expected: FAIL because four tabs remain.

- [ ] **Step 3: Remove workspace-local tables**

Delete tab, certificate, export, results and replacement state from the workspace. Keep load/access-denied, summary and registration form. Editing moves to the records page.

- [ ] **Step 4: Render three cards**

Event card: name, date, venue, deadline and state. Guide: organization fixed, school editable. Form card: organization form. Handle return in `App.vue` with `navigateUser('eventCenter')`.

- [ ] **Step 5: Add responsive styles**

Use existing blue/white palette. Above 768px keep two-column rows; at or below 768px use one column. Apply `min-width: 0`; contain tables in `.table-wrap`; prevent page-level horizontal scrolling.

- [ ] **Step 6: Run tests**

Run: `npm test -w apps/admin -- --run src/pages/__tests__/OrganizationEventWorkspacePage.test.js src/pages/__tests__/EventCenterPage.test.js src/pages/__tests__/AppNavigation.test.js`

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/App.vue apps/admin/src/pages/OrganizationEventWorkspacePage.vue apps/admin/src/pages/__tests__/OrganizationEventWorkspacePage.test.js apps/admin/src/styles/admin.css
git commit -m "refactor: simplify organization event workspace"
```

---

### Task 5: Complete record actions and safe errors

**Files:**
- Modify: `apps/admin/src/pages/OrganizationRegistrationRecordsPage.vue`
- Modify: `apps/admin/src/pages/__tests__/OrganizationRegistrationRecordsPage.test.js`
- Modify: `apps/admin/src/styles/admin.css`

**Interfaces:**
- Consumes existing organization material and upload-session endpoints.
- Produces edit, download and replacement actions using each row’s `eventId`.

- [ ] **Step 1: Write failing action tests**

For image/video rows, assert preview/download paths use organization endpoints. Assert replacement upload session uses the row event/project. Assert edit receives the row and its workspace context. For 403/404, assert concise text and retry/return controls.

- [ ] **Step 2: Verify failure**

Run: `npm test -w apps/admin -- --run src/pages/__tests__/OrganizationRegistrationRecordsPage.test.js`

Expected: FAIL because actions are incomplete.

- [ ] **Step 3: Implement organization material paths**

```js
function organizationAssetPath(row, kind) {
  return `/api/organization/events/${encodeURIComponent(row.eventId)}/registrations/${encodeURIComponent(row.id)}/assets/${kind}`;
}
```

Reuse uploader/download helpers. Never fall back to personal `/api/me/events` endpoints.

- [ ] **Step 4: Implement editing on demand**

On edit, load `/api/organization/events/:eventId/workspace` and render the form with that workspace’s projects, grades, organization and selected row. On save, reload and close. Archived events expose no edit/replace controls.

- [ ] **Step 5: Normalize unsafe errors**

Use fallback when a message contains `<html`, `<!doctype` or `Cannot GET`; preserve concise Chinese business errors; render retry.

- [ ] **Step 6: Run tests**

Run: `npm test -w apps/admin -- --run src/pages/__tests__/OrganizationRegistrationRecordsPage.test.js src/pages/__tests__/OrganizationEventWorkspacePage.test.js`

Run: `node --test apps/api/test/submission-authorization.test.js apps/api/test/submission-assets.test.js apps/api/test/organization-registration-history.test.js`

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/pages/OrganizationRegistrationRecordsPage.vue apps/admin/src/pages/__tests__/OrganizationRegistrationRecordsPage.test.js apps/admin/src/styles/admin.css
git commit -m "feat: manage organization registration records"
```

---

### Task 6: Verify, review and deploy

**Files:**
- Modify: `deploy/remote-smoke-test.sh`
- Modify: `apps/api/test/verify-release-script.test.js`
- Modify: `docs/deployment/aliyun-test.md`

**Interfaces:**
- Consumes SSH alias `aerogp`, path `/opt/aerogp`, credential file `/root/aerogp-admin-credentials.txt`.
- Produces exact runtime SHA in `/opt/aerogp/.release` and verified rollback backups.

- [ ] **Step 1: Write a failing smoke contract**

Require organization records HTTP 200, absence of foreign fixture, workspace organization/grades and `/admin/?view=organizationRecords` shell.

Run: `node --test apps/api/test/verify-release-script.test.js`

Expected: FAIL until smoke contains checks.

- [ ] **Step 2: Update smoke**

Use unique temporary IDs and existing preview/confirm cleanup. Never print credentials or tokens. Rerun contract and expect PASS.

- [ ] **Step 3: Run local release gates**

```powershell
npm test -w apps/api
npm test -w apps/admin
npm test -w apps/web
npm run build
git diff --check
git status --short
```

Expected: all tests/builds PASS; diff check prints nothing.

- [ ] **Step 4: Final review**

Review design commit through HEAD. Block deployment for cross-organization leakage, personal endpoint fallback, missing archived guard, raw HTML errors or untested navigation. Fix with focused tests and rerun Step 3.

- [ ] **Step 5: Create production backups**

Create verified PostgreSQL dump, uploads tar, previous source archive and rollback API/Web tags. Run `/bin/sh deploy/preflight-admin-upgrade.sh`; continue only after `Upgrade preflight passed.`. Never run `docker compose down -v` or delete volumes.

- [ ] **Step 6: Deploy exact reviewed runtime commit**

Archive reviewed HEAD to unique `/tmp/aerogp-organization-workspace-<sha>`, preserve `.env` and backups, install source, write SHA to `/opt/aerogp/.release`, then:

```sh
docker compose build
docker compose up -d --wait --wait-timeout 240
```

Expected: PostgreSQL, API, Web and Backup healthy; only Web publishes port 80.

- [ ] **Step 7: Production smoke and browser verification**

Verify stable menus, no “审核进度”, own cross-event history only, no workspace tabs, fifteen grade values, editable default school, ordinary/image-video submissions and no overflow at 360px/desktop.

- [ ] **Step 8: Record release evidence**

Append runtime SHA, backups, rollback tags, test counts, smoke, health and disk usage to `docs/deployment/aliyun-test.md`. Commit documentation. If documentation changes HEAD after runtime deployment, record runtime and documentation SHA separately; `.release` must equal runtime source.
