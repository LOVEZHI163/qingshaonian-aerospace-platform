# 赛事设置导航整合实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将管理员侧栏的“赛事管理”和“赛项与组别”合并为“赛事设置”，并在页面内用两个真实切换内容的标签完整保留原有功能。

**Architecture:** `AdminShell` 和 `App` 只保留一个 `events` 视图键。`EventManagementPage` 继续统一拥有赛事、赛项和报名历史数据，但用本地 `activeSection` 控制“赛事信息”和“赛项与组别”两个展示区域；两个区域共享 `selectedId`，不新增 API 或持久化状态。

**Tech Stack:** Vue 3 Composition API、Vitest、Vue Test Utils、Vite、Docker Compose、Nginx

## Global Constraints

- 原页面全部业务功能必须保留，本次不做功能删减。
- 不修改数据库结构、API 或现有赛事与赛项业务规则。
- 不引入 URL 路由或浏览器历史记录。
- 不改动普通用户和组织用户导航。
- 赛项已有报名时继续只允许停用，不允许物理删除。
- 切换标签时保留当前选中的赛事、已加载数据和表单状态。

---

## 文件结构

- `apps/admin/src/components/AdminShell.vue`：管理员侧栏入口定义。
- `apps/admin/src/App.vue`：管理员视图编排，只把 `events` 映射到赛事设置页面。
- `apps/admin/src/pages/EventManagementPage.vue`：赛事设置内部标签、共享赛事选择和全部既有功能。
- `apps/admin/src/styles/admin.css`：内部标签、赛项标签赛事选择栏和窄屏样式。
- `apps/admin/src/components/__tests__/AdminShell.test.js`：侧栏单入口行为。
- `apps/admin/src/pages/__tests__/AppNavigation.test.js`：管理员六模块导航。
- `apps/admin/src/__tests__/App.test.js`：单一赛事视图编排。
- `apps/admin/src/pages/__tests__/EventManagementPage.test.js`：内部标签、共享选择、无重复请求和既有功能回归。
- `docs/deployment/aliyun-test.md`：本次增量部署记录。

### Task 1: 合并管理员侧栏入口和视图键

**Files:**
- Modify: `apps/admin/src/components/__tests__/AdminShell.test.js`
- Modify: `apps/admin/src/pages/__tests__/AppNavigation.test.js`
- Modify: `apps/admin/src/__tests__/App.test.js`
- Modify: `apps/admin/src/components/AdminShell.vue`
- Modify: `apps/admin/src/App.vue`

**Interfaces:**
- Consumes: `AdminShell` 的 `active: string` 属性和 `navigate(key: string)` 事件。
- Produces: 唯一赛事设置键 `events`，侧栏文案“赛事设置”。

- [ ] **Step 1: 写侧栏和编排失败测试**

将 `AdminShell.test.js` 的预期导航改为六项，并断言不存在 `projects`：

```js
it("renders one event settings navigation entry and emits events", async () => {
  const wrapper = mount(AdminShell, { props: { active: "overview" } });

  expect(wrapper.findAll("[data-nav]").map((item) => item.text())).toEqual([
    "概览", "赛事设置", "组织用户", "报名管理", "证书管理", "普通用户管理"
  ]);
  expect(wrapper.find('[data-nav="projects"]').exists()).toBe(false);

  await wrapper.get('[data-nav="events"]').trigger("click");
  expect(wrapper.emitted("navigate")[0]).toEqual(["events"]);
});
```

将 `AppNavigation.test.js` 的管理员导航预期改为相同六项。将 `App.test.js` 的赛事测试改为只点击 `events`，并增加源码断言：

```js
expect(wrapper.find(".event-management").exists()).toBe(true);
expect(wrapper.find('[data-nav="projects"]').exists()).toBe(false);
expect(appSource).not.toContain("['events', 'projects']");
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```powershell
npm.cmd test -w apps/admin -- AdminShell.test.js AppNavigation.test.js App.test.js
```

Expected: FAIL；现有页面仍显示“赛事管理”“赛项与组别”七项，并且源码仍包含双视图映射。

- [ ] **Step 3: 最小化修改侧栏和 App 编排**

将 `AdminShell.vue` 的 `items` 改为：

```js
const items = [
  ["overview", "概览"],
  ["events", "赛事设置"],
  ["organizations", "组织用户"],
  ["registrations", "报名管理"],
  ["certificates", "证书管理"],
  ["users", "普通用户管理"]
];
```

将 `App.vue` 的赛事页面条件改为：

```vue
<EventManagementPage v-else-if="currentView === 'events'" @event-changed="loadEvent" />
```

- [ ] **Step 4: 运行定向测试并确认通过**

Run:

```powershell
npm.cmd test -w apps/admin -- AdminShell.test.js AppNavigation.test.js App.test.js
```

Expected: 三个测试文件全部 PASS。

- [ ] **Step 5: 提交单入口改动**

```powershell
git add apps/admin/src/components/AdminShell.vue apps/admin/src/App.vue apps/admin/src/components/__tests__/AdminShell.test.js apps/admin/src/pages/__tests__/AppNavigation.test.js apps/admin/src/__tests__/App.test.js
git commit -m "fix: unify event settings navigation"
```

### Task 2: 增加页面内部真实标签切换

**Files:**
- Modify: `apps/admin/src/pages/__tests__/EventManagementPage.test.js`
- Modify: `apps/admin/src/pages/EventManagementPage.vue`
- Modify: `apps/admin/src/styles/admin.css`

**Interfaces:**
- Consumes: 现有 `selectedId: Ref<string>`、`selectEvent(id: string)`、`selectedProjects` 和全部保存方法。
- Produces: `activeSection: Ref<"event" | "projects">`，以及 `data-section="event"|"projects"`、`data-section-panel="event"|"projects"` 测试接口。

- [ ] **Step 1: 写内部标签失败测试**

在 `EventManagementPage.test.js` 增加：

```js
it("switches real panels without reloading and keeps the selected event", async () => {
  mockLoads();
  const wrapper = mount(EventManagementPage);
  await flushPromises();
  const initialEventLoads = apiMock.mock.calls.filter(([path]) => path === "/api/admin/events").length;

  expect(wrapper.get('[data-section="event"]').classes()).toContain("active");
  expect(wrapper.find('[data-section-panel="event"]').exists()).toBe(true);
  expect(wrapper.find('[data-section-panel="projects"]').exists()).toBe(false);
  await wrapper.get("form.event-form").findAll("input")[1].setValue("未保存主题");

  await wrapper.get('[data-section="projects"]').trigger("click");
  await flushPromises();

  expect(wrapper.find('[data-section-panel="event"]').exists()).toBe(false);
  expect(wrapper.get('[data-section-panel="projects"]').text()).toContain("纸飞机");
  expect(wrapper.get('[data-project-event]').element.value).toBe("E1");
  expect(apiMock.mock.calls.filter(([path]) => path === "/api/admin/events")).toHaveLength(initialEventLoads);
  await wrapper.get("form.project-form").findAll("input")[0].setValue("未保存赛项");

  await wrapper.get('[data-section="event"]').trigger("click");
  expect(wrapper.get(".event-list-item.selected").text()).toContain("2026赛事");
  expect(wrapper.get("form.event-form").findAll("input")[1].element.value).toBe("未保存主题");
  await wrapper.get('[data-section="projects"]').trigger("click");
  expect(wrapper.get("form.project-form").findAll("input")[0].element.value).toBe("未保存赛项");
});
```

增加空赛事测试：

```js
it("shows a project empty state when no event exists", async () => {
  apiMock.mockImplementation(async (path) => {
    if (path === "/api/admin/events") return { rows: [], projects: [] };
    if (path === "/api/admin/registrations?pageSize=100") return { rows: [], total: 0, page: 1, pageSize: 100 };
    return { rows: [] };
  });
  const wrapper = mount(EventManagementPage);
  await flushPromises();

  await wrapper.get('[data-section="projects"]').trigger("click");
  expect(wrapper.text()).toContain("请先创建或选择赛事");
});
```

增加赛项标签切换赛事测试：

```js
it("changes the shared event selection from the projects section", async () => {
  const secondEvent = { ...event, id: "E2", name: "2027赛事", isCurrent: false };
  const secondProject = { ...project, id: "P2", eventId: "E2", name: "无人机竞速" };
  apiMock.mockImplementation(async (path) => {
    if (path === "/api/admin/events") return { rows: [event, secondEvent], projects: [project, secondProject] };
    if (path === "/api/admin/registrations?pageSize=100") return { rows: [], total: 0, page: 1, pageSize: 100 };
    return { rows: [] };
  });
  const wrapper = mount(EventManagementPage);
  await flushPromises();

  await wrapper.get('[data-section="projects"]').trigger("click");
  await wrapper.get('[data-project-event]').setValue("E2");

  expect(wrapper.get('[data-section-panel="projects"]').text()).toContain("无人机竞速");
  await wrapper.get('[data-section="event"]').trigger("click");
  expect(wrapper.get(".event-list-item.selected").text()).toContain("2027赛事");
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```powershell
npm.cmd test -w apps/admin -- EventManagementPage.test.js
```

Expected: FAIL；找不到 `data-section="event"` 和 `data-section="projects"`。

- [ ] **Step 3: 添加标签状态和模板分区**

在页面脚本中添加：

```js
const activeSection = ref("event");
```

在标题下添加：

```vue
<div class="event-section-tabs" role="tablist" aria-label="赛事设置分类">
  <button type="button" role="tab" data-section="event" :class="{ active: activeSection === 'event' }" :aria-selected="activeSection === 'event'" @click="activeSection = 'event'">赛事信息</button>
  <button type="button" role="tab" data-section="projects" :class="{ active: activeSection === 'projects' }" :aria-selected="activeSection === 'projects'" @click="activeSection = 'projects'">赛项与组别</button>
</div>
```

用 `v-if="activeSection === 'event'" data-section-panel="event"` 包裹现有赛事列表、赛事表单和资源清理区域。用以下独立区域承载原赛项面板：

```vue
<div v-else data-section-panel="projects" class="event-projects-section">
  <div v-if="events.length" class="panel project-event-picker">
    <label>管理赛事
      <select data-project-event :value="selectedId" @change="selectEvent($event.target.value)">
        <option v-for="row in events" :key="row.id" :value="row.id">{{ row.name }}{{ row.isCurrent ? "（当前）" : "" }}</option>
      </select>
    </label>
  </div>
  <p v-if="!selectedId" class="panel empty-state">请先创建或选择赛事。</p>
  <section v-else class="panel project-panel">
    <div class="panel-title"><h3>赛项与组别</h3><span>{{ selectedProjects.length }} 个赛项</span></div>
    <div class="project-list">
      <article v-for="row in selectedProjects" :key="row.id">
        <div><strong>{{ row.name }}</strong><span>{{ row.category }} · {{ row.type === 'team' ? '团体赛' : '个人赛' }}</span><small>{{ row.allowedGroups.join('、') }}</small></div>
        <div class="project-actions">
          <button type="button" class="mini" @click="editProject(row)">编辑</button>
          <button v-if="registrationCount(row.id)" type="button" class="mini reject" data-action="disable-project" :disabled="!row.enabled || saving" @click="disableProject(row)">停用</button>
          <button v-else type="button" class="mini reject" data-action="delete-project" :disabled="saving" @click="deleteProject(row)">删除</button>
        </div>
      </article>
      <p v-if="selectedProjects.length === 0">暂无赛项。</p>
    </div>
    <form class="project-form" @submit.prevent="saveProject">
      <h4>{{ projectForm.id ? "编辑赛项" : "新增赛项" }}</h4>
      <div class="two"><label>赛项名称<input v-model="projectForm.name" /></label><label>类别<input v-model="projectForm.category" /></label></div>
      <div class="two">
        <label>类型<select v-model="projectForm.type"><option value="individual">个人赛</option><option value="team">团体赛</option></select></label>
        <label>显示顺序<input v-model.number="projectForm.displayOrder" type="number" min="0" /></label>
      </div>
      <div class="checkbox-row">
        <label v-for="group in GROUPS" :key="group"><input v-model="projectForm.allowedGroups" type="checkbox" :value="group" />{{ group }}</label>
      </div>
      <div class="checkbox-row"><label><input v-model="projectForm.enabled" type="checkbox" />启用</label><label><input v-model="projectForm.instructorRequired" type="checkbox" />必须填写指导老师</label></div>
      <div class="form-actions"><button class="primary" :disabled="saving">{{ projectForm.id ? "保存赛项" : "新增赛项" }}</button><button v-if="projectForm.id" type="button" @click="Object.assign(projectForm, emptyProject())">取消编辑</button></div>
    </form>
  </section>
</div>
```

资源清理面板必须留在“赛事信息”区域。赛项面板的原字段与事件绑定必须逐项保留。

- [ ] **Step 4: 添加最小标签样式**

在 `admin.css` 增加：

```css
.event-section-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
.event-section-tabs button { border: 1px solid #cbd5e1; background: #fff; color: #334155; border-radius: 8px; padding: 9px 16px; font-weight: 700; }
.event-section-tabs button.active { border-color: #1677ff; background: #eaf3ff; color: #0b63ce; }
.event-projects-section { display: grid; gap: 14px; }
.project-event-picker label { display: grid; gap: 6px; max-width: 520px; }
```

- [ ] **Step 5: 运行定向测试并确认通过**

Run:

```powershell
npm.cmd test -w apps/admin -- EventManagementPage.test.js App.test.js AppNavigation.test.js AdminShell.test.js
```

Expected: 相关测试文件全部 PASS；既有报名开放、复制、归档、赛项历史保护和资源清理测试仍通过。

- [ ] **Step 6: 提交内部标签改动**

```powershell
git add apps/admin/src/pages/EventManagementPage.vue apps/admin/src/styles/admin.css apps/admin/src/pages/__tests__/EventManagementPage.test.js
git commit -m "feat: add event settings sections"
```

### Task 3: 全量回归、增量部署和真实页面验收

**Files:**
- Modify: `docs/deployment/aliyun-test.md`

**Interfaces:**
- Consumes: 本分支已通过的 API 180 项、管理端测试和阿里云 `/opt/aerogp` Docker Compose 环境。
- Produces: 线上单入口赛事设置页面和部署记录。

- [ ] **Step 1: 运行管理端全量测试和生产构建**

```powershell
npm.cmd test -w apps/admin
npm.cmd run build
git diff --check
```

Expected: 管理端全部测试 PASS；Web 和 Admin 两个 Vite 构建成功；`git diff --check` 无输出。

- [ ] **Step 2: 运行升级前备份和预检**

```powershell
ssh aerogp 'cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-postgres.sh once'
ssh aerogp 'cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-uploads.sh once'
ssh aerogp 'cd /opt/aerogp && /bin/sh deploy/preflight-admin-upgrade.sh'
```

Expected: 两份备份成功，预检输出 `Upgrade preflight passed.`。

- [ ] **Step 3: 上传四个前端文件并只重建 Web 服务**

```powershell
ssh aerogp 'install -d -m 700 /tmp/aerogp-event-settings/apps/admin/src/components /tmp/aerogp-event-settings/apps/admin/src/pages /tmp/aerogp-event-settings/apps/admin/src/styles'
scp apps/admin/src/App.vue aerogp:/tmp/aerogp-event-settings/apps/admin/src/App.vue
scp apps/admin/src/components/AdminShell.vue aerogp:/tmp/aerogp-event-settings/apps/admin/src/components/AdminShell.vue
scp apps/admin/src/pages/EventManagementPage.vue aerogp:/tmp/aerogp-event-settings/apps/admin/src/pages/EventManagementPage.vue
scp apps/admin/src/styles/admin.css aerogp:/tmp/aerogp-event-settings/apps/admin/src/styles/admin.css
ssh aerogp 'cd /opt/aerogp && install -m 644 /tmp/aerogp-event-settings/apps/admin/src/App.vue apps/admin/src/App.vue && install -m 644 /tmp/aerogp-event-settings/apps/admin/src/components/AdminShell.vue apps/admin/src/components/AdminShell.vue && install -m 644 /tmp/aerogp-event-settings/apps/admin/src/pages/EventManagementPage.vue apps/admin/src/pages/EventManagementPage.vue && install -m 644 /tmp/aerogp-event-settings/apps/admin/src/styles/admin.css apps/admin/src/styles/admin.css && docker compose build web && docker compose up -d --no-deps web'
```

Expected: `aerogp-web-1` 被重建并进入 healthy；PostgreSQL 和 API 不被重建。

- [ ] **Step 4: 只读服务器健康检查**

```powershell
ssh aerogp 'cd /opt/aerogp && docker compose ps && curl -fsS -o /dev/null -w "%{http_code}" http://127.0.0.1/admin/ && ss -lnt'
```

Expected: 四个服务 healthy，管理端 HTTP 200，公网监听仍只有 22 和 80。

- [ ] **Step 5: 使用真实浏览器验收**

在 `http://47.99.181.222/admin/` 验证：

1. 管理员侧栏只有“赛事设置”，没有第二个“赛项与组别”入口。
2. 进入后默认显示“赛事信息”。
3. 点击内部“赛项与组别”后首屏出现赛事选择和赛项列表。
4. 切回“赛事信息”后仍选中同一赛事。
5. 核对报名模式三个按钮、赛事操作、赛项字段、四组别、指导老师必填、停用/删除保护和资源清理入口仍存在。

Expected: 所有验收点通过，浏览器控制台和页面均无错误。

- [ ] **Step 6: 记录部署并提交**

先用以下只读命令取得已部署代码版本和最新备份文件名：

```powershell
git rev-parse --short HEAD
ssh aerogp 'cd /opt/aerogp && ls -1t backups/aerogp-*.dump | head -n 1 && ls -1t backups/uploads/aerogp-uploads-*.tar.gz | head -n 1'
```

在 `docs/deployment/aliyun-test.md` 的 `2026-07-18 测试环境部署记录` 下追加一个“赛事设置导航增量部署”小节，逐项记录上述命令的实际输出、管理端测试总数、生产构建和浏览器五项验收结果，然后执行：

```powershell
git add docs/deployment/aliyun-test.md
git commit -m "docs: record event settings deployment"
```

Expected: 工作区除忽略的 `.superpowers/` 外无未提交文件。
