# AeroGP 管理平台阶段二：组织审核与报名管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复两类注册表单状态串联，交付组织资质审核、组织自动匹配、学校搜索、年级自动分组、管理员报名筛选刷新和完整 Excel 导出。

**Architecture:** 组织资质使用私有持久化文件和独立元数据表；组织注册与普通注册使用独立 API 和 Vue 组件。报名写入时由 API 从 session、当前赛事、年级和项目配置派生组织、组别与开放状态；管理员列表由服务端分页筛选，Excel 导出复用同一查询条件但不分页。

**Tech Stack:** Node.js/Express、Multer、file-type、ExcelJS、PostgreSQL、Vue 3、Vitest、Vue Test Utils。

## Global Constraints

- 普通注册和组织注册必须拥有完全独立的表单对象与提交函数。
- 组织必填统一社会信用代码和一份资质文件；允许营业执照、事业单位法人证书或办学许可证。
- 组织审核通过前可以登录查看进度，但不能邀请成员、代报名或进入组织管理功能。
- 学校候选来自已审核组织和历史报名学校；没有匹配项时允许手动输入。
- 报名组别只能由实际年级自动派生，客户端提交的组别不得覆盖服务端结果。
- 导出证书模板只包含已审核通过的报名；本阶段先交付名单模板列，内嵌证书图片导入在阶段三完成。

---

### Task 1: 建立私有文件存储和组织资质数据结构

**Files:**
- Create: `apps/api/src/files/storage.js`
- Create: `apps/api/src/files/policy.js`
- Create: `apps/api/src/data/migrations/002-organization-credentials.sql`
- Create: `apps/api/test/organization-credentials.test.js`
- Modify: `apps/api/src/data/schema.sql`
- Modify: `apps/api/src/data/seed.js`
- Modify: `apps/api/src/data/postgres-store.js`
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `validateUpload(file, policy)`、`savePrivateFile({ category, ownerId, file })`、`deletePrivateFile(record)`。
- Produces: `organizationDocuments[]` 数据结构及 `organizations.reviewStatus` 等审核字段。
- Consumes: `UPLOAD_ROOT`，生产默认 `/data/uploads`，测试使用临时目录。

- [ ] **Step 1: 安装文件签名依赖并写失败测试**

  Run: `npm install -w apps/api file-type`

  `organization-credentials.test.js` 验证：

  ```js
  test("credential policy accepts real PNG and PDF and rejects disguised executables", async () => {
    await assert.doesNotReject(() => validateUpload(pngFile, CREDENTIAL_POLICY));
    await assert.doesNotReject(() => validateUpload(pdfFile, CREDENTIAL_POLICY));
    await assert.rejects(() => validateUpload({ ...exeFile, originalname: "license.png", mimetype: "image/png" }, CREDENTIAL_POLICY));
  });
  ```

  同时扩展 PostgreSQL 测试，断言 `organization_documents` 表存在，`organizations.credit_code` 唯一，旧组织迁移为 `review_status='approved'`。

  Run: `npm test -w apps/api -- --test-name-pattern="credential|organization_documents"`

  Expected: FAIL，文件策略和新表不存在。

- [ ] **Step 2: 实现文件策略和安全存储**

  `policy.js`：

  ```js
  export const CREDENTIAL_POLICY = {
    extensions: new Set(["png", "jpg", "jpeg", "pdf"]),
    mimeTypes: new Set(["image/png", "image/jpeg", "application/pdf"]),
    maxBytes: 10 * 1024 * 1024
  };
  ```

  `validateUpload()` 使用 `fileTypeFromBuffer()` 检查真实签名，PDF 同时检查 `%PDF-`。`savePrivateFile()` 只使用随机 UUID 作为磁盘文件名：

  ```js
  const storedName = `${crypto.randomUUID()}.${detected.ext}`;
  const directory = path.join(uploadRoot, category, ownerId);
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, storedName);
  await fs.writeFile(filePath, file.buffer, { flag: "wx" });
  return { storedName, filePath, originalName: safeOriginalName(file.originalname), mimeType: detected.mime, size: file.size };
  ```

- [ ] **Step 3: 增加组织审核字段和资质表**

  `002-organization-credentials.sql`：

  ```sql
  ALTER TABLE organizations ADD COLUMN IF NOT EXISTS credit_code TEXT;
  ALTER TABLE organizations ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE organizations ADD COLUMN IF NOT EXISTS reject_reason TEXT NOT NULL DEFAULT '';
  ALTER TABLE organizations ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES users(id);
  ALTER TABLE organizations ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
  ALTER TABLE organizations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

  UPDATE organizations
  SET credit_code = 'LEGACY-' || id, review_status = 'approved'
  WHERE credit_code IS NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS organizations_credit_code_key ON organizations(credit_code);

  CREATE TABLE IF NOT EXISTS organization_documents (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL,
    cleaned_at TIMESTAMPTZ
  );
  ```

  PostgreSQL store 和 file store 的 `ensureDbShape` 都增加 `organizationDocuments`；组织映射增加 `creditCode`、`reviewStatus`、`rejectReason`、`reviewedBy`、`reviewedAt`、`updatedAt`。

- [ ] **Step 4: 运行测试并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="credential|PostgreSQL"`

  Expected: PASS。

  ```bash
  git add apps/api/src/files apps/api/src/data apps/api/test/organization-credentials.test.js apps/api/package.json package-lock.json
  git commit -m "feat: store organization credentials privately"
  ```

### Task 2: 实现独立注册和组织审核 API

**Files:**
- Create: `apps/api/src/routes/organizations.js`
- Create: `apps/api/src/services/organizations.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test/organization-credentials.test.js`
- Modify: `apps/api/test/admin-users.test.js`

**Interfaces:**
- Produces: `POST /api/auth/register/ordinary`、`POST /api/auth/register/organization`。
- Produces: `GET /api/me/organizations`、`GET /api/admin/organizations`、`PATCH /api/admin/organizations/:id/review`。
- Produces: `GET /api/organizations/:id/credential/:documentId` 私有下载。
- Consumes: 阶段一 session middleware、Task 1 文件存储和审核字段。

- [ ] **Step 1: 写注册和审核全流程失败测试**

  测试通过 multipart 注册组织并断言：

  ```js
  assert.equal(register.status, 201);
  assert.equal(payload.organization.reviewStatus, "pending");
  assert.equal(payload.organization.creditCode, "91330300TEST000001");

  const pendingConsole = await fetch(`${baseUrl}/api/organizations/${payload.organization.id}/members`, withSession(owner.cookie));
  assert.equal(pendingConsole.status, 403);

  const approve = await fetch(`${baseUrl}/api/admin/organizations/${payload.organization.id}/review`, withSession(admin.cookie, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "approved", reason: "" })
  }));
  assert.equal(approve.status, 200);
  ```

  增加重复信用代码返回 `409`、缺资质返回 `422`、驳回原因为空返回 `422`、非管理员审核返回 `403` 的测试。

  Run: `npm test -w apps/api -- --test-name-pattern="organization registration review"`

  Expected: FAIL，独立注册和审核路由不存在。

- [ ] **Step 2: 实现普通与组织注册服务**

  普通注册只接收 `{ name, phone, password }`。组织注册使用 `upload.single("credential")`，接收：

  ```js
  {
    name,
    phone,
    password,
    organizationName,
    creditCode,
    documentType: "business_license" | "public_institution_certificate" | "school_license"
  }
  ```

  用户、组织、owner membership 和资质元数据在一次数据库写入中创建；文件写入成功后才提交数据，数据库写入失败则删除刚保存的文件。组织状态为 active，但 `reviewStatus` 为 pending；组织能力检查同时要求二者均为可用状态。

- [ ] **Step 3: 实现审核、重提和私有预览**

  审核函数只允许 `approved` 或 `rejected`：

  ```js
  export function reviewOrganization(organization, input, reviewerId, now) {
    if (!new Set(["approved", "rejected"]).has(input.status)) throw validationError("审核状态无效");
    if (input.status === "rejected" && !String(input.reason || "").trim()) throw validationError("驳回原因不能为空");
    organization.reviewStatus = input.status;
    organization.rejectReason = input.status === "rejected" ? input.reason.trim() : "";
    organization.reviewedBy = reviewerId;
    organization.reviewedAt = now;
    organization.updatedAt = now;
    return organization;
  }
  ```

  组织负责人可以通过 `PATCH /api/me/organization` 修改被驳回资料并替换资质，提交后重置为 pending。资质下载验证管理员或该组织 active owner。

- [ ] **Step 4: 运行测试并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="organization"`

  Expected: PASS。

  ```bash
  git add apps/api/src/routes/organizations.js apps/api/src/services/organizations.js apps/api/src/server.js apps/api/test
  git commit -m "feat: review organization registrations"
  ```

### Task 3: 修复注册表单串联并交付组织审核页面

**Files:**
- Create: `apps/admin/src/pages/AuthPage.vue`
- Create: `apps/admin/src/components/OrdinaryRegistrationForm.vue`
- Create: `apps/admin/src/components/OrganizationRegistrationForm.vue`
- Create: `apps/admin/src/pages/OrganizationManagementPage.vue`
- Create: `apps/admin/src/pages/__tests__/AuthPage.test.js`
- Create: `apps/admin/src/pages/__tests__/OrganizationManagementPage.test.js`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/styles.css`

**Interfaces:**
- Produces: `OrdinaryRegistrationForm` emits `registered(user)`。
- Produces: `OrganizationRegistrationForm` emits `registered(user)`，使用 multipart 上传。
- Produces: `OrganizationManagementPage` 管理待审核/通过/驳回/停用组织。
- Consumes: Task 2 的注册、审核和资质预览 API。

- [ ] **Step 1: 写能复现左右同步输入的失败测试**

  `AuthPage.test.js`：

  ```js
  it("keeps ordinary and organization registration values independent", async () => {
    const wrapper = mount(AuthPage, { global: { stubs: { Teleport: true } } });
    const ordinaryName = wrapper.get('[data-testid="ordinary-name"]');
    const organizationName = wrapper.get('[data-testid="organization-owner-name"]');
    await ordinaryName.setValue("张三家长");
    expect(organizationName.element.value).toBe("");
    await organizationName.setValue("李老师");
    expect(ordinaryName.element.value).toBe("张三家长");
  });
  ```

  Run: `npm test -w apps/admin -- --run AuthPage`

  Expected: FAIL，当前两个 form 共用 `registerForm`。

- [ ] **Step 2: 实现两个独立表单组件**

  普通组件内部状态：

  ```js
  const form = reactive({ name: "", phone: "", password: "" });
  ```

  组织组件内部状态：

  ```js
  const form = reactive({
    name: "", phone: "", password: "", organizationName: "", creditCode: "",
    documentType: "business_license", credential: null
  });
  ```

  两组件分别调用独立 API。组织组件要求文件存在，显示允许格式和 10 MB 限制；普通组件不渲染任何组织字段。

- [ ] **Step 3: 实现组织审核列表与详情抽屉**

  页面提供状态 tab、名称/信用代码/负责人搜索、刷新按钮、资质预览、通过、驳回、停用和启用。驳回使用页面内对话框输入原因，不使用 `window.prompt`。详情显示成员数、报名数、审核人和审核时间。

  审核请求：

  ```js
  await api(`/api/admin/organizations/${selected.value.id}/review`, {
    method: "PATCH",
    body: JSON.stringify({ status: reviewStatus.value, reason: rejectReason.value })
  });
  await loadOrganizations();
  ```

- [ ] **Step 4: 接入 App 并运行测试**

  未登录渲染 `AuthPage`；管理员菜单 `organizations` 渲染 `OrganizationManagementPage`；pending 组织用户登录后显示审核进度卡片，不显示组织控制台。

  Run: `npm test -w apps/admin`

  Expected: PASS。

  Run: `npm run build`

  Expected: PASS。

  ```bash
  git add apps/admin/src
  git commit -m "feat: separate registration and organization review UI"
  ```

### Task 4: 实现学校搜索、组织自动匹配和报名服务端规则

**Files:**
- Create: `apps/api/src/routes/registrations.js`
- Create: `apps/api/src/services/registrations.js`
- Create: `apps/api/test/registration-management.test.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/data/postgres-store.js`
- Modify: `apps/api/test/certificates.test.js`

**Interfaces:**
- Produces: `GET /api/schools?q=`、`GET /api/me/registration-context`。
- Produces: `POST /api/registrations` 从 session 推导 userId、从实际年级推导 group。
- Produces: `GET /api/admin/registrations` 支持分页、筛选、搜索和刷新时间。
- Consumes: 阶段一的 `groupForGrade()`、`isRegistrationOpen()` 与 event/project 数据。

- [ ] **Step 1: 写报名上下文和校验失败测试**

  覆盖：一个 active 组织自动选中；多个 active 组织返回候选；学校搜索合并已审核组织和历史学校并去重；客户端伪造 group 被忽略；当前赛事关闭时普通用户创建报名返回 `409`；项目不允许该组别返回 `422`。

  ```js
  const created = await json(await fetch(`${baseUrl}/api/registrations`, withSession(user.cookie, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      organizationId: "O1001",
      athlete: { name: "陈宇航", school: "温州市实验小学", grade: "五年级", phone: "13800000001" },
      group: "中学组",
      projectId: "paper-plane-gate",
      instructor: "林老师"
    })
  })));
  assert.equal(created.row.group, "小学高段");
  ```

  Run: `npm test -w apps/api -- --test-name-pattern="registration context|school search|derives group"`

  Expected: FAIL。

- [ ] **Step 2: 实现报名上下文和学校搜索**

  `GET /api/me/registration-context` 返回：

  ```js
  {
    organizations: activeMembershipOrganizations,
    defaultOrganizationId: activeMembershipOrganizations.length === 1 ? activeMembershipOrganizations[0].id : "",
    event,
    projects,
    grades: GRADE_GROUPS
  }
  ```

  学校搜索只返回 `reviewStatus === 'approved' && status === 'active'` 的组织名称和历史报名 `athlete.school`，大小写无关去重，最多 20 条。

- [ ] **Step 3: 实现安全的报名创建与修改**

  服务端创建流程固定为：读取当前赛事 → 检查报名窗口 → 校验组织 active membership → 调用 `groupForGrade()` → 校验项目属于当前赛事且允许该组别 → 执行原有个人赛/团体赛重复规则 → 写入报名。

  管理员修改报名可以绕过报名窗口，但不能写入不存在的赛事、组织、项目或无效年级。普通用户修改自己的报名仍受报名窗口限制。

- [ ] **Step 4: 实现管理员分页查询**

  查询参数：`eventId`、`status`、`group`、`projectId`、`organizationId`、`q`、`page`、`pageSize`。`pageSize` 限制 10–100，默认 25。返回：

  ```js
  { rows, total, page, pageSize, refreshedAt: new Date().toISOString() }
  ```

  搜索字段包含报名编号、姓名、学校、手机号、组织、赛项和指导老师。每行返回 `instructor`、`eventId`、实际年级与结果字段。

- [ ] **Step 5: 运行测试并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="registration|school"`

  Expected: PASS。

  ```bash
  git add apps/api/src/routes/registrations.js apps/api/src/services/registrations.js apps/api/src/server.js apps/api/src/data/postgres-store.js apps/api/test
  git commit -m "feat: enforce registration context and filters"
  ```

### Task 5: 交付报名页面、管理员报名管理和完整 Excel 导出

**Files:**
- Create: `apps/api/src/exports/registration-workbook.js`
- Create: `apps/api/test/registration-export.test.js`
- Create: `apps/admin/src/components/SchoolCombobox.vue`
- Create: `apps/admin/src/pages/RegistrationPage.vue`
- Create: `apps/admin/src/pages/RegistrationManagementPage.vue`
- Create: `apps/admin/src/pages/__tests__/RegistrationManagementPage.test.js`
- Modify: `apps/api/src/routes/registrations.js`
- Modify: `apps/api/package.json`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/styles.css`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `GET /api/admin/registrations/export.xlsx`，`scope=filtered|all`。
- Produces: `GET /api/admin/events/:eventId/certificate-template.xlsx` 的基础模板列；阶段三继续加入图片导入。
- Produces: `SchoolCombobox` emits `update:modelValue`。
- Consumes: Task 4 的报名上下文和分页列表。

- [ ] **Step 1: 安装 ExcelJS 并写导出失败测试**

  Run: `npm install -w apps/api exceljs`

  测试下载 workbook，使用 ExcelJS 重新读取并断言表头、指导老师和筛选范围：

  ```js
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const sheet = workbook.getWorksheet("报名名单");
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    "报名编号", "报名来源", "组织", "姓名", "学校", "实际年级", "组别", "手机号", "赛项", "项目类型", "指导老师", "审核状态", "奖项/等级", "名次", "成绩/分数"
  ]);
  assert.equal(sheet.getRow(2).getCell(11).value, "林老师");
  ```

  Run: `npm test -w apps/api -- --test-name-pattern="registration workbook"`

  Expected: FAIL，当前只有 CSV。

- [ ] **Step 2: 实现可复用的报名 workbook builder**

  `buildRegistrationWorkbook(rows, { mode })` 创建 `报名名单` sheet；标题冻结、启用筛选、标识列按文本保存、日期按 `yyyy-mm-dd hh:mm` 显示、列宽限制在 12–28。`mode === 'certificate-template'` 时追加：

  ```js
  ["证书1名称", "证书1图片", "证书2名称", "证书2图片"]
  ```

  证书图片列宽 24、行高 90，并用浅黄色标记可编辑列。模板只传入 approved rows。

- [ ] **Step 3: 实现名单导出路由**

  `scope=filtered` 复用管理员当前筛选但忽略分页；`scope=all` 只使用 `eventId`，导出该赛事全部报名。响应：

  ```js
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  await workbook.xlsx.write(res);
  res.end();
  ```

  删除旧 CSV 入口和管理端 `exportCsv()`。

- [ ] **Step 4: 实现用户报名页**

  页面加载 registration context：一个组织时自动选择并预填学校；多个组织时显示选择器；组织变化时只预填学校，不锁定学校字段。`SchoolCombobox` 300 ms 防抖请求学校候选，允许保留自定义文本。年级选择后只显示自动组别，并过滤允许项目。

- [ ] **Step 5: 实现管理员报名管理页**

  页面包含赛事、状态、组别、赛项、组织和关键字筛选；“刷新”调用列表 API 并更新最后刷新时间。表格显示指导老师；行操作包含审核、驳回、编辑、成绩和证书入口；证书编号字段不再渲染。

  导出按钮分别打开：

  ```js
  window.location.assign(`/api/admin/registrations/export.xlsx?${filteredQuery}`);
  window.location.assign(`/api/admin/registrations/export.xlsx?eventId=${eventId}&scope=all`);
  window.location.assign(`/api/admin/events/${eventId}/certificate-template.xlsx`);
  ```

  下载必须保持 session；若浏览器对 `window.location` 测试不稳定，使用 `fetch` 获取 Blob 再创建临时下载链接。

- [ ] **Step 6: 运行测试、构建并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="registration workbook|registration"`

  Run: `npm test -w apps/admin`

  Run: `npm run build`

  Expected: 全部 PASS；管理端可看到指导老师、刷新时间和三个导出操作。

  ```bash
  git add apps/api apps/admin package-lock.json
  git commit -m "feat: complete registration management and export"
  ```

## 阶段二完成检查

Run: `npm test -w apps/api`

Run: `npm test -w apps/admin`

Run: `npm run build`

Expected: 两个注册表单互不影响；组织资质审核闭环可用；用户按年级自动分组并自动匹配组织；报名管理支持指导老师、刷新、筛选、分页和完整 Excel 导出。
