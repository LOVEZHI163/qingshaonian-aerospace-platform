# Certificate Management Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将管理员证书管理重组为“证书列表 / 手动录入 / 批量导入”三个独立页签，并让手动录入按学生姓名只查询审核通过的报名。

**Architecture:** 保留现有证书列表和 Excel 导入组件，将手动成绩及双证书维护拆入独立的 `ManualCertificateEntryPanel`。页面级状态分为列表筛选、手动搜索和导入赛事三套；管理员报名接口新增向后兼容的 `athleteName` 参数，手动上传接口在服务端再次校验报名状态。

**Tech Stack:** Vue 3 Composition API、Vitest、Node.js `node:test`、Express、现有 JSON/PostgreSQL store 抽象、Docker Compose、Nginx。

## Global Constraints

- 页面固定使用三个内部页签：`证书列表`、`手动录入`、`批量导入`；默认显示证书列表。
- 手动姓名搜索必须同时携带 `eventId`、`status=approved`、`athleteName`，空姓名不发送请求。
- 同名和多赛项报名必须逐条显示姓名、学校、赛事、组别、赛项和报名编号，由管理员明确选择。
- 手动上传和 Excel 导入生成的证书保持 `draft`，发布仍由管理员确认后完成。
- 每条报名最多维护证书位置 1 和位置 2；继续支持 PDF、PNG、JPG/JPEG、WEBP。
- 保留成绩三个独立字段、证书上传/替换/改名/删除/预览/下载及批量发布/撤回功能。
- 不新增数据库表或迁移；现有管理员报名端点、参数和响应保持兼容。
- `.superpowers/` 是本地临时目录，不纳入任何提交。

## File Structure

- `apps/api/src/services/registrations.js`：实现只匹配选手姓名的 `athleteName` 查询条件。
- `apps/api/src/routes/certificates.js`：拒绝为非 `approved` 报名手动上传证书。
- `apps/api/test/registration-management.test.js`：覆盖姓名专用查询及与既有 `q` 的兼容性。
- `apps/api/test/certificate-management.test.js`：覆盖非通过报名上传被拒绝且不产生文件或证书记录。
- `apps/admin/src/components/ManualCertificateEntryPanel.vue`：封装姓名搜索、报名选择、成绩维护和双证书维护。
- `apps/admin/src/components/__tests__/ManualCertificateEntryPanel.test.js`：覆盖手动录入状态机和直达行为。
- `apps/admin/src/pages/CertificateManagementPage.vue`：只协调三个页签、证书列表、导入和列表刷新。
- `apps/admin/src/pages/__tests__/CertificateManagementPage.test.js`：覆盖三页签集成、状态隔离和既有功能入口。
- `apps/admin/src/pages/__tests__/CertificateManagementPage.final-fixes.test.js`：让原证书列表分页与竞态测试在“证书列表”页签下继续通过。
- `apps/admin/src/styles/admin.css`：增加证书页签和手动搜索结果布局，复用现有面板与响应式规则。
- `docs/deployment/aliyun-test.md`：记录备份、部署 commit、容器状态和线上验收证据。

---

### Task 1: Add precise athlete-name registration filtering

**Files:**
- Modify: `apps/api/src/services/registrations.js:220-232`
- Test: `apps/api/test/registration-management.test.js:92-114`

**Interfaces:**
- Consumes: `GET /api/admin/registrations` 现有 `eventId`、`status`、`q` 和分页参数。
- Produces: 可选查询参数 `athleteName: string`；存在时只对 `row.athlete.name` 做标准化包含匹配，响应仍为 `{ rows, total, page, pageSize, refreshedAt }`。

- [ ] **Step 1: Write the failing API test**

在 `registration-management.test.js` 的管理员列表测试后增加独立用例，使用一个姓名同时出现在学校或指导老师字段中的夹具，断言专用参数不会误匹配：

```js
test("admin registration listing filters athleteName only against the athlete name", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const response = await fetch(
      `${baseUrl}/api/admin/registrations?eventId=wz-aerospace-2026&status=approved&athleteName=${encodeURIComponent("周星言")}&pageSize=10`,
      withSession(admin.cookie)
    );
    assert.equal(response.status, 200);
    const payload = await json(response);
    assert.equal(payload.rows.every((row) => row.status === "approved"), true);
    assert.equal(payload.rows.every((row) => row.athlete.name.includes("周星言")), true);

    const noFalsePositive = await fetch(
      `${baseUrl}/api/admin/registrations?athleteName=${encodeURIComponent("王老师")}&pageSize=10`,
      withSession(admin.cookie)
    );
    assert.equal((await json(noFalsePositive)).total, 0);
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
npm test -w apps/api -- --test-name-pattern="athleteName only"
```

Expected: FAIL，因为服务端尚未处理 `athleteName`，第二个请求仍返回指导老师匹配或首个请求未被姓名限制。

- [ ] **Step 3: Implement the dedicated filter**

在 `filterAdminRegistrations` 中保留 `q` 的原行为，并在它之前增加姓名专用条件：

```js
export function filterAdminRegistrations(db, query = {}) {
  const q = normalizeText(query.q);
  const athleteName = normalizeText(query.athleteName);
  const rows = db.registrations.filter((row) => {
    if (query.eventId && row.eventId !== query.eventId) return false;
    if (query.status && row.status !== query.status) return false;
    if (query.group && row.group !== query.group) return false;
    if (query.projectId && row.projectId !== query.projectId) return false;
    if (query.organizationId && row.organizationId !== query.organizationId) return false;
    if (athleteName && !normalizeText(row.athlete?.name).includes(athleteName)) return false;
    if (!q) return true;
    return [row.id, row.athlete?.name, row.athlete?.school, row.athlete?.phone, row.organization, row.projectName, row.instructor]
      .some((value) => normalizeText(value).includes(q));
  });
  return rows.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || right.id.localeCompare(left.id));
}
```

- [ ] **Step 4: Run focused and registration regression tests**

Run:

```powershell
npm test -w apps/api -- --test-name-pattern="admin registration listing|athleteName only"
```

Expected: PASS；原 `q` 查询和新 `athleteName` 查询都返回正确分页元数据。

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/services/registrations.js apps/api/test/registration-management.test.js
git commit -m "feat: add athlete name registration filter"
```

---

### Task 2: Enforce approved registration status on manual uploads

**Files:**
- Modify: `apps/api/src/routes/certificates.js:266-302`
- Test: `apps/api/test/certificate-management.test.js:163-282`

**Interfaces:**
- Consumes: `POST /api/admin/registrations/:id/certificates/:slot` 和内存中的 `registration.status`。
- Produces: 非 `approved` 报名返回 HTTP `409` 与 `{ error: "报名审核通过后才能录入证书" }`，且不调用 `storage.saveFile`、不新增证书记录。

- [ ] **Step 1: Write the failing upload-guard test**

在手动证书 CRUD 用例之后增加：

```js
test("manual certificate upload rejects a registration that is not approved", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const registration = db.registrations.find((row) => row.id === "R20260627001");
    registration.status = "pending";
    await fs.writeFile(dbPath, JSON.stringify(db, null, 2));

    const response = await uploadCertificate(baseUrl, admin.cookie, registration.id, 1, { title: "不应保存" });
    assert.equal(response.status, 409);
    assert.equal((await responseJson(response)).error, "报名审核通过后才能录入证书");

    const persisted = JSON.parse(await fs.readFile(dbPath, "utf8"));
    assert.equal(persisted.certificates.some((row) => row.registrationId === registration.id), false);
  }, { prefix: "manual-certificate-approved-only-" });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
npm test -w apps/api -- --test-name-pattern="not approved"
```

Expected: FAIL，当前接口仍返回 `201` 并写入证书。

- [ ] **Step 3: Add the route guard before storage writes**

在确认报名存在后、检查文件并调用 `storage.saveFile` 之前加入：

```js
if (registration.status !== "approved") {
  throw new CertificateError(409, "报名审核通过后才能录入证书");
}
```

- [ ] **Step 4: Run certificate API tests**

Run:

```powershell
npm test -w apps/api -- --test-name-pattern="manual certificate"
```

Expected: PASS，已通过报名的两个位置 CRUD 不受影响，非通过报名被拒绝。

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/routes/certificates.js apps/api/test/certificate-management.test.js
git commit -m "fix: restrict manual certificates to approved entries"
```

---

### Task 3: Build the searchable manual-entry panel

**Files:**
- Create: `apps/admin/src/components/ManualCertificateEntryPanel.vue`
- Create: `apps/admin/src/components/__tests__/ManualCertificateEntryPanel.test.js`

**Interfaces:**
- Consumes props: `events: Event[]`, `initialEventId: string`, `initialRegistrationId: string`。
- Emits: `changed({ message: string })`，通知父页面刷新证书列表但不重置列表筛选。
- Uses: `loadAdminRegistrations({ eventId, status: "approved", athleteName })`、`CertificateSlotEditor`、按选中报名编号构造的 `GET /api/admin/certificates?registrationId=<报名编号>&page=1&pageSize=2`、`POST /api/admin/registrations/:id/result`。
- Produces UI selectors: `[data-manual-event]`、`[data-manual-name]`、`[data-action="search-student"]`、`[data-manual-result]`、`[data-manual-selected]`。

- [ ] **Step 1: Write failing component tests for search and selection**

创建测试并 mock `api` 与 `loadAdminRegistrations`，加入以下两个搜索与选择用例：

```js
it("does not search an empty name and only requests approved athlete-name matches", async () => {
  const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
  await wrapper.get('[data-action="search-student"]').trigger("click");
  expect(loadAdminRegistrationsMock).not.toHaveBeenCalled();
  expect(wrapper.get('[role="alert"]').text()).toContain("请输入学生姓名");

  await wrapper.get('[data-manual-name]').setValue("张三");
  await wrapper.get('[data-action="search-student"]').trigger("click");
  await flushPromises();
  expect(loadAdminRegistrationsMock).toHaveBeenCalledWith({
    eventId: "E1",
    status: "approved",
    athleteName: "张三"
  });
});

it("shows same-name project rows and loads the selected registration certificates", async () => {
  loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne, sameNameProjectTwo]);
  const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
  await wrapper.get('[data-manual-name]').setValue("张三");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  const rows = wrapper.findAll("[data-manual-result]");
  expect(rows).toHaveLength(2);
  expect(rows[0].text()).toContain("实验小学");
  expect(rows[0].text()).toContain("小学低段");
  expect(rows[0].text()).toContain("纸飞机");
  expect(rows[0].text()).toContain("R1");
  await rows[1].trigger("click");
  await flushPromises();
  expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("registrationId=R2"));
});
```

加入以下边界与编辑测试；测试夹具沿用上面的 `events`、`sameNameProjectOne` 和 `sameNameProjectTwo`：

```js
it("clears old results when the event changes", async () => {
  loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne]);
  const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
  await wrapper.get('[data-manual-name]').setValue("张三");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.findAll("[data-manual-result]")).toHaveLength(1);
  await wrapper.get('[data-manual-event]').setValue("E2");
  expect(wrapper.findAll("[data-manual-result]")).toHaveLength(0);
  expect(wrapper.get('[data-manual-name]').element.value).toBe("");
});

it("ignores an older search response", async () => {
  const older = deferred();
  loadAdminRegistrationsMock.mockReturnValueOnce(older.promise).mockResolvedValueOnce([sameNameProjectTwo]);
  const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
  await wrapper.get('[data-manual-name]').setValue("张");
  await wrapper.get("form").trigger("submit");
  await wrapper.get('[data-manual-name]').setValue("张三");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  older.resolve([sameNameProjectOne]);
  await flushPromises();
  expect(wrapper.findAll("[data-manual-result]")).toHaveLength(1);
  expect(wrapper.get("[data-manual-result]").text()).toContain("R2");
});

it("shows the approved-registration empty state", async () => {
  loadAdminRegistrationsMock.mockResolvedValue([]);
  const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
  await wrapper.get('[data-manual-name]').setValue("不存在的学生");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.text()).toContain("未找到已通过的报名记录");
});

it("saves three independent result fields and passes both certificate slots to the editor", async () => {
  loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne]);
  apiMock.mockResolvedValueOnce({ rows: [certificateOne, certificateTwo] }).mockResolvedValueOnce({ row: sameNameProjectOne });
  const wrapper = mount(ManualCertificateEntryPanel, { props: { events, initialEventId: "E1" } });
  await wrapper.get('[data-manual-name]').setValue("张三");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  await wrapper.get("[data-manual-result]").trigger("click");
  await flushPromises();
  expect(wrapper.getComponent(CertificateSlotEditor).props("certificates")).toEqual([certificateOne, certificateTwo]);
  await wrapper.get('[data-result="awardName"]').setValue("一等奖");
  await wrapper.get('[data-result="rank"]').setValue("1");
  await wrapper.get('[data-result="score"]').setValue("99");
  await wrapper.get('[data-action="save-result"]').trigger("click");
  expect(apiMock).toHaveBeenCalledWith("/api/admin/registrations/R1/result", {
    method: "POST",
    body: JSON.stringify({ awardName: "一等奖", rank: "1", score: "99" })
  });
});
```

补充两个直达测试：

```js
it("opens an approved direct registration by exact id", async () => {
  loadAdminRegistrationsMock.mockResolvedValue([sameNameProjectOne]);
  const wrapper = mount(ManualCertificateEntryPanel, {
    props: { events, initialEventId: "E1", initialRegistrationId: "R1" }
  });
  await flushPromises();
  expect(loadAdminRegistrationsMock).toHaveBeenCalledWith({ eventId: "E1", q: "R1" });
  expect(wrapper.get("[data-manual-selected]").text()).toContain("R1");
});

it("blocks a direct registration that is not approved", async () => {
  loadAdminRegistrationsMock.mockResolvedValue([{ ...sameNameProjectOne, status: "pending" }]);
  const wrapper = mount(ManualCertificateEntryPanel, {
    props: { events, initialEventId: "E1", initialRegistrationId: "R1" }
  });
  await flushPromises();
  expect(wrapper.text()).toContain("报名审核通过后才能录入证书");
  expect(wrapper.findComponent(CertificateSlotEditor).exists()).toBe(false);
});
```

- [ ] **Step 2: Run the new component test and verify failure**

Run:

```powershell
npm test -w apps/admin -- ManualCertificateEntryPanel.test.js
```

Expected: FAIL，因为组件文件尚不存在。

- [ ] **Step 3: Implement the search state machine**

组件脚本使用互相独立的状态和请求代次：

```js
const props = defineProps({
  events: { type: Array, default: () => [] },
  initialEventId: { type: String, default: "" },
  initialRegistrationId: { type: String, default: "" }
});
const emit = defineEmits(["changed"]);
const eventId = ref("");
const athleteName = ref("");
const searchRows = ref([]);
const selectedRegistrationId = ref("");
const selectedCertificates = ref([]);
const searchLoading = ref(false);
const certificateLoading = ref(false);
const error = ref("");
const result = reactive({ awardName: "", rank: "", score: "" });
let searchGeneration = 0;
let certificateGeneration = 0;

async function searchByName() {
  const name = athleteName.value.trim();
  if (!name) {
    error.value = "请输入学生姓名后再查询。";
    return;
  }
  const generation = ++searchGeneration;
  searchLoading.value = true;
  error.value = "";
  try {
    const rows = await loadAdminRegistrations({ eventId: eventId.value, status: "approved", athleteName: name });
    if (generation !== searchGeneration) return;
    searchRows.value = rows;
    selectedRegistrationId.value = "";
    selectedCertificates.value = [];
  } catch (cause) {
    if (generation === searchGeneration) error.value = cause.message || "学生报名查询失败，请稍后重试。";
  } finally {
    if (generation === searchGeneration) searchLoading.value = false;
  }
}
```

事件切换时递增 `searchGeneration` 与 `certificateGeneration`，并清空搜索、选择和旧错误。模板用 `<form @submit.prevent="searchByName">` 支持回车，空结果显示“未找到已通过的报名记录”。

- [ ] **Step 4: Implement selection, direct-link and existing editors**

点击结果后设置选中报名、同步成绩，并请求该报名最多两个证书：

```js
async function selectRegistration(row) {
  selectedRegistrationId.value = row.id;
  Object.assign(result, {
    awardName: row.awardName || "",
    rank: row.rank || "",
    score: row.score || ""
  });
  const generation = ++certificateGeneration;
  certificateLoading.value = true;
  try {
    const params = new URLSearchParams({ registrationId: row.id, sort: "uploadedAt", direction: "desc", page: "1", pageSize: "2" });
    const payload = await api(`/api/admin/certificates?${params}`);
    if (generation === certificateGeneration && selectedRegistrationId.value === row.id) {
      selectedCertificates.value = payload.rows || [];
    }
  } finally {
    if (generation === certificateGeneration) certificateLoading.value = false;
  }
}
```

直达模式使用 `{ eventId, q: initialRegistrationId }` 查询后按 `row.id === initialRegistrationId` 精确选择；状态不是 `approved` 时显示“报名审核通过后才能录入证书”。选中区继续渲染三个成绩输入和：

```vue
<CertificateSlotEditor
  :key="selectedRegistration.id"
  :registration="selectedRegistration"
  :certificates="selectedCertificates"
  @changed="afterCertificateChanged"
/>
```

`afterCertificateChanged` 先重新加载当前报名证书，再向父组件发出 `changed`。

- [ ] **Step 5: Run manual-entry component tests**

Run:

```powershell
npm test -w apps/admin -- ManualCertificateEntryPanel.test.js CertificateSlotEditor.final-fixes.test.js
```

Expected: PASS；搜索、竞态、直达、成绩和双证书功能全部通过。

- [ ] **Step 6: Commit**

```powershell
git add apps/admin/src/components/ManualCertificateEntryPanel.vue apps/admin/src/components/__tests__/ManualCertificateEntryPanel.test.js
git commit -m "feat: add searchable manual certificate entry"
```

---

### Task 4: Integrate the three independent certificate sections

**Files:**
- Modify: `apps/admin/src/pages/CertificateManagementPage.vue`
- Modify: `apps/admin/src/pages/__tests__/CertificateManagementPage.test.js`
- Modify: `apps/admin/src/pages/__tests__/CertificateManagementPage.final-fixes.test.js`
- Modify: `apps/admin/src/styles/admin.css:976-1085`

**Interfaces:**
- Consumes: `ManualCertificateEntryPanel`、`CertificateImportPanel`、现有证书列表 API。
- Produces: `activeSection: "list" | "manual" | "import"`；三套独立状态 `listFilters`、手动组件内部状态、`importEventId`。

- [ ] **Step 1: Write failing page integration tests**

在页面测试开头增加页签帮助函数，并写以下断言：

```js
async function openCertificateSection(wrapper, section) {
  await wrapper.get(`[data-certificate-section="${section}"]`).trigger("click");
  await flushPromises();
}

it("shows three real sections and defaults to the certificate list", async () => {
  const wrapper = mount(CertificateManagementPage);
  await flushPromises();
  expect(wrapper.findAll('[role="tab"]')).toHaveLength(3);
  expect(wrapper.get('[data-certificate-section="list"]').attributes("aria-selected")).toBe("true");
  expect(wrapper.get('[data-section-panel="list"]').isVisible()).toBe(true);
  expect(wrapper.get('[data-section-panel="manual"]').isVisible()).toBe(false);
  expect(wrapper.get('[data-section-panel="import"]').isVisible()).toBe(false);
});

it("keeps list filters, manual search, and import event independent", async () => {
  const wrapper = mount(CertificateManagementPage);
  await flushPromises();
  await wrapper.get('[data-list-query]').setValue("张三");
  await openCertificateSection(wrapper, "import");
  await wrapper.get('[data-import-event]').setValue("E2");
  await openCertificateSection(wrapper, "list");
  expect(wrapper.get('[data-list-query]').element.value).toBe("张三");
  expect(wrapper.get('[data-list-event]').element.value).toBe("E1");
});
```

将所有原手动详情测试先调用 `openCertificateSection(wrapper, "manual")`；列表分页测试保持默认页签。增加 `initialRegistrationId` 时默认打开手动录入的断言。

- [ ] **Step 2: Run the page tests and verify failure**

Run:

```powershell
npm test -w apps/admin -- CertificateManagementPage.test.js CertificateManagementPage.final-fixes.test.js
```

Expected: FAIL，因为页面尚未提供三个页签和独立状态。

- [ ] **Step 3: Remove all-registration preload from the page**

删除页面级 `registrations`、`filteredRegistrations`、`selectedRegistrationId`、成绩编辑和 `loadRegistrations` 逻辑。将列表状态改名并只请求证书页：

```js
const activeSection = ref(props.initialRegistrationId ? "manual" : "list");
const listFilters = reactive({ eventId: "", status: "", group: "", projectId: "", q: "" });
const importEventId = ref("");

function registrationFor(certificate) {
  return certificate.registration || {};
}

async function loadCertificateList({ propagate = false } = {}) {
  const generation = ++pageGeneration;
  loading.value = true;
  error.value = "";
  try {
    const payload = await api(certificateListPath());
    if (generation !== pageGeneration) return false;
    applyCertificatePage(payload);
    reconcileSelectedCertificates();
    return true;
  } catch (cause) {
    if (generation === pageGeneration) error.value = cause.message || "证书列表加载失败，请稍后重试。";
    if (propagate) throw cause;
    return false;
  } finally {
    if (generation === pageGeneration) loading.value = false;
  }
}
```

初次挂载只并行加载赛事元数据与证书列表；列表筛选变化只刷新列表。`afterImport` 和手动组件 `changed` 都调用 `loadCertificateList`，不修改 `listFilters`。

- [ ] **Step 4: Render the tablist and three preserved panels**

在标题下增加：

```vue
<nav class="certificate-section-tabs" role="tablist" aria-label="证书管理分类">
  <button type="button" role="tab" data-certificate-section="list" :class="{ active: activeSection === 'list' }" :aria-selected="activeSection === 'list'" @click="activeSection = 'list'">证书列表</button>
  <button type="button" role="tab" data-certificate-section="manual" :class="{ active: activeSection === 'manual' }" :aria-selected="activeSection === 'manual'" @click="activeSection = 'manual'">手动录入</button>
  <button type="button" role="tab" data-certificate-section="import" :class="{ active: activeSection === 'import' }" :aria-selected="activeSection === 'import'" @click="activeSection = 'import'">批量导入</button>
</nav>
```

三个内容块使用 `v-show` 而不是 `v-if`，保证切换时保留输入状态。先将当前证书列表 `<section class="panel certificate-list-panel">` 的开始标签替换为：

```vue
<section v-show="activeSection === 'list'" class="panel certificate-list-panel" data-section-panel="list">
```

在证书列表的结束标签之后依次加入手动录入组件和批量导入面板：

```vue
<ManualCertificateEntryPanel
  v-show="activeSection === 'manual'"
  data-section-panel="manual"
  :events="events"
  :initial-event-id="initialEventId"
  :initial-registration-id="initialRegistrationId"
  @changed="afterManualChange"
/>
<section v-show="activeSection === 'import'" class="certificate-import-section" data-section-panel="import">
  <label>导入赛事
    <select v-model="importEventId" data-import-event>
      <option v-for="event in events" :key="event.id" :value="event.id">{{ event.name }}</option>
    </select>
  </label>
  <CertificateImportPanel :event-id="importEventId" @committed="afterImport" />
</section>
```

- [ ] **Step 5: Add focused responsive styles**

在证书管理样式段增加：

```css
.certificate-section-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.certificate-section-tabs button { border: 1px solid #cbd5e1; background: #fff; color: #334155; border-radius: 8px; padding: 10px 18px; font-weight: 700; }
.certificate-section-tabs button.active { border-color: #1677ff; background: #eaf3ff; color: #0b63ce; }
.manual-certificate-search { display: grid; grid-template-columns: minmax(180px, 280px) minmax(220px, 1fr) auto; gap: 12px; align-items: end; }
.manual-registration-results { display: grid; gap: 8px; margin-top: 16px; }
.manual-registration-results button { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; text-align: left; }

@media (max-width: 760px) {
  .manual-certificate-search,
  .manual-registration-results button { grid-template-columns: 1fr; }
}
```

- [ ] **Step 6: Run all admin tests and production build**

Run:

```powershell
npm test -w apps/admin
npm run build -w apps/admin
```

Expected: 全部 Vitest 用例 PASS，Vite production build 成功；没有一次页面加载全赛事报名的请求。

- [ ] **Step 7: Commit**

```powershell
git add apps/admin/src/pages/CertificateManagementPage.vue apps/admin/src/pages/__tests__/CertificateManagementPage.test.js apps/admin/src/pages/__tests__/CertificateManagementPage.final-fixes.test.js apps/admin/src/styles/admin.css
git commit -m "feat: organize certificate management sections"
```

---

### Task 5: Full verification and Aliyun test deployment

**Files:**
- Modify: `docs/deployment/aliyun-test.md`

**Interfaces:**
- Consumes: 当前分支全部实现 commit、SSH 别名 `aerogp`、服务器目录 `/opt/aerogp`、现有备份脚本。
- Produces: `http://47.99.181.222/admin/` 上线后的三页签证书管理，以及可追溯的备份和部署记录。

- [ ] **Step 1: Run complete local verification**

Run:

```powershell
npm test -w apps/api
npm test -w apps/admin
npm run build -w apps/admin
powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1
git diff --check
git status --short
```

Expected: API 和管理端测试全部 PASS，管理端构建成功，部署配置检查退出码 0，`git diff --check` 无输出，状态中只有明确允许的 `.superpowers/` 未跟踪目录。

- [ ] **Step 2: Back up server data and run preflight**

Run:

```powershell
ssh aerogp 'cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-postgres.sh once'
ssh aerogp 'cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-uploads.sh once'
ssh aerogp 'cd /opt/aerogp && /bin/sh deploy/preflight-admin-upgrade.sh'
```

Expected: 数据库和上传备份均生成并验证成功，预检退出码 0；任一失败都停止部署。

- [ ] **Step 3: Upload only the implemented source changes**

从工作树根目录建立临时目录并上传以下文件：

```powershell
ssh aerogp 'install -d -m 700 /tmp/aerogp-certificate-sections/apps/api/src/services /tmp/aerogp-certificate-sections/apps/api/src/routes /tmp/aerogp-certificate-sections/apps/admin/src/components /tmp/aerogp-certificate-sections/apps/admin/src/pages /tmp/aerogp-certificate-sections/apps/admin/src/styles'
scp apps/api/src/services/registrations.js aerogp:/tmp/aerogp-certificate-sections/apps/api/src/services/registrations.js
scp apps/api/src/routes/certificates.js aerogp:/tmp/aerogp-certificate-sections/apps/api/src/routes/certificates.js
scp apps/admin/src/components/ManualCertificateEntryPanel.vue aerogp:/tmp/aerogp-certificate-sections/apps/admin/src/components/ManualCertificateEntryPanel.vue
scp apps/admin/src/pages/CertificateManagementPage.vue aerogp:/tmp/aerogp-certificate-sections/apps/admin/src/pages/CertificateManagementPage.vue
scp apps/admin/src/styles/admin.css aerogp:/tmp/aerogp-certificate-sections/apps/admin/src/styles/admin.css
```

Expected: 五个生产文件全部上传成功；测试文件和 `.superpowers/` 不进入服务器。

- [ ] **Step 4: Install changed files and rebuild API/web services**

Run:

```powershell
ssh aerogp 'cd /opt/aerogp && install -m 644 /tmp/aerogp-certificate-sections/apps/api/src/services/registrations.js apps/api/src/services/registrations.js && install -m 644 /tmp/aerogp-certificate-sections/apps/api/src/routes/certificates.js apps/api/src/routes/certificates.js && install -m 644 /tmp/aerogp-certificate-sections/apps/admin/src/components/ManualCertificateEntryPanel.vue apps/admin/src/components/ManualCertificateEntryPanel.vue && install -m 644 /tmp/aerogp-certificate-sections/apps/admin/src/pages/CertificateManagementPage.vue apps/admin/src/pages/CertificateManagementPage.vue && install -m 644 /tmp/aerogp-certificate-sections/apps/admin/src/styles/admin.css apps/admin/src/styles/admin.css && docker compose build api web && docker compose up -d --no-deps api web'
```

Expected: `api` 和 `web` 镜像构建成功并重新启动，不重建或清空 PostgreSQL 与上传卷。

- [ ] **Step 5: Verify health and business behavior**

Run:

```powershell
ssh aerogp 'cd /opt/aerogp && docker compose ps && docker compose logs --tail=120 api web && /bin/sh deploy/remote-smoke-test.sh'
curl.exe -sS -o NUL -w "%{http_code}" http://47.99.181.222/admin/
```

Expected: `postgres`、`api`、`web`、`backup` 均为 healthy，远端冒烟检查退出码 0，管理端返回 `200`。

在真实管理员页面验收：默认看到证书列表；三个页签切换正确；姓名查询只显示已通过报名；同名多赛项可区分；选中后成绩与两个证书位置可编辑；批量导入仍可下载模板和预检查；切回证书列表后筛选值保持不变。

- [ ] **Step 6: Record deployment evidence and commit**

在 `docs/deployment/aliyun-test.md` 的 `2026-07-18 测试环境部署记录` 下新增“证书管理三模块增量部署”，记录实现 commit、数据库/上传备份文件名、容器状态、测试数量、构建结果、HTTP 状态和上述页面验收结果，然后运行：

```powershell
git add docs/deployment/aliyun-test.md
git commit -m "docs: record certificate management deployment"
```

Expected: 部署记录提交成功，工作树只剩不纳入版本库的 `.superpowers/`。
