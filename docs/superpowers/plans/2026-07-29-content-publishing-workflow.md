# 官网内容发布流程优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将“官网内容 → 内容发布”重构为内容列表、独立编辑、发布检查三个清晰阶段，修复富文本光标丢失，并确保草稿赛事及其关联内容不会被误公开。

**Architecture:** 管理端由 `SiteContentPage.vue` 维护列表/编辑上下文，`ContentEditorPanel.vue` 负责草稿编辑，新增 `ContentPublicationReview.vue` 负责发布前检查。API 在内容发布、定时发布、赛事官网公开和公共内容读取四个入口共同执行赛事状态边界；富文本组件改为只在外部记录变化时同步 DOM，输入期间不重建 `contenteditable`。

**Tech Stack:** Vue 3、Vitest、Express、Node Test Runner、PostgreSQL/file store、React 公共站点、Docker Compose、Nginx、PowerShell、POSIX shell。

## Global Constraints

- 默认只展示内容列表；未点击“新建”或“编辑”时不得挂载空白编辑表单。
- 新建内容默认草稿；保存草稿、预览和发布必须是三个含义明确的动作。
- 已发布内容保持只读，必须先下线才能重新编辑。
- 关联草稿赛事的内容只能保存草稿和预览，不能发布或定时发布。
- 草稿赛事的“在官网公开此赛事”开关必须禁用，API 也必须拒绝伪造的公开请求。
- 平台通用内容不依赖任何赛事状态。
- 已发布但官网隐藏的赛事允许维护内容，但发布检查必须说明实际入口范围。
- 已归档且官网公开的赛事及内容进入历届赛事范围。
- 富文本输入期间不得重设当前编辑 DOM，不得降低既有 XSS、危险链接和私有媒体防护。
- 不新增数据库表，不执行破坏性迁移，不删除现有内容字段和媒体能力。
- 部署前必须验证数据库与上传文件备份；禁止执行 `docker compose down -v`。

---

## File Map

### API publication boundary

- `apps/api/src/services/site-admin.js`：内容创建、编辑、发布、下线与赛事官网配置的最终业务校验。
- `apps/api/src/services/public-site-view.js`：公共内容列表和详情的实际可见性判断。
- `apps/api/src/services/scheduled-content-publisher.js`：复用 `publishContent()` 处理到期定时内容，不建立第二套发布规则。
- `apps/api/test/site-admin.test.js`：管理员 API 的赛事状态、发布、定时发布和公开开关集成测试。
- `apps/api/test/public-site-service.test.js`：平台通用内容、草稿赛事内容、隐藏赛事内容和归档赛事内容的公共视图测试。
- `apps/api/test/scheduled-content-publishing.test.js`：遗留定时内容到期时仍受赛事状态边界保护。

### Admin workflow

- `apps/admin/src/pages/SiteContentPage.vue`：官网内容标签、内容列表/编辑上下文、顶部预览和跨页面导航。
- `apps/admin/src/components/ContentListPanel.vue`：筛选、空状态、分页、刷新、新建和选择内容。
- `apps/admin/src/components/ContentEditorPanel.vue`：内容草稿字段、保存、媒体、预览、发布确认和只读状态。
- `apps/admin/src/components/ContentPublicationReview.vue`：新增；发布前事实、阻断项、警告、预览与确认操作。
- `apps/admin/src/lib/content-publication-state.js`：新增；把内容、赛事和官网配置归一化成可测试的发布检查结果。
- `apps/admin/src/components/EventPublicProfilePanel.vue`：赛事业务状态与官网状态的联合说明。
- `apps/admin/src/components/RichTextEditor.vue`：富文本 DOM、选择区、输入法组合输入和外部记录同步。
- `apps/admin/src/App.vue`：接收官网内容页发出的“去赛事设置”导航。
- `apps/admin/src/styles/admin.css`：三阶段页面、状态提示、固定操作栏及 360–1440px 响应式布局。

### Admin tests

- `apps/admin/src/components/__tests__/RichTextEditor.test.js`
- `apps/admin/src/components/__tests__/ContentEditorPanel.test.js`
- `apps/admin/src/components/__tests__/ContentListPanel.test.js`：新增。
- `apps/admin/src/components/__tests__/ContentPublicationReview.test.js`：新增。
- `apps/admin/src/pages/__tests__/SiteContentPage.test.js`
- `apps/admin/src/pages/__tests__/AppNavigation.test.js`

---

### Task 1: 建立赛事感知的 API 发布与公共可见性边界

**Files:**
- Modify: `apps/api/src/services/site-admin.js:38-42,94-125,191-300`
- Modify: `apps/api/src/services/public-site-view.js:62-71,265-271`
- Modify: `apps/api/test/site-admin.test.js:144-215,275-430`
- Modify: `apps/api/test/public-site-service.test.js:34-81`
- Modify: `apps/api/test/scheduled-content-publishing.test.js:17-107`

**Interfaces:**
- Produces: private `assertContentEventPublishable(db, eventId)`; returns the linked event or `null`, throws `SiteAdminError` with code `CONTENT_EVENT_NOT_PUBLISHED`.
- Produces: private `assertContentReadyForPublication(db, post)`; returns sanitized HTML, throws `CONTENT_BODY_REQUIRED` when the body is empty.
- Produces: exported `isPublicContentPost(db, row, now): boolean`.
- Consumes: existing `assertEvent()`, `isPublicPost()`, `publishContent()` and event statuses `draft | published | archived`.

- [ ] **Step 1: Write failing admin API tests for draft-event publication**

  Append focused cases to `site-admin.test.js` using the existing `withTestServer()`, `loginAs()`, `mutateDb()` and `jsonRequest()` helpers:

  ```js
  test("draft events reject website visibility, content scheduling, and content publishing", async () => {
    await withTestServer(async ({ baseUrl, dbPath }) => {
      const admin = await loginAs(baseUrl, "13900000000", "admin123");
      await mutateDb(dbPath, (db) => {
        db.events.find((event) => event.id === EVENT_ID).status = "draft";
      });

      const profile = await jsonRequest(
        `${baseUrl}/api/admin/event-public-profiles/${EVENT_ID}`,
        admin.cookie,
        "PUT",
        { slug: "draft-event", isVisible: true, displayOrder: 0 }
      );
      assert.equal(profile.status, 422);
      assert.equal((await profile.json()).code, "EVENT_NOT_PUBLISHED");

      const created = await jsonRequest(
        `${baseUrl}/api/admin/content`,
        admin.cookie,
        "POST",
        contentInput({ slug: "draft-event-news" })
      );
      const row = (await created.json()).row;

      const scheduled = await jsonRequest(
        `${baseUrl}/api/admin/content/${row.id}`,
        admin.cookie,
        "PATCH",
        { version: row.version, status: "scheduled", publishAt: "2100-01-01T00:00:00.000Z" }
      );
      assert.equal(scheduled.status, 422);
      assert.equal((await scheduled.json()).code, "CONTENT_EVENT_NOT_PUBLISHED");

      const published = await jsonRequest(
        `${baseUrl}/api/admin/content/${row.id}/publish`,
        admin.cookie,
        "POST",
        { version: row.version }
      );
      assert.equal(published.status, 422);
      assert.equal((await published.json()).code, "CONTENT_EVENT_NOT_PUBLISHED");
    }, { prefix: "draft-event-publication-" });
  });
  ```

- [ ] **Step 2: Write failing admin API tests for empty published content**

  Use the same helpers and keep the seeded event in `published` state:

  ```js
  test("empty content body rejects scheduling and publishing", async () => {
    await withTestServer(async ({ baseUrl }) => {
      const admin = await loginAs(baseUrl, "13900000000", "admin123");

      const created = await jsonRequest(
        `${baseUrl}/api/admin/content`,
        admin.cookie,
        "POST",
        contentInput({ slug: "empty-body-news", bodyHtml: "" })
      );
      const row = (await created.json()).row;

      const scheduled = await jsonRequest(
        `${baseUrl}/api/admin/content/${row.id}`,
        admin.cookie,
        "PATCH",
        { version: row.version, status: "scheduled", publishAt: "2100-01-01T00:00:00.000Z" }
      );
      assert.equal(scheduled.status, 422);
      assert.equal((await scheduled.json()).code, "CONTENT_BODY_REQUIRED");

      const published = await jsonRequest(
        `${baseUrl}/api/admin/content/${row.id}/publish`,
        admin.cookie,
        "POST",
        { version: row.version }
      );
      assert.equal(published.status, 422);
      assert.equal((await published.json()).code, "CONTENT_BODY_REQUIRED");
    }, { prefix: "empty-content-publication-" });
  });
  ```

- [ ] **Step 3: Run the focused API tests and confirm they fail**

  Run:

  ```powershell
  npm.cmd test -w apps/api -- --test-name-pattern="draft events reject|empty content body rejects"
  ```

  Expected: FAIL because the requests currently succeed or return no stable error code.

- [ ] **Step 4: Add server-side publication guards**

  In `site-admin.js`, add the shared guards directly after `assertEvent()`:

  ```js
  function assertContentEventPublishable(db, eventId) {
    const event = assertEvent(db, eventId, { optional: true });
    if (event && !["published", "archived"].includes(event.status)) {
      fail(422, "关联赛事尚未发布，内容只能保存为草稿", "CONTENT_EVENT_NOT_PUBLISHED");
    }
    return event;
  }

  function contentPlainText(html) {
    return sanitizeContentHtml(html)
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function assertContentReadyForPublication(db, post) {
    assertContentEventPublishable(db, post.eventId);
    if (!contentPlainText(post.bodyHtml)) {
      fail(422, "正文不能为空", "CONTENT_BODY_REQUIRED");
    }
    return sanitizeContentHtml(post.bodyHtml);
  }
  ```

  Apply the guard in three places:

  ```js
  export function upsertEventPublicProfile(db, eventId, input, options = {}) {
    const event = assertEvent(db, eventId);
    // Keep the existing normalization and version code.
    if (next.isVisible && !["published", "archived"].includes(event.status)) {
      fail(422, "赛事尚未发布，不能在官网公开", "EVENT_NOT_PUBLISHED");
    }
  }
  ```

  ```js
  // In buildContentUpdateCandidate(), after `next` has been normalized:
  if (next.status === "scheduled") assertContentReadyForPublication(db, next);
  ```

  ```js
  // In publishContent(), replace the current one-off body sanitization:
  const bodyHtml = assertContentReadyForPublication(db, current);
  // Keep media promotion and persist `bodyHtml` in the published row.
  ```

  `buildContentUpdateCandidate()` still allows empty-body drafts. The new readiness guard runs only when a row is scheduled or published, including calls from the scheduled publisher.

- [ ] **Step 5: Write failing public-view tests for linked draft content**

  Add these cases to `public-site-service.test.js`:

  ```js
  test("public content hides linked draft events but keeps platform content public", () => {
    const source = seededPublicSiteDb();
    const linked = source.contentPosts[0];
    source.contentPosts.push({ ...linked, id: "PLATFORM", slug: "platform", eventId: null });
    source.events[0].status = "draft";

    assert.equal(buildContentDetailView(source, "news-one", now), null);
    assert.equal(buildContentDetailView(source, "platform", now).row.id, "PLATFORM");
    assert.deepEqual(visiblePosts(source, now).map((row) => row.id), ["PLATFORM"]);
  });

  test("public content remains readable for published or archived event status", () => {
    for (const status of ["published", "archived"]) {
      const source = seededPublicSiteDb();
      source.events[0].status = status;
      assert.equal(buildContentDetailView(source, "news-one", now).row.id, "NEWS-ONE");
    }
  });
  ```

  Add `visiblePosts` to the existing import from `public-site-view.js`.

- [ ] **Step 6: Implement one public-content predicate**

  In `public-site-view.js`, replace the direct `isPublicPost()` filtering with:

  ```js
  export function isPublicContentPost(db, row, now) {
    if (!isPublicPost(row, now)) return false;
    if (!row.eventId) return true;
    const event = (db.events || []).find((item) => item.id === row.eventId);
    return ["published", "archived"].includes(event?.status);
  }

  export function visiblePosts(db, now) {
    return (db.contentPosts || []).filter((row) => isPublicContentPost(db, row, now)).sort(comparePosts);
  }
  ```

  Change `buildContentDetailView()` to use the same predicate:

  ```js
  const row = (db.contentPosts || []).find((item) =>
    item.slug === slug && (allowUnpublished || isPublicContentPost(db, item, now))
  );
  ```

  Do not require an event public profile here. A published event with a hidden profile may still have direct platform content; `contentSummary()` continues stripping the hidden event link.

- [ ] **Step 7: Protect legacy scheduled rows at execution time**

  Add a third scheduler test that inserts a due scheduled post linked to a draft event. Trigger `/api/public/home`, then assert:

  ```js
  assert.equal(response.status, 200);
  assert.equal(db.contentPosts.find((row) => row.id === "DRAFT-EVENT-DUE").status, "scheduled");
  assert.equal(db.auditLogs.some((row) => row.targetId === "DRAFT-EVENT-DUE"), false);
  ```

  No scheduler implementation change is required: `scheduled-content-publisher.js` must continue calling the now-guarded `publishContent()`.

- [ ] **Step 8: Run API tests and commit**

  Run:

  ```powershell
  npm.cmd test -w apps/api -- --test-name-pattern="draft events reject|empty content body rejects|public content hides|public content remains|scheduled"
  ```

  Expected: PASS.

  ```bash
  git add apps/api/src/services/site-admin.js apps/api/src/services/public-site-view.js apps/api/test/site-admin.test.js apps/api/test/public-site-service.test.js apps/api/test/scheduled-content-publishing.test.js
  git commit -m "fix: enforce event-aware content publication"
  ```

### Task 2: Clarify event business status and website visibility

**Files:**
- Modify: `apps/admin/src/components/EventPublicProfilePanel.vue:1-185`
- Modify: `apps/admin/src/pages/SiteContentPage.vue:1-224`
- Modify: `apps/admin/src/App.vue:119-195`
- Modify: `apps/admin/src/pages/__tests__/SiteContentPage.test.js`
- Modify: `apps/admin/src/pages/__tests__/AppNavigation.test.js`
- Modify: `apps/admin/src/styles/admin.css:384-443`

**Interfaces:**
- Produces: `websitePublicationState(event, profile)` view state with `tone`, `label`, `help`, `canToggle`, and `publicResult`.
- Produces: `EventPublicProfilePanel` event `navigate("events")`.
- Consumes: existing event fields `status`, `archivedAt` and profile field `isVisible`.

- [ ] **Step 1: Write failing event-status UI tests**

  In `SiteContentPage.test.js`, add a table-driven test for draft, published/hidden, published/visible, and archived/visible:

  ```js
  it.each([
    ["draft", false, "当前赛事仍是草稿", true],
    ["published", false, "业务赛事已发布，但官网尚未公开", false],
    ["published", true, "官网已公开", false],
    ["archived", true, "将在历届赛事中展示", false]
  ])("explains %s event website state", async (status, isVisible, message, disabled) => {
    events[0].status = status;
    profiles[0].isVisible = isVisible;
    const wrapper = await mountLoaded();
    await activateTab(wrapper, "events");

    expect(wrapper.get("[data-event-publication-state]").text()).toContain(message);
    expect(wrapper.get('[data-profile-field="isVisible"]').element.disabled).toBe(disabled);
  });
  ```

  Add a navigation test that clicks `[data-action="go-event-settings"]` and expects `App.vue` to activate `[data-nav="events"]`.

- [ ] **Step 2: Run the focused admin tests and confirm failure**

  Run:

  ```powershell
  npm.cmd test -w apps/admin -- src/pages/__tests__/SiteContentPage.test.js src/pages/__tests__/AppNavigation.test.js
  ```

  Expected: FAIL because no status explanation or navigation event exists.

- [ ] **Step 3: Implement the normalized website state**

  In `EventPublicProfilePanel.vue`, add:

  ```js
  const emit = defineEmits(["saved", "navigate"]);

  const websiteState = computed(() => {
    const event = selectedEvent.value;
    if (!event) return null;
    if (event.status === "draft") return {
      tone: "warning",
      label: "当前赛事仍是草稿",
      help: "请先到赛事设置发布；官网公开暂不生效。",
      canToggle: false,
      publicResult: "不公开"
    };
    if (event.status === "archived") return {
      tone: form.isVisible ? "history" : "muted",
      label: form.isVisible ? "将在历届赛事中展示" : "已归档且未在历届赛事展示",
      help: "归档赛事不会出现在当前赛事区域。",
      canToggle: true,
      publicResult: form.isVisible ? "历届赛事可见" : "不公开"
    };
    return {
      tone: form.isVisible ? "success" : "muted",
      label: form.isVisible ? "官网已公开" : "业务赛事已发布，但官网尚未公开",
      help: form.isVisible ? "公共赛事页和对应入口可访问。" : "保存视觉内容不会自动公开赛事。",
      canToggle: true,
      publicResult: form.isVisible ? "当前赛事可见" : "不公开"
    };
  });
  ```

  In `requestBody()`, force `isVisible: false` when `websiteState.canToggle` is false. Render a `role="status"` block with `data-event-publication-state`, disable the checkbox when `!websiteState.canToggle`, and show:

  ```vue
  <button
    v-if="!websiteState.canToggle"
    type="button"
    data-action="go-event-settings"
    @click="emit('navigate', 'events')"
  >去赛事设置</button>
  ```

- [ ] **Step 4: Forward navigation to the app shell**

  Add `defineEmits(["navigate"])` to `SiteContentPage.vue`, forward the event:

  ```vue
  <EventPublicProfilePanel
    ref="eventPublicProfilePanel"
    :events="events"
    :profiles="profiles"
    @saved="updateProfile"
    @navigate="$emit('navigate', $event)"
  />
  ```

  In `App.vue`:

  ```vue
  <SiteContentPage
    v-else-if="currentView === 'siteContent'"
    @navigate="navigateAdmin"
  />
  ```

- [ ] **Step 5: Add status styles and run tests**

  Add `.event-publication-state.success`, `.warning`, `.history`, and `.muted` styles with text plus border/background differences; do not rely only on color.

  Run:

  ```powershell
  npm.cmd test -w apps/admin -- src/pages/__tests__/SiteContentPage.test.js src/pages/__tests__/AppNavigation.test.js
  ```

  Expected: PASS.

  ```bash
  git add apps/admin/src/components/EventPublicProfilePanel.vue apps/admin/src/pages/SiteContentPage.vue apps/admin/src/App.vue apps/admin/src/pages/__tests__/SiteContentPage.test.js apps/admin/src/pages/__tests__/AppNavigation.test.js apps/admin/src/styles/admin.css
  git commit -m "feat: clarify event website publication"
  ```

### Task 3: Preserve rich-text focus, selection, and composition input

**Files:**
- Modify: `apps/admin/src/components/RichTextEditor.vue:58-98,123-158,161-178`
- Modify: `apps/admin/src/components/__tests__/RichTextEditor.test.js:6-170`

**Interfaces:**
- Produces: `syncVisualDom(html, { force })`, `updateFromVisual(event)`, and focus/composition state local to the component.
- Consumes: existing `modelValue`, `revision`, `update:modelValue`, `normalized`, and sanitizer functions.

- [ ] **Step 1: Write a failing parent-writeback caret test**

  Append:

  ```js
  it("keeps focus and selection during parent writeback of visual input", async () => {
    const wrapper = mount(RichTextEditor, {
      attachTo: document.body,
      props: { modelValue: "<p>甲</p>", revision: "P1:1" }
    });
    const editor = wrapper.get('[data-rich-editor="visual"]');
    editor.element.focus();
    const text = editor.element.querySelector("p").firstChild;
    const range = document.createRange();
    range.setStart(text, 1);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    editor.element.querySelector("p").append("乙");
    await editor.trigger("input");
    const emitted = wrapper.emitted("update:modelValue").at(-1)[0];
    await wrapper.setProps({ modelValue: emitted, revision: "P1:1" });

    expect(document.activeElement).toBe(editor.element);
    expect(window.getSelection().anchorNode).toBe(text);
    expect(window.getSelection().anchorOffset).toBe(1);
    wrapper.unmount();
  });
  ```

- [ ] **Step 2: Write a failing composition and record-switch test**

  Add:

  ```js
  it("does not replace visual DOM during composition but resets it for a new revision", async () => {
    const wrapper = mount(RichTextEditor, {
      attachTo: document.body,
      props: { modelValue: "<p>原文</p>", revision: "P1:1" }
    });
    const editor = wrapper.get('[data-rich-editor="visual"]');
    editor.element.focus();
    await editor.trigger("compositionstart");
    editor.element.innerHTML = "<p>中文输入</p>";
    await editor.trigger("input");
    await wrapper.setProps({ modelValue: "<p>中文输入</p>", revision: "P1:1" });
    expect(editor.element.innerHTML).toBe("<p>中文输入</p>");

    await editor.trigger("compositionend");
    await wrapper.setProps({ modelValue: "<p>第二篇</p>", revision: "P2:1" });
    expect(editor.element.innerHTML).toBe("<p>第二篇</p>");
    wrapper.unmount();
  });
  ```

- [ ] **Step 3: Run RichTextEditor tests and confirm failure**

  Run:

  ```powershell
  npm.cmd test -w apps/admin -- src/components/__tests__/RichTextEditor.test.js
  ```

  Expected: at least the selection test fails because `v-html` and `update()` currently rewrite `innerHTML`.

- [ ] **Step 4: Remove reactive `v-html` writes from the focused surface**

  Add local state:

  ```js
  const visualFocused = ref(false);
  const composing = ref(false);
  const lastEmittedVisual = ref(null);

  function syncVisualDom(html, { force = false } = {}) {
    if (!visual.value || mode.value !== "visual") return;
    if (!force && (visualFocused.value || composing.value)) return;
    if (visual.value.innerHTML !== html) visual.value.innerHTML = html;
  }

  function updateFromVisual(event) {
    const safe = sanitizeEditorHtml(event.currentTarget.innerHTML);
    value.value = safe;
    lastEmittedVisual.value = safe;
    emit("update:modelValue", safe);
  }
  ```

  Change the prop watcher so a same-revision self-writeback updates `value` but does not touch the DOM. A revision change uses `syncVisualDom(safe, { force: true })`.

  Replace the visual template with:

  ```vue
  <div
    v-if="mode === 'visual'"
    ref="visual"
    class="rich-editor-surface"
    data-rich-editor="visual"
    :contenteditable="disabled ? 'false' : 'true'"
    @focus="visualFocused = true"
    @blur="visualFocused = false; syncVisualDom(value, { force: true })"
    @compositionstart="composing = true"
    @compositionend="composing = false; updateFromVisual($event)"
    @input="updateFromVisual"
    @paste="paste"
  ></div>
  ```

  Keep sanitization on emissions, paste, mode changes and blur. Do not write sanitized HTML into the active visual DOM on every normal input event.

- [ ] **Step 5: Run the complete editor test file and commit**

  Run:

  ```powershell
  npm.cmd test -w apps/admin -- src/components/__tests__/RichTextEditor.test.js
  ```

  Expected: all existing sanitizer/mode tests and new focus/composition tests PASS.

  ```bash
  git add apps/admin/src/components/RichTextEditor.vue apps/admin/src/components/__tests__/RichTextEditor.test.js
  git commit -m "fix: preserve rich text editor caret"
  ```

### Task 4: Separate the content list from the editor and improve list guidance

**Files:**
- Modify: `apps/admin/src/pages/SiteContentPage.vue:11-120,198-224`
- Modify: `apps/admin/src/components/ContentListPanel.vue:1-44`
- Create: `apps/admin/src/components/__tests__/ContentListPanel.test.js`
- Modify: `apps/admin/src/pages/__tests__/SiteContentPage.test.js`

**Interfaces:**
- Produces: content contexts `none | new | existing`; `none` renders only the list.
- Produces: `ContentListPanel` exposed `load()` and `clearFilters()`.
- Consumes: `ContentEditorPanel.requestLeave(callback)`, `saved`, and `deleted`.

- [ ] **Step 1: Write a failing list/editor separation test**

  Add to `SiteContentPage.test.js`:

  ```js
  it("shows only the list until the administrator chooses new or edit", async () => {
    const wrapper = await mountLoaded();
    await activateTab(wrapper, "content");
    await flushPromises();

    expect(wrapper.find(".content-list-panel").exists()).toBe(true);
    expect(wrapper.find(".content-editor-panel").exists()).toBe(false);

    await wrapper.get('[data-action="new-content"]').trigger("click");
    await flushPromises();
    expect(wrapper.find(".content-list-panel").exists()).toBe(false);
    expect(wrapper.find(".content-editor-panel").exists()).toBe(true);
    expect(wrapper.get('[data-action="back-to-content-list"]').exists()).toBe(true);
  });
  ```

  Replace the old “select another row while dirty” assertion with “return to list while dirty opens the discard confirmation, then returns only after confirmation”.

- [ ] **Step 2: Write focused list tests**

  Create `ContentListPanel.test.js` with mocked `/api/admin/content` data and assert:

  ```js
  expect(wrapper.get("[data-content-list-count]").text()).toContain("2 条");
  await wrapper.get('[data-content-filter="keyword"]').setValue("第二场赛事");
  expect(wrapper.findAll("[data-content-row]")).toHaveLength(1);
  await wrapper.get('[data-action="clear-content-filters"]').trigger("click");
  expect(wrapper.findAll("[data-content-row]")).toHaveLength(2);
  ```

  Add separate assertions for:

  ```js
  expect(wrapper.text()).toContain("尚未创建官网内容");
  expect(wrapper.text()).toContain("没有符合条件的内容");
  ```

  The first case uses an empty API response and no active filters; the second uses rows plus a nonmatching keyword.

- [ ] **Step 3: Run tests and confirm failure**

  Run:

  ```powershell
  npm.cmd test -w apps/admin -- src/components/__tests__/ContentListPanel.test.js src/pages/__tests__/SiteContentPage.test.js
  ```

  Expected: FAIL because the editor is always mounted and list empty states are not distinguished.

- [ ] **Step 4: Implement one active content task at a time**

  Add `backToContentList()`:

  ```js
  function backToContentList() {
    contentEditor.value?.requestLeave(() => {
      contentContext.value = "none";
      selectedContentId.value = null;
      contentList.value?.load();
    });
  }
  ```

  Replace the content panel markup with:

  ```vue
  <ContentListPanel
    v-if="contentContext === 'none'"
    ref="contentList"
    :events="events"
    :selected-id="selectedContentId"
    @select="chooseContent"
    @new="newContent"
  />
  <div v-else class="content-editor-workflow">
    <button
      type="button"
      data-action="back-to-content-list"
      @click="backToContentList"
    >返回内容列表</button>
    <ContentEditorPanel
      ref="contentEditor"
      :content-id="selectedContentId"
      :events="events"
      :profiles="profiles"
      @saved="contentSaved"
      @deleted="contentDeleted"
      @navigate="$emit('navigate', $event)"
    />
  </div>
  ```

- [ ] **Step 5: Implement list counts, event-name search, clear filters, and client pagination**

  In `ContentListPanel.vue`, include `watch` in the Vue import and add:

  ```js
  const page = ref(1);
  const pageSize = 10;
  const hasActiveFilters = computed(() => Object.values(filters).some((value) => String(value).trim()));
  const eventNames = computed(() => new Map(props.events.map((event) => [event.id, event.name])));
  const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)));
  const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize));

  watch(
    () => [filters.type, filters.eventId, filters.status, filters.keyword],
    () => {
      page.value = 1;
    }
  );

  function clearFilters() {
    Object.assign(filters, { type: "", eventId: "", status: "", keyword: "" });
    page.value = 1;
  }
  ```

  Include `eventNames.value.get(row.eventId)` in keyword matching. Render `[data-content-list-count]`, refresh, clear filters, `paged`, previous/next buttons, and different no-data/no-match messages.

- [ ] **Step 6: Run tests and commit**

  Run:

  ```powershell
  npm.cmd test -w apps/admin -- src/components/__tests__/ContentListPanel.test.js src/pages/__tests__/SiteContentPage.test.js
  ```

  Expected: PASS.

  ```bash
  git add apps/admin/src/pages/SiteContentPage.vue apps/admin/src/components/ContentListPanel.vue apps/admin/src/components/__tests__/ContentListPanel.test.js apps/admin/src/pages/__tests__/SiteContentPage.test.js
  git commit -m "refactor: separate content list and editor"
  ```

### Task 5: Add grouped editing and a publication-review stage

**Files:**
- Create: `apps/admin/src/lib/content-publication-state.js`
- Create: `apps/admin/src/components/ContentPublicationReview.vue`
- Create: `apps/admin/src/components/__tests__/ContentPublicationReview.test.js`
- Modify: `apps/admin/src/components/ContentEditorPanel.vue:1-280`
- Modify: `apps/admin/src/components/__tests__/ContentEditorPanel.test.js:1-562`

**Interfaces:**
- Produces: `contentPublicationState({ content, event, profile })` returning `{ blockingIssues, warnings, resultLabel }`.
- Produces: `ContentPublicationReview` events `back`, `preview`, `publish`, and `navigate`.
- Consumes: `events`, `profiles`, current saved form snapshot, existing preview API, publish confirmation and lifecycle API.

- [ ] **Step 1: Write pure publication-state tests**

  Create `ContentPublicationReview.test.js` and first test the helper directly:

  ```js
  import { contentPublicationState } from "../../lib/content-publication-state.js";

  const content = { id: "P1", slug: "news", title: "新闻", bodyHtml: "<p>正文</p>", eventId: "E1" };

  expect(contentPublicationState({
    content,
    event: { id: "E1", status: "draft" },
    profile: null
  })).toMatchObject({
    blockingIssues: [{ code: "event-draft" }],
    resultLabel: "暂不能公开"
  });

  expect(contentPublicationState({
    content,
    event: { id: "E1", status: "published" },
    profile: { eventId: "E1", isVisible: false }
  })).toMatchObject({
    blockingIssues: [],
    warnings: [{ code: "event-hidden" }]
  });
  ```

  Also assert platform content is ready, archived content reports historical display, missing title/slug/body produce blocking issues, and a missing cover produces the nonblocking warning `{ code: "cover" }`.

- [ ] **Step 2: Implement the pure state helper**

  In `content-publication-state.js`:

  ```js
  function issue(code, message) {
    return { code, message };
  }

  export function contentPublicationState({ content, event, profile }) {
    const blockingIssues = [];
    const warnings = [];
    if (!String(content?.title || "").trim()) blockingIssues.push(issue("title", "请填写标题"));
    if (!String(content?.slug || "").trim()) blockingIssues.push(issue("slug", "请填写公开地址"));
    if (!String(content?.bodyHtml || "").replace(/<[^>]*>/g, "").trim()) {
      blockingIssues.push(issue("body", "请填写正文"));
    }
    if (content?.eventId && (!event || event.status === "draft")) {
      blockingIssues.push(issue("event-draft", "归属赛事尚未发布"));
    } else if (event?.status === "archived") {
      warnings.push(issue("event-archived", "内容将显示在历届赛事范围"));
    } else if (event && profile?.isVisible !== true) {
      warnings.push(issue("event-hidden", "赛事官网入口仍处于隐藏状态"));
    }
    if (!String(content?.summary || "").trim()) warnings.push(issue("summary", "建议填写摘要"));
    if (!content?.coverMediaId) warnings.push(issue("cover", "建议上传封面"));
    return {
      blockingIssues,
      warnings,
      resultLabel: blockingIssues.length ? "暂不能公开" : "可以发布"
    };
  }
  ```

- [ ] **Step 3: Write the failing review-component interaction test**

  Mount `ContentPublicationReview` with a draft event and assert:

  ```js
  expect(wrapper.get('[data-action="confirm-review-publish"]').attributes("disabled")).toBeDefined();
  expect(wrapper.text()).toContain("归属赛事尚未发布");
  await wrapper.get('[data-action="go-event-settings"]').trigger("click");
  expect(wrapper.emitted("navigate")).toEqual([["events"]]);
  ```

  Mount with a published event and complete content, click preview, back and publish, then assert the corresponding events.

- [ ] **Step 4: Implement the review component**

  `ContentPublicationReview.vue` receives:

  ```js
  const props = defineProps({
    content: { type: Object, required: true },
    event: { type: Object, default: null },
    profile: { type: Object, default: null },
    busy: { type: Boolean, default: false }
  });
  const emit = defineEmits(["back", "preview", "publish", "navigate"]);
  const state = computed(() => contentPublicationState(props));
  ```

  Render:

  - title, type, event, slug and status facts;
  - blocking issues with `role="alert"`;
  - warnings with `role="status"`;
  - “返回编辑”“预览当前草稿”“确认发布”;
  - “去赛事设置” only for `event-draft`;
  - disabled publish when `blockingIssues.length > 0 || busy`.

- [ ] **Step 5: Write a failing save-then-review editor test**

  In `ContentEditorPanel.test.js`, add:

  ```js
  it("saves dirty content before opening publication review", async () => {
    const wrapper = await mountEditor();
    await wrapper.get('[data-content-field="title"]').setValue("准备发布");
    await wrapper.get('[data-action="save-and-review-content"]').trigger("click");
    await flushPromises();

    const saveIndex = apiMock.mock.calls.findIndex(([path, options]) =>
      path === "/api/admin/content/POST-1" && options?.method === "PATCH"
    );
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(wrapper.get('[data-content-publication-review]').exists()).toBe(true);
    expect(wrapper.find("form.content-editor-form").exists()).toBe(false);
  });
  ```

  Add a second test for the explicit save-and-preview action:

  ```js
  it("saves before opening a sanitized preview", async () => {
    installApi({
      "POST /api/admin/site-preview/content": async () => ({
        preview: { payload: { row: { bodyHtml: "<p>服务端保存后预览</p>" } } }
      })
    });
    const wrapper = await mountEditor();
    await wrapper.get('[data-content-field="title"]').setValue("保存后预览");
    await wrapper.get('[data-action="save-and-preview-content"]').trigger("click");
    await flushPromises();

    const saveIndex = apiMock.mock.calls.findIndex(([path, options]) =>
      path === "/api/admin/content/POST-1" && options?.method === "PATCH"
    );
    const previewIndex = apiMock.mock.calls.findIndex(([path, options]) =>
      path === "/api/admin/site-preview/content" && options?.method === "POST"
    );
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(previewIndex).toBeGreaterThan(saveIndex);
    expect(wrapper.get('[data-preview-body]').html()).toContain("服务端保存后预览");
  });
  ```

  Add a draft-event case where the review publish button is disabled and no `/publish` request occurs.

- [ ] **Step 6: Group the editor and integrate review**

  Add `profiles` prop, `reviewing`, selected event/profile computed values, and a `save({ openReview })` return value. `save()` returns `null` on failure. After a successful save:

  ```js
  if (openReview) reviewing.value = true;
  return payload.row;
  ```

  Add the two explicit transition actions:

  ```js
  async function saveAndReview() {
    if (published.value) return;
    if (dirty.value || !form.id) {
      await save({ openReview: true });
      return;
    }
    reviewing.value = true;
  }

  async function saveAndPreview() {
    const saved = await save();
    if (saved) await preview();
  }
  ```

  Render the editor form only when `!reviewing`; render `ContentPublicationReview` otherwise. Group existing fields under headings with `data-content-section="basics"`, `body-media`, and `display`. Render distinct `data-action="save-content"`, `save-and-preview-content`, and `save-and-review-content` buttons. Preserve all existing media, attachment, slug-lock, offline, delete and unsaved-preview behavior.

  Wire review events:

  ```vue
  <ContentPublicationReview
    v-else
    :content="{ ...form }"
    :event="selectedEvent"
    :profile="selectedProfile"
    :busy="busy"
    @back="reviewing = false"
    @preview="preview"
    @publish="ask('publish')"
    @navigate="emit('navigate', $event)"
  />
  ```

  Add `"navigate"` to `defineEmits`. Keep published content read-only; show preview, downline and delete actions according to existing lifecycle rules.

- [ ] **Step 7: Run component tests and commit**

  Run:

  ```powershell
  npm.cmd test -w apps/admin -- src/components/__tests__/ContentPublicationReview.test.js src/components/__tests__/ContentEditorPanel.test.js
  ```

  Expected: PASS.

  ```bash
  git add apps/admin/src/lib/content-publication-state.js apps/admin/src/components/ContentPublicationReview.vue apps/admin/src/components/ContentEditorPanel.vue apps/admin/src/components/__tests__/ContentPublicationReview.test.js apps/admin/src/components/__tests__/ContentEditorPanel.test.js
  git commit -m "feat: add content publication review"
  ```

### Task 6: Finish responsive layout, sticky actions, and accessibility

**Files:**
- Modify: `apps/admin/src/styles/admin.css:306-580`
- Modify: `apps/admin/src/pages/__tests__/SiteContentPage.test.js`
- Modify: `apps/admin/src/components/__tests__/ContentEditorPanel.test.js`
- Modify: `apps/admin/src/components/__tests__/ContentPublicationReview.test.js`

**Interfaces:**
- Produces: `.content-editor-workflow`, `.content-editor-section`, `.content-editor-sticky-actions`, `.content-publication-review`, and status classes.
- Consumes: data attributes and semantic controls introduced in Tasks 2, 4, and 5.

- [ ] **Step 1: Write failing structure and CSS contract tests**

  Add DOM assertions:

  ```js
  for (const name of ["basics", "body-media", "display"]) {
    expect(wrapper.get(`[data-content-section="${name}"]`).exists()).toBe(true);
  }
  expect(wrapper.get('[data-content-editor-actions]').attributes("aria-label")).toBe("内容操作");
  ```

  Add CSS assertions in `SiteContentPage.test.js`:

  ```js
  const css = readFileSync("src/styles/admin.css", "utf8");
  expect(css).toMatch(/\.content-editor-sticky-actions\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;/s);
  expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.content-editor-section \.site-form-grid\s*\{[^}]*grid-template-columns:\s*1fr;/);
  expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.content-editor-sticky-actions\s*\{[^}]*flex-direction:\s*column;/);
  ```

- [ ] **Step 2: Run focused tests and confirm failure**

  Run:

  ```powershell
  npm.cmd test -w apps/admin -- src/pages/__tests__/SiteContentPage.test.js src/components/__tests__/ContentEditorPanel.test.js src/components/__tests__/ContentPublicationReview.test.js
  ```

  Expected: FAIL until the new classes and accessibility labels exist.

- [ ] **Step 3: Implement desktop and mobile styles**

  Apply these layout rules in `admin.css`:

  ```css
  .content-editor-workflow {
    display: grid;
    gap: 14px;
    min-width: 0;
  }

  .content-editor-section {
    padding: 18px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #fff;
  }

  .content-editor-sticky-actions {
    position: sticky;
    bottom: 0;
    z-index: 5;
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 -8px 24px rgba(17, 43, 75, 0.08);
  }

  @media (max-width: 760px) {
    .content-editor-section .site-form-grid {
      grid-template-columns: 1fr;
    }

    .content-editor-sticky-actions {
      position: static;
      flex-direction: column;
    }

    .content-editor-sticky-actions button {
      width: 100%;
    }
  }
  ```

  Ensure the sticky bar does not cover the final field by adding bottom spacing to the editor form. Preserve visible focus outlines and use text labels alongside status colors.

- [ ] **Step 4: Verify keyboard and narrow-screen behavior**

  Add tests that:

  - focus “返回内容列表” after leaving review;
  - keep focus inside the existing confirmation dialog;
  - allow Escape to cancel publish confirmation;
  - expose `role="alert"` for blocking issues and `role="status"` for warnings;
  - keep button labels visible at mobile width.

  Run:

  ```powershell
  npm.cmd test -w apps/admin -- src/pages/__tests__/SiteContentPage.test.js src/components/__tests__/ContentEditorPanel.test.js src/components/__tests__/ContentPublicationReview.test.js
  ```

  Expected: PASS.

- [ ] **Step 5: Run the complete local release gate and commit**

  Run:

  ```powershell
  npm.cmd test -w apps/api
  npm.cmd test -w apps/admin
  npm.cmd test -w apps/web -- --run
  npm.cmd run build
  git diff --check
  ```

  Expected: all tests PASS, both Vite builds succeed, and `git diff --check` prints nothing.

  ```bash
  git add apps/admin/src/styles/admin.css apps/admin/src/pages/__tests__/SiteContentPage.test.js apps/admin/src/components/__tests__/ContentEditorPanel.test.js apps/admin/src/components/__tests__/ContentPublicationReview.test.js
  git commit -m "style: polish content workflow responsively"
  ```

### Task 7: Review, deploy, and verify the Alibaba Cloud test environment

**Files:**
- Read: `docs/deployment/aliyun-test.md`
- Read: `deploy/preflight-admin-upgrade.sh`
- Read: `deploy/remote-smoke-test.sh`
- No database migration files.

**Interfaces:**
- Consumes: tested branch HEAD, SSH alias `aerogp`, server `/opt/aerogp`, Docker Compose services `postgres`, `api`, `web`, `backup`.
- Produces: healthy test deployment at `http://47.99.181.222/` and verified admin flow at `/admin/`.

- [ ] **Step 1: Perform a final code review and release gate**

  Inspect:

  ```powershell
  git status --short
  git log --oneline --decorate -8
  git diff HEAD~6..HEAD --check
  ```

  Re-run:

  ```powershell
  npm.cmd test -w apps/api
  npm.cmd test -w apps/admin
  npm.cmd test -w apps/web -- --run
  npm.cmd run build
  docker compose config --quiet
  ```

  Expected: clean worktree, all suites PASS, build succeeds, Compose configuration is valid.

- [ ] **Step 2: Create and verify database and upload backups**

  Run:

  ```powershell
  ssh aerogp 'cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-postgres.sh once'
  ssh aerogp 'cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-uploads.sh once'
  ssh aerogp 'cd /opt/aerogp && /bin/sh deploy/preflight-admin-upgrade.sh'
  ```

  Expected: both backup scripts exit 0 and preflight prints `Upgrade preflight passed.`. Stop before deployment if any command fails.

- [ ] **Step 3: Package the exact Git commit and upload it**

  From WSL, create a Git archive without `.env`, backups, test databases, or local untracked files:

  ```bash
  commit="$(git rev-parse HEAD)"
  printf '%s\n' "$commit" > /mnt/c/tmp/aerogp-content-workflow.release
  git archive --format=tar "$commit" | gzip -9 > /mnt/c/tmp/aerogp-content-workflow.tgz
  sha256sum /mnt/c/tmp/aerogp-content-workflow.tgz
  ```

  Upload:

  ```powershell
  scp C:\tmp\aerogp-content-workflow.tgz C:\tmp\aerogp-content-workflow.release aerogp:/tmp/
  ssh aerogp 'sha256sum /tmp/aerogp-content-workflow.tgz'
  ```

  Expected: local and remote SHA-256 values are identical.

- [ ] **Step 4: Preserve current source and install the release without touching data volumes**

  Run:

  ```powershell
  ssh aerogp 'cd /opt/aerogp && stamp=$(date -u +%Y%m%dT%H%M%SZ) && archive="backups/source-before-content-workflow-${stamp}.tgz" && tar --exclude=.env --exclude=backups -czf "$archive" . && printf "%s\n" "$archive" >/tmp/aerogp-content-workflow-rollback-path'
  ssh aerogp 'cd /opt/aerogp && tar -xzf /tmp/aerogp-content-workflow.tgz && install -m 644 /tmp/aerogp-content-workflow.release .release'
  ```

  The uploaded release file writes the exact local commit to `/opt/aerogp/.release`. The first command stores the verified rollback archive path in `/tmp/aerogp-content-workflow-rollback-path`. Do not remove `/opt/aerogp/.env`, `/opt/aerogp/backups`, `aerogp_postgres_data`, or `aerogp_uploads_data`.

- [ ] **Step 5: Rebuild API and Web and wait for health**

  Run:

  ```powershell
  ssh aerogp 'cd /opt/aerogp && docker compose build api web'
  ssh aerogp 'cd /opt/aerogp && docker compose up -d --no-deps --wait --wait-timeout 240 api web'
  ssh aerogp 'cd /opt/aerogp && docker compose ps'
  ```

  Expected: `postgres`, `api`, `web`, and `backup` are healthy; only Web publishes port 80.

- [ ] **Step 6: Run remote smoke checks without exposing credentials**

  Run the existing smoke script in an interactive SSH terminal so the password is entered silently and never appears in command history:

  ```powershell
  ssh -t aerogp 'cd /opt/aerogp && umask 077 && read -r -s -p "测试管理员密码: " ADMIN_TEST_PASSWORD && export ADMIN_TEST_PASSWORD && /bin/sh deploy/remote-smoke-test.sh; status=$?; unset ADMIN_TEST_PASSWORD; exit $status'
  ```

  Expected: public home, admin HTML, event API, login, authenticated admin endpoints return 200; anonymous admin endpoint returns expected 401.

- [ ] **Step 7: Perform browser acceptance at four widths**

  Verify the real page `http://47.99.181.222/admin/` at 360, 768, 1024, and 1440px:

  1. “内容发布” initially shows only the content list.
  2. “新建内容” enters an independent grouped editor.
  3. Enter at least 200 mixed Chinese/English characters without clicking the body again.
  4. Save draft, preview, and publication review are distinct.
  5. Draft event blocks content publication and links to “赛事设置”.
  6. Published/hidden and archived/visible events show the correct website result.
  7. Returning with unsaved changes prompts before discarding.
  8. Browser console contains no application errors.

  Also verify:

  ```powershell
  ssh aerogp 'ss -lnt'
  ssh aerogp 'cd /opt/aerogp && docker compose logs --tail=100 api web'
  ```

  Expected: host listeners remain 22 and 80, with no API startup or Web runtime error.

- [ ] **Step 8: Preserve the non-destructive rollback point**

  Record the deployed commit, backup filenames, source snapshot, image IDs, health output, smoke summary, and browser acceptance results in the task handoff. If rollback is required:

  ```powershell
  ssh aerogp 'cd /opt/aerogp && archive=$(cat /tmp/aerogp-content-workflow-rollback-path) && test -n "$archive" && test -s "$archive" && tar -xzf "$archive" && docker compose build api web && docker compose up -d --no-deps --wait --wait-timeout 240 api web'
  ```

  Never run `docker compose down -v`; it would destroy the database and upload volumes.

