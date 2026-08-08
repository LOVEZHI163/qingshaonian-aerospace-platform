# 报名身份证与组织领队 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新报名强制采集并安全保存学生身份证号，同时为组织建立可审核的多领队资料；只有存在至少一名“已通过且启用”的领队时，组织及其成员才能创建新报名。

**Architecture:** 身份证号不进入现有 `registration.athlete` JSON，而是由独立敏感表保存 AES-256-GCM 密文，并仅在按角色授权的报名查询、编辑和 Excel 导出中解密。领队采用组织级主表、授权书版本表和审核历史表，文件进入私有存储；报名资格统一通过服务层校验，普通用户与组织用户共用同一条后端规则。历史报名不补录身份证，既有报名不因领队状态变化失效。

**Tech Stack:** Node.js 22、Express、PostgreSQL、Vue 3、Vitest、Node test runner、ExcelJS、Multer、docx、Docker Compose、Nginx。

## Global Constraints

- 身份证号为 18 位中国居民身份证号，支持末位 `X/x`，必须校验出生日期和校验码。
- 身份证明文不得写入日志、审计详情、现有 athlete JSON、URL、文件名或普通错误响应。
- 只有本人、所属组织负责人和平台管理员可读取完整身份证号；公开接口永不返回。
- 上线前已有报名允许身份证为空；修改这类历史报名时不得强制补录，也不得显示“待补录”。
- 新报名必须有身份证；如果提交命中已有历史报名，不自动回填身份证。
- 组织可有多个领队，但创建新报名时至少一名领队必须 `approved + enabled`。
- 领队不是赛事专属；已有报名、成绩和证书不受领队状态变化影响。
- 领队字段仅为姓名、手机、邮箱、备注、授权书、审核状态与审核记录，不采集领队身份证。
- 授权书仅支持 PDF/JPG/PNG，最大 10MB；Word 模板是通用组织授权书，不包含赛事字段。
- 所有权限约束必须由 API 实施，前端提示只用于改善操作体验。

---

## Task 1: 建立数据库和持久化契约

**Files:**

- Create: `apps/api/src/data/migrations/015-registration-identities-and-organization-leaders.sql`
- Modify: `apps/api/src/data/schema.sql`
- Modify: `apps/api/src/data/seed.js`
- Modify: `apps/api/src/data/postgres-store.js`
- Create: `apps/api/test/registration-identity-storage.test.js`
- Create: `apps/api/test/organization-leader-storage.test.js`

- [ ] **Step 1: 写失败的存储结构测试**

断言 `ensureDbShape()` 总是补齐以下数组，并且 PostgreSQL `readDb/writeDb` 可以往返保存：

```js
assert.deepEqual(db.registrationIdentities, []);
assert.deepEqual(db.organizationLeaders, []);
assert.deepEqual(db.organizationLeaderDocuments, []);
assert.deepEqual(db.organizationLeaderReviews, []);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm --workspace apps/api test -- --test-name-pattern="identity storage|leader storage"`

Expected: FAIL，缺少新数组或表映射。

- [ ] **Step 3: 创建迁移和 schema 镜像**

迁移创建：

```sql
CREATE TABLE registration_identities (
  registration_id text PRIMARY KEY REFERENCES registrations(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  id_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE organization_leaders (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text NOT NULL,
  email text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  current_document_id text,
  review_status text NOT NULL CHECK (review_status IN ('pending','approved','rejected')),
  rejection_reason text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  submission_version integer NOT NULL DEFAULT 1,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
```

另建 `organization_leader_documents` 与 `organization_leader_reviews`，分别保存私有文件元数据/版本和每次提交、通过、驳回、启停的审计快照；为 `organization_id`、`review_status`、`leader_id` 建索引，并在建表后添加 `current_document_id` 外键。

- [ ] **Step 4: 扩展文件存储与 PostgreSQL 映射**

在 `ensureDbShape` 中补齐四组数组；在 `postgres-store.js` 的读取、upsert、删除缺失行逻辑中加入四张表，保持单次 `writeDb` 原子写入。

- [ ] **Step 5: 运行存储测试**

Run: `npm --workspace apps/api test -- --test-name-pattern="identity storage|leader storage"`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/data apps/api/test/registration-identity-storage.test.js apps/api/test/organization-leader-storage.test.js
git commit -m "feat: add registration identity and leader storage"
```

---

## Task 2: 实现身份证校验、加密和安全输出

**Files:**

- Create: `apps/api/src/security/registration-identities.js`
- Create: `apps/api/test/registration-identities.test.js`
- Modify: `apps/api/src/services/audit.js`
- Modify: `apps/api/test/locked-sensitive-read.test.js`
- Modify: `apps/api/test-support/server.js`

- [ ] **Step 1: 写身份证校验与加密失败测试**

覆盖：合法号码、末位小写 x 规范化、错误长度、非法日期、错误校验码、密文不含明文、解密往返、不同 IV、缺失/错误密钥直接失败。

```js
assert.equal(normalizeStudentId("11010519491231002x"), "11010519491231002X");
assert.throws(() => normalizeStudentId("110105194912310021"), /身份证号校验失败/);
const encrypted = encryptStudentId(validId);
assert.equal(decryptStudentId(encrypted), validId);
assert.equal(JSON.stringify(encrypted).includes(validId), false);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test apps/api/test/registration-identities.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现安全模块**

导出接口：

```js
export function normalizeStudentId(value) {}
export function encryptStudentId(value) {}
export function decryptStudentId(row) {}
export function fingerprintStudentId(value) {}
export function identityDto(row) {}
```

使用 `REGISTRATION_ID_ENCRYPTION_KEY`（32 字节 base64）和 AES-256-GCM；指纹使用独立 HMAC 派生值，仅用于同一身份证冲突比较，不允许由指纹还原身份证。

- [ ] **Step 4: 扩展日志脱敏**

将 `studentIdNumber`、`identityNumber`、`idCardNumber` 加入审计敏感字段过滤；测试环境固定注入专用测试密钥。

- [ ] **Step 5: 运行测试**

Run: `node --test apps/api/test/registration-identities.test.js apps/api/test/locked-sensitive-read.test.js`

Expected: PASS，输出与日志不含身份证明文。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/security apps/api/src/services/audit.js apps/api/test apps/api/test-support/server.js
git commit -m "feat: secure student registration identities"
```

---

## Task 3: 把身份证接入新报名、修改和授权查询

**Files:**

- Modify: `apps/api/src/services/registrations.js`
- Modify: `apps/api/src/routes/registrations.js`
- Modify: `apps/api/test/registration-management.test.js`
- Create: `apps/api/test/registration-identity-access.test.js`
- Modify: `apps/api/test/multi-event-access-control.test.js`

- [ ] **Step 1: 写失败的报名行为测试**

覆盖普通用户和组织代报名：

- 新报名缺失/非法身份证返回 400，错误码 `INVALID_STUDENT_ID_NUMBER`。
- 合法新报名创建 registration 与 registration identity。
- 本人、所属组织、平台管理员能看到 `studentIdNumber` 全文。
- 其他普通用户和其他组织不能读取。
- 历史报名返回 `studentIdNumber: null`，仍能查看和修改原有字段。
- 新提交命中无 identity 的历史报名时不回填；命中有 identity 的报名时只允许相同身份证。

```js
assert.equal(response.status, 400);
assert.equal(response.body.code, "INVALID_STUDENT_ID_NUMBER");
assert.equal(owner.body.registrations[0].studentIdNumber, validId);
assert.equal(legacy.body.registrations[0].studentIdNumber, null);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test apps/api/test/registration-identity-access.test.js apps/api/test/multi-event-access-control.test.js apps/api/test/registration-management.test.js`

Expected: FAIL，现有创建接口未要求身份证且列表不返回敏感字段。

- [ ] **Step 3: 在服务层实现身份写入与装饰**

新增并复用：

```js
function requireStudentIdForNewRegistration(input) {}
function attachAuthorizedIdentity(db, registration, actor) {}
function createRegistrationIdentity(db, registrationId, studentIdNumber) {}
function assertExistingIdentityMatches(db, registrationId, studentIdNumber) {}
```

`createOrMergeRegistration` 在同一次 `store.writeDb` 中写报名和 identity。创建新行必须传 `studentIdNumber`；若命中历史行且无 identity，保持空值；若已有 identity，提交身份证必须一致，否则返回 `REGISTRATION_IDENTITY_CONFLICT`。

- [ ] **Step 4: 保护 PATCH 语义**

新报名允许本人/组织/管理员修改其身份证并重新加密；历史报名仍保持空且修改其他字段不要求身份证。任何响应只经角色授权装饰，不把密文字段传到前端。

- [ ] **Step 5: 运行测试**

Run: `node --test apps/api/test/registration-identity-access.test.js apps/api/test/multi-event-access-control.test.js apps/api/test/registration-management.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/services/registrations.js apps/api/src/routes/registrations.js apps/api/test
git commit -m "feat: require identities for new registrations"
```

---

## Task 4: 在报名 Excel 导出中加入完整身份证号

**Files:**

- Modify: `apps/api/src/exports/registration-workbook.js`
- Modify: `apps/api/src/routes/registrations.js`
- Modify: `apps/api/test/registration-export.test.js`

- [ ] **Step 1: 写失败的导出测试**

管理员导出和组织导出均包含“学生身份证号”列；新报名为全文，历史报名为空；其他组织无法导出不属于自己的报名。

```js
assert.equal(sheet.getCell("I1").value, "学生身份证号");
assert.equal(sheet.getCell("I2").text, validId);
assert.equal(sheet.getCell("I3").text, "");
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test apps/api/test/registration-export.test.js`

Expected: FAIL，工作簿没有身份证列或组织导出端点。

- [ ] **Step 3: 实现授权导出**

在构建 workbook 前按授权解密并装饰行；`BASE_COLUMNS` 在手机号后加入：

```js
["学生身份证号", (row) => row.studentIdNumber]
```

新增组织端导出 `GET /api/registrations/organization/events/:eventId/export.xlsx`，服务层始终按当前组织过滤。

- [ ] **Step 4: 运行测试**

Run: `node --test apps/api/test/registration-export.test.js`

Expected: PASS，身份证单元格强制文本格式，避免科学计数法。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/exports/registration-workbook.js apps/api/src/routes/registrations.js apps/api/test/registration-export.test.js
git commit -m "feat: export authorized student identities"
```

---

## Task 5: 更新普通用户、组织用户和管理员报名界面

**Files:**

- Modify: `apps/admin/src/pages/RegistrationPage.vue`
- Modify: `apps/admin/src/components/OrganizationAthleteRegistrationForm.vue`
- Modify: `apps/admin/src/pages/RegistrationRecordsPage.vue`
- Modify: `apps/admin/src/pages/OrganizationRegistrationRecordsPage.vue`
- Modify: `apps/admin/src/pages/RegistrationManagementPage.vue`
- Modify: `apps/admin/src/styles/admin.css`
- Modify: `apps/admin/src/pages/__tests__/RegistrationPage.event-context.test.js`
- Modify: `apps/admin/src/pages/__tests__/OrganizationEventWorkspacePage.test.js`
- Modify: `apps/admin/src/pages/__tests__/RegistrationManagementPage.test.js`
- Modify: `apps/admin/src/pages/__tests__/OrganizationRegistrationRecordsPage.test.js`

- [ ] **Step 1: 写失败的界面测试**

验证普通报名和组织报名均出现必填“学生身份证号”，输入提示为“18 位居民身份证号，末位可为 X”；提交 payload 包含顶层 `studentIdNumber`。三个授权列表显示完整值，历史空值显示 `—（历史报名）`。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm --workspace apps/admin exec vitest run -- src/pages/__tests__/RegistrationPage.event-context.test.js src/pages/__tests__/OrganizationEventWorkspacePage.test.js src/pages/__tests__/RegistrationManagementPage.test.js src/pages/__tests__/OrganizationRegistrationRecordsPage.test.js`

Expected: FAIL，字段和列尚不存在。

- [ ] **Step 3: 实现表单和中文提示**

在报名按钮前加入声明：

> 学生身份证号是报名资料，将用于名单导出和证书信息核对，请本人或监护人确认填写正确。

前端先进行长度/字符校验，但以后端校验为准。身份证独立于 `athlete` 对象传递，避免进入 athlete JSON。

- [ ] **Step 4: 实现授权列表展示**

普通用户只显示本人报名，组织负责人只显示本组织，平台管理员显示全部；值为空时仅标识为历史资料为空，不出现催补文案。

- [ ] **Step 5: 运行前端测试和构建**

Run: `npm --workspace apps/admin exec vitest run -- src/pages/__tests__/RegistrationPage.event-context.test.js src/pages/__tests__/OrganizationEventWorkspacePage.test.js src/pages/__tests__/RegistrationManagementPage.test.js src/pages/__tests__/OrganizationRegistrationRecordsPage.test.js`

Run: `npm --workspace apps/admin run build`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/admin/src
git commit -m "feat: collect student identities in registration ui"
```

---

## Task 6: 实现领队领域服务、私有授权书和 Word 模板

**Files:**

- Modify: `apps/api/package.json`
- Modify: `package-lock.json`
- Create: `apps/api/src/services/organization-leaders.js`
- Create: `apps/api/src/exports/leader-authorization-docx.js`
- Modify: `apps/api/src/files/policy.js`
- Create: `apps/api/test/organization-leaders.test.js`
- Create: `apps/api/test/leader-authorization-docx.test.js`

- [ ] **Step 1: 写失败的领域服务测试**

覆盖：多领队、必填姓名/手机、可选邮箱/备注、文件类型和 10MB 限制、初次提交 pending、姓名/手机/授权书变化重置 pending、只改邮箱/备注不重置、独立启停、审核历史逐条保留。

- [ ] **Step 2: 写失败的 DOCX 测试**

调用：

```js
const buffer = await buildLeaderAuthorizationDocx({
  organizationName: "温州市实验小学",
  leaderName: "张老师",
  leaderPhone: "13800000000"
});
assert.equal(buffer.subarray(0, 2).toString(), "PK");
```

解包后确认文档 XML 包含组织、姓名、手机，不包含赛事名称。

- [ ] **Step 3: 运行测试并确认失败**

Run: `node --test apps/api/test/organization-leaders.test.js apps/api/test/leader-authorization-docx.test.js`

Expected: FAIL，模块和 `docx` 依赖不存在。

- [ ] **Step 4: 安装依赖并实现服务**

Run: `npm install --workspace apps/api docx`

服务接口：

```js
export function listOrganizationLeaders(db, organizationId) {}
export function createOrganizationLeader(db, input, actor) {}
export function updateOrganizationLeader(db, leaderId, input, actor) {}
export function reviewOrganizationLeader(db, leaderId, decision, actor) {}
export function setOrganizationLeaderEnabled(db, leaderId, enabled, actor) {}
export function organizationHasApprovedLeader(db, organizationId) {}
```

复用私有文件存储和现有 credential 文件策略；文件目录类别使用 `organization-leader-documents`。

- [ ] **Step 5: 实现通用授权书模板**

模板文字明确“学校/机构授权该负责人作为本组织赛事领队，负责报名联络、资料核对与赛事沟通”，包含签章和日期留白；不绑定任何赛事。

- [ ] **Step 6: 运行测试**

Run: `node --test apps/api/test/organization-leaders.test.js apps/api/test/leader-authorization-docx.test.js`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/api/package.json package-lock.json apps/api/src/services/organization-leaders.js apps/api/src/exports/leader-authorization-docx.js apps/api/src/files/policy.js apps/api/test
git commit -m "feat: add organization leader workflow"
```

---

## Task 7: 暴露组织领队和平台审核 API

**Files:**

- Create: `apps/api/src/routes/organization-leaders.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/services/organization-account-lifecycle.js`
- Create: `apps/api/src/files/cleanup-references.js`
- Create: `apps/api/test/organization-leader-routes.test.js`
- Modify: `apps/api/test/organization-account-lifecycle.test.js`

- [ ] **Step 1: 写失败的路由和权限测试**

验证组织负责人只能管理本组织，普通用户全部 403，平台管理员可列出/筛选/审核全部领队；受保护授权书仅所属组织负责人和平台管理员可下载。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test apps/api/test/organization-leader-routes.test.js apps/api/test/organization-account-lifecycle.test.js`

Expected: FAIL，路由不存在。

- [ ] **Step 3: 实现组织端路由**

```text
GET    /api/organization/leaders
POST   /api/organization/leaders/authorization-template.docx
POST   /api/organization/leaders
PATCH  /api/organization/leaders/:leaderId
PATCH  /api/organization/leaders/:leaderId/enabled
GET    /api/organization/leaders/:leaderId/authorization/:documentId
GET    /api/organization/leaders/:leaderId/reviews
```

创建/修改使用 Multer memory storage；模板端点接收 `{ name, phone }`，组织名从当前审核通过的组织读取，禁止客户端伪造。

- [ ] **Step 4: 实现平台端路由**

```text
GET    /api/admin/organization-leaders
PATCH  /api/admin/organization-leaders/:leaderId/review
PATCH  /api/admin/organization-leaders/:leaderId/enabled
```

审核 body 为 `{ decision: "approved" | "rejected", reason }`；驳回必须填写原因。

- [ ] **Step 5: 接入组织删除和文件清理**

平台管理员删除组织时，数据库级联删除领队数据，但先把授权书物理文件写入 cleanup journal；文件引用检查识别领队文档，避免删错仍被引用的文件。

- [ ] **Step 6: 运行测试**

Run: `node --test apps/api/test/organization-leader-routes.test.js apps/api/test/organization-account-lifecycle.test.js`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/routes/organization-leaders.js apps/api/src/app.js apps/api/src/services/organization-account-lifecycle.js apps/api/src/files/cleanup-references.js apps/api/test
git commit -m "feat: expose organization leader review api"
```

---

## Task 8: 开发组织领队页面和平台审核页面

**Files:**

- Create: `apps/admin/src/pages/OrganizationLeadersPage.vue`
- Create: `apps/admin/src/pages/AdminLeaderReviewPage.vue`
- Create: `apps/admin/src/pages/__tests__/OrganizationLeadersPage.test.js`
- Create: `apps/admin/src/pages/__tests__/AdminLeaderReviewPage.test.js`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/components/AdminShell.vue`
- Modify: `apps/admin/src/styles/admin.css`

- [ ] **Step 1: 写失败的组织页面测试**

验证组织负责人可以：填写姓名/手机/邮箱/备注、下载已预填 DOCX、上传授权书、提交审核、查看状态/原因/历史、修改资料、启用/停用；普通用户侧边栏无“领队管理”。

- [ ] **Step 2: 写失败的平台审核页面测试**

验证平台管理员可按组织/状态搜索，预览或下载授权书，查看历史，通过、驳回和启停；驳回无原因不可提交。

- [ ] **Step 3: 运行测试并确认失败**

Run: `npm --workspace apps/admin exec vitest run -- src/pages/__tests__/OrganizationLeadersPage.test.js src/pages/__tests__/AdminLeaderReviewPage.test.js`

Expected: FAIL，页面不存在。

- [ ] **Step 4: 实现导航与页面**

组织负责人固定侧边栏加入 `["leaders", "领队管理", "领"]`，放在“组织与成员”之后；审核未通过的组织仍只能看到审核进度和修改密码。平台侧边栏加入 `["leaders", "领队审核"]`，不按赛事筛选。

- [ ] **Step 5: 实现状态和修改引导**

页面明确：

- 姓名、手机或授权书变化会重新审核。
- 邮箱、备注变化不会影响已通过状态。
- 只要仍有其他已通过且启用的领队，报名不受影响。

- [ ] **Step 6: 运行前端测试和构建**

Run: `npm --workspace apps/admin exec vitest run -- src/pages/__tests__/OrganizationLeadersPage.test.js src/pages/__tests__/AdminLeaderReviewPage.test.js`

Run: `npm --workspace apps/admin run build`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/admin/src
git commit -m "feat: add leader management interfaces"
```

---

## Task 9: 把领队状态接入统一报名资格

**Files:**

- Modify: `apps/api/src/services/access-control.js`
- Modify: `apps/api/src/services/registrations.js`
- Create: `apps/api/test/organization-registration-permissions.test.js`
- Modify: `apps/api/test/membership-service.test.js`
- Modify: `apps/api/test/multi-event-access-control.test.js`
- Modify: `apps/admin/src/state/access.js`
- Modify: `apps/admin/src/pages/RegistrationPage.vue`
- Modify: `apps/admin/src/components/OrganizationAthleteRegistrationForm.vue`
- Modify: `apps/admin/src/pages/EventCenterPage.vue`
- Modify: `apps/admin/src/pages/__tests__/OrdinaryEventWorkflow.test.js`
- Modify: `apps/admin/src/pages/__tests__/OrganizationEventWorkspacePage.test.js`

- [ ] **Step 1: 写失败的资格矩阵测试**

矩阵必须为：

| 场景 | 可创建新报名 |
|---|---|
| 组织无领队 | 否 |
| 仅 pending/rejected/disabled 领队 | 否 |
| 至少一名 approved + enabled | 是 |
| 其中一名重审，但另一名仍有效 | 是 |
| 所有有效领队后来停用 | 新报名否，已有报名仍可查 |

普通组织成员与组织负责人都必须经过相同规则，错误码统一为 `ORGANIZATION_LEADER_REQUIRED`。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test apps/api/test/organization-registration-permissions.test.js apps/api/test/membership-service.test.js apps/api/test/multi-event-access-control.test.js`

Expected: FAIL，现有资格检查没有领队条件。

- [ ] **Step 3: 实现统一后端拦截**

在 `ordinaryRegistrationEligibility` 和组织报名创建入口调用：

```js
if (!organizationHasApprovedLeader(db, organization.id)) {
  return { eligible: false, code: "ORGANIZATION_LEADER_REQUIRED", organization };
}
```

只拦截 POST 创建，不拦截 GET、已有记录 PATCH、成绩和证书读取。

- [ ] **Step 4: 增加清楚的前端提示**

普通用户提示“所属组织尚无审核通过且已启用的领队，请联系组织负责人”；组织负责人提示“请先在领队管理提交至少一名领队并等待平台审核通过”。报名按钮禁用但赛事详情仍可查看。

- [ ] **Step 5: 运行 API 与前端测试**

Run: `node --test apps/api/test/organization-registration-permissions.test.js apps/api/test/membership-service.test.js apps/api/test/multi-event-access-control.test.js`

Run: `npm --workspace apps/admin exec vitest run -- src/pages/__tests__/OrdinaryEventWorkflow.test.js src/pages/__tests__/OrganizationEventWorkspacePage.test.js src/pages/__tests__/OrganizationLeadersPage.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src apps/api/test apps/admin/src
git commit -m "feat: require approved organization leader for registration"
```

---

## Task 10: 配置密钥、全量回归和生产部署

**Files:**

- Modify: `.env.example`
- Modify: `compose.yaml`
- Modify: `deploy/bootstrap-secrets.sh`
- Modify: `deploy/preflight-admin-upgrade.sh`
- Modify: `docs/deployment/aliyun-test.md`
- Modify: `apps/api/test/deployment.test.js`
- Modify: `apps/api/test/deployment-paths.test.js`
- Modify: `apps/api/test/locked-sensitive-read.test.js`

- [ ] **Step 1: 写失败的部署配置测试**

断言 compose 与预检脚本要求 `REGISTRATION_ID_ENCRYPTION_KEY`，密钥不得拥有默认生产值，测试 allowlist 明确允许该环境变量。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test apps/api/test/deployment.test.js apps/api/test/deployment-paths.test.js apps/api/test/locked-sensitive-read.test.js`

Expected: FAIL，部署配置尚未声明新密钥。

- [ ] **Step 3: 接入生产密钥和预检**

`bootstrap-secrets.sh` 仅在缺失时生成 32 字节随机 base64 密钥；compose 传入 API；预检在密钥无效时阻止升级。不得把真实密钥提交到 Git。

- [ ] **Step 4: 运行全量验证**

Run: `npm --workspace apps/api test && npm --workspace apps/admin test && npm --workspace apps/web test -- --run`

Run: `npm run build`

Run: `git diff --check`

Expected: 所有测试、构建和空白检查通过。

- [ ] **Step 5: 执行数据备份和部署预检**

Run:

```bash
ssh aerogp "cd /opt/aerogp && ./deploy/backup-postgres.sh && ./deploy/backup-uploads.sh"
ssh aerogp "cd /opt/aerogp && ./deploy/preflight-admin-upgrade.sh"
```

Expected: PostgreSQL/上传文件备份成功，磁盘空间、密钥、迁移条件均通过。

- [ ] **Step 6: 部署到 ECS**

按照仓库既有部署方式同步已提交代码到 `/opt/aerogp`，然后：

```bash
ssh aerogp "cd /opt/aerogp && docker compose build api admin && docker compose up -d"
```

- [ ] **Step 7: 生产冒烟验证**

验证：

1. `https://aerogp.cn/` 和 `/admin/` 返回 200。
2. 旧报名仍可查询且身份证栏为空。
3. 无有效领队时普通用户和组织负责人均不能新报名，并显示中文原因。
4. 组织提交领队、平台审核通过后，两种报名入口均可提交合法身份证。
5. 管理员和所属组织导出的 Excel 含完整身份证号，其他角色不可访问。
6. 授权书只有所属组织和平台管理员可下载。

- [ ] **Step 8: 回滚演练与提交**

迁移为增量表，代码回滚时保留新表；应用回滚到上一镜像后不读取新表。若必须数据回滚，仅在已确认备份可恢复后执行。

```bash
git add .env.example compose.yaml deploy docs/deployment/aliyun-test.md apps/api/test/deployment.test.js apps/api/test/deployment-paths.test.js apps/api/test/locked-sensitive-read.test.js
git commit -m "chore: configure identity encryption deployment"
```

---

## Final Review Checklist

- [ ] 逐条对照批准的设计文档，确认学生身份证、历史兼容、多领队、审核、权限、导出和部署均有实现任务。
- [ ] 人工确认计划中不含未定项、占位内容或未选择的方案。
- [ ] 搜索身份证明文落盘风险：`rg -n "studentIdNumber|identityNumber|idCardNumber" apps/api/src`，逐处确认只在验证、加密、授权 DTO 和导出内使用。
- [ ] 检查四类账户权限：未登录、普通用户、组织负责人、平台管理员。
- [ ] 检查历史报名无身份证、现有报名不受领队状态影响。
- [ ] 检查所有上传失败、审核驳回和资格不足均返回中文业务提示，不出现 HTML 错误页或空白页面。
