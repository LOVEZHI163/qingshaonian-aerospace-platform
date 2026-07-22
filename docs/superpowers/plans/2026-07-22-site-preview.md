# 官网内容预览功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在“官网内容”的三个标签中提供“预览已保存官网”和“预览当前草稿”，草稿预览不写数据库、仅当前浏览器可见，并复用公共网站真实页面组件。

**Architecture:** API 将现有公共页面视图模型组装逻辑提取为纯函数，管理员预览接口复用相同组装规则并只返回规范化数据。Vue 管理端收集当前未保存表单、调用无状态校验 API，并把 15 分钟快照写入同源 `localStorage`；React 公共端通过 `/preview?token=...` 读取快照，再将数据传入与正式页面共用的展示组件。

**Tech Stack:** Vue 3 + Vitest（管理端）、React 18 + Vitest/Testing Library（公共端）、Node.js + Express + `node:test`（API）、浏览器 Web Crypto 与 localStorage。

## Global Constraints

- 草稿预览不得写数据库、改变发布状态、写业务审计记录或调用保存接口。
- 草稿快照默认有效期为 15 分钟，token 必须由 `crypto.getRandomValues` 生成。
- URL 只携带 token，不携带正文、图片或其他业务数据。
- 快照不得包含管理员身份、会话、密码、手机号、审核备注或其他敏感字段。
- 预览页必须显示“草稿预览 · 未保存 · 仅当前浏览器可见”，并设置 `noindex, nofollow`。
- 未选择赛事或内容时禁用相应预览按钮，并给出准确原因。
- 预览页面必须复用正式首页、赛事详情和内容详情展示组件。
- 不增加数据库迁移，不改变现有发布、下线、定时发布与保存流程。
- 所有代码改动遵循测试先行；每个任务独立提交。

---

## 文件结构与职责

- `apps/api/src/services/public-site-view.js`：公共首页、赛事详情、内容详情的纯视图模型构建器；正式公共路由和预览服务共同使用。
- `apps/api/src/services/site-preview.js`：校验三类管理员草稿并合成预览视图模型，不持久化。
- `apps/api/src/routes/site-admin.js`：暴露管理员预览规范化接口。
- `apps/api/src/routes/site-media.js`：提供仅管理员会话可访问的私有媒体预览读取接口。
- `apps/admin/src/lib/site-preview.js`：生成 token、保存 15 分钟快照、清理过期快照并打开预览地址。
- `apps/admin/src/pages/SiteContentPage.vue`：顶部预览按钮、上下文判断、错误与弹窗拦截提示。
- `apps/admin/src/components/SiteSettingsPanel.vue`：暴露首页设置草稿 payload。
- `apps/admin/src/components/EventPublicProfilePanel.vue`：暴露选中赛事与视觉草稿 payload。
- `apps/admin/src/components/ContentEditorPanel.vue`：暴露当前内容草稿 payload 与可预览状态。
- `apps/web/src/preview/storage.js`：读取、验证、过期清理浏览器快照。
- `apps/web/src/pages/PreviewPage.jsx`：预览状态条、错误状态和按类型分发。
- `apps/web/src/pages/HomePage.jsx`、`EventDetailPage.jsx`、`ContentDetailPage.jsx`：提取可直接接收视图模型的展示组件。
- `apps/web/src/router.js`、`App.jsx`：识别和渲染 `/preview`，且不进入公共 SEO、站点地图或正常导航。

---

### Task 1: 提取公共页面视图模型构建器

**Files:**
- Create: `apps/api/src/services/public-site-view.js`
- Modify: `apps/api/src/routes/public-site.js`
- Test: `apps/api/test/public-site-service.test.js`
- Test: `apps/api/test/public-site-routes.test.js`

**Interfaces:**
- Produces: `buildHomeView(db, now) -> HomeView`
- Produces: `buildEventDetailView(db, slug, now, { allowPrivateMedia = false } = {}) -> EventDetailView | null`
- Produces: `buildContentDetailView(db, slug, now, { allowUnpublished = false, mediaUrl } = {}) -> ContentDetailView | null`
- Produces: `mediaView(db, mediaId, { allowPrivate = false, urlFor } = {}) -> MediaView | null`

- [ ] **Step 1: Write failing pure-service tests**

Add imports and assertions proving the extracted builders preserve current output:

```js
import {
  buildContentDetailView,
  buildEventDetailView,
  buildHomeView,
  mediaView
} from "../src/services/public-site-view.js";

test("public view builders preserve homepage, event and content shapes", () => {
  const db = seededPublicSiteDb();
  const now = new Date("2026-07-20T00:00:00.000Z");
  assert.equal(buildHomeView(db, now).site.platformName, db.siteSettings.platformName);
  assert.equal(buildEventDetailView(db, "current-event", now).event.slug, "current-event");
  assert.equal(buildContentDetailView(db, "news-one", now).row.slug, "news-one");
});

test("mediaView hides private media unless an explicit protected URL builder is supplied", () => {
  const db = seededPublicSiteDbWithPrivateMedia();
  assert.equal(mediaView(db, "MEDIA-PRIVATE"), null);
  assert.equal(
    mediaView(db, "MEDIA-PRIVATE", {
      allowPrivate: true,
      urlFor: (id) => `/api/admin/site-media/${id}/preview`
    }).url,
    "/api/admin/site-media/MEDIA-PRIVATE/preview"
  );
});
```

- [ ] **Step 2: Run tests to verify module is missing**

Run: `node --test apps/api/test/public-site-service.test.js apps/api/test/public-site-routes.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `public-site-view.js`.

- [ ] **Step 3: Move view assembly into focused pure functions**

Create `public-site-view.js` by moving the existing `publicMedia`, attachment, site settings, event summary, content summary/detail, services, homepage, event-detail and content-detail assembly from `routes/public-site.js`. Keep HTTP parsing and `res.json` in the router. Use this media boundary:

```js
export function mediaView(db, mediaId, {
  allowPrivate = false,
  urlFor = (id, variant = "original") => `/api/public/media/${encodeURIComponent(id)}?variant=${variant}`
} = {}) {
  if (!mediaId) return null;
  const media = (db.mediaAssets || []).find((row) => row.id === mediaId && !row.cleanedAt);
  if (!media || (!allowPrivate && media.visibility !== "public")) return null;
  return {
    id: media.id,
    url: urlFor(media.id, "original"),
    name: media.originalName,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    width: media.width ?? null,
    height: media.height ?? null,
    ...(media.variants?.mobile ? { mobileUrl: urlFor(media.id, "mobile") } : {}),
    ...(media.variants?.desktop ? { desktopUrl: urlFor(media.id, "desktop") } : {})
  };
}
```

Update public routes to call exported builders and preserve current status codes:

```js
router.get("/public/home", asyncRoute(async (_req, res) => {
  res.json(buildHomeView(await store.readDb(), asDate(clock)));
}));
```

- [ ] **Step 4: Run public API tests**

Run: `node --test apps/api/test/public-site-service.test.js apps/api/test/public-site-routes.test.js`

Expected: PASS with unchanged public route payloads and visibility rules.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/public-site-view.js apps/api/src/routes/public-site.js apps/api/test/public-site-service.test.js apps/api/test/public-site-routes.test.js
git commit -m "refactor: share public site view builders"
```

---

### Task 2: 增加无状态预览 API 与受保护媒体读取

**Files:**
- Create: `apps/api/src/services/site-preview.js`
- Modify: `apps/api/src/routes/site-admin.js`
- Modify: `apps/api/src/routes/site-media.js`
- Test: `apps/api/test/site-preview.test.js`
- Test: `apps/api/test/site-media.test.js`

**Interfaces:**
- Consumes: Task 1 `buildHomeView`, `buildEventDetailView`, `buildContentDetailView`, `mediaView`
- Produces: `buildSitePreview(db, kind, input, { now }) -> { kind, payload, context }`
- Produces HTTP: `POST /api/admin/site-preview/:kind -> { preview }`
- Produces HTTP: `GET /api/admin/site-media/:id/preview?variant=original|mobile|desktop`

- [ ] **Step 1: Write failing API tests**

Create tests covering authorization, normalization, sanitization and zero writes:

```js
test("admin preview normalizes all three kinds without writing the store", async () => {
  const before = structuredClone(await store.readDb());
  const homepage = await admin.post("/api/admin/site-preview/homepage", homepageDraft);
  const event = await admin.post("/api/admin/site-preview/event", eventDraft);
  const content = await admin.post("/api/admin/site-preview/content", {
    ...contentDraft,
    bodyHtml: '<p onclick="alert(1)">正文</p><script>alert(1)</script>'
  });
  assert.equal(homepage.status, 200);
  assert.equal(event.status, 200);
  assert.equal(content.status, 200);
  assert.equal(content.body.preview.payload.row.bodyHtml, "<p>正文</p>");
  assert.deepEqual(await store.readDb(), before);
});

test("preview rejects ordinary users, invalid kinds and foreign media", async () => {
  assert.equal((await ordinary.post("/api/admin/site-preview/homepage", homepageDraft)).status, 403);
  assert.equal((await admin.post("/api/admin/site-preview/unknown", {})).status, 404);
  assert.equal((await admin.post("/api/admin/site-preview/event", foreignMediaDraft)).status, 422);
});
```

Add media tests:

```js
test("private preview media requires an administrator session", async () => {
  assert.equal((await anonymous.get("/api/admin/site-media/MEDIA-PRIVATE/preview")).status, 401);
  const response = await admin.get("/api/admin/site-media/MEDIA-PRIVATE/preview");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
```

- [ ] **Step 2: Run tests to verify endpoints are absent**

Run: `node --test apps/api/test/site-preview.test.js apps/api/test/site-media.test.js`

Expected: FAIL with preview route 404 and missing `site-preview.js`.

- [ ] **Step 3: Implement pure preview normalization**

Implement an explicit dispatcher that reads but never mutates `db`:

```js
export function buildSitePreview(db, kind, input, { now }) {
  const snapshot = structuredClone(db);
  if (kind === "homepage") return buildHomepagePreview(snapshot, input, now);
  if (kind === "event") return buildEventPreview(snapshot, input, now);
  if (kind === "content") return buildContentPreview(snapshot, input, now);
  throw new SitePreviewError(404, "预览类型不存在");
}
```

For homepage and event, call the same validation helpers used by `updateSiteSettings` and `upsertEventPublicProfile` against the clone, then call Task 1 builders. For content, use `normalizeContentInput`, `sanitizeContentHtml`, existing event/media checks and protected media URLs. Force only the preview copy to a renderable state; do not modify the original `db`.

- [ ] **Step 4: Register the non-mutating route**

Add this route before `return router` and deliberately use `asyncRoute`, not `mutationAsyncRoute`:

```js
router.post("/admin/site-preview/:kind", ...admin, asyncRoute(async (req, res) => {
  const preview = buildSitePreview(await store.readDb(), req.params.kind, req.body, { now: now() });
  res.set("Cache-Control", "private, no-store");
  res.json({ preview });
}));
```

Implement protected media delivery using the same variant/path/signature checks as the public media route, with `...admin` middleware and headers:

```js
res.set({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" });
```

- [ ] **Step 5: Run API tests**

Run: `node --test apps/api/test/site-preview.test.js apps/api/test/site-media.test.js`

Expected: PASS, including byte-for-byte store equality before and after preview calls.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/site-preview.js apps/api/src/routes/site-admin.js apps/api/src/routes/site-media.js apps/api/test/site-preview.test.js apps/api/test/site-media.test.js
git commit -m "feat: add stateless site preview API"
```

---

### Task 3: 建立管理端快照存储与草稿读取接口

**Files:**
- Create: `apps/admin/src/lib/site-preview.js`
- Create: `apps/admin/src/lib/__tests__/site-preview.test.js`
- Modify: `apps/admin/src/components/SiteSettingsPanel.vue`
- Modify: `apps/admin/src/components/EventPublicProfilePanel.vue`
- Modify: `apps/admin/src/components/ContentEditorPanel.vue`
- Test: `apps/admin/src/pages/__tests__/SiteContentPage.test.js`
- Test: `apps/admin/src/components/__tests__/ContentEditorPanel.test.js`

**Interfaces:**
- Produces: `createPreviewSnapshot({ kind, payload, context, now = Date.now(), storage = localStorage }) -> { token, url, expiresAt }`
- Produces: `cleanupPreviewSnapshots({ now = Date.now(), storage = localStorage }) -> number`
- Produces child component methods: `getPreviewDraft()` and `getSavedPreviewPath()`

- [ ] **Step 1: Write failing snapshot utility tests**

```js
test("createPreviewSnapshot stores only a random-token keyed 15-minute envelope", () => {
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((bytes) => bytes.fill(7));
  const storage = memoryStorage();
  const result = createPreviewSnapshot({
    kind: "homepage",
    payload: { site: { platformName: "测试" } },
    context: {},
    now: 1_000,
    storage
  });
  expect(result.expiresAt).toBe(901_000);
  expect(result.url).toBe(`/preview?token=${encodeURIComponent(result.token)}`);
  expect(storage.getItem(`${PREVIEW_STORAGE_PREFIX}${result.token}`)).toContain('"version":1');
});

test("cleanupPreviewSnapshots removes only expired preview records", () => {
  const storage = storageWithExpiredAndFreshRecords();
  expect(cleanupPreviewSnapshots({ now: 901_001, storage })).toBe(1);
  expect(storage.getItem("unrelated-key")).toBe("keep");
});
```

- [ ] **Step 2: Run tests to verify utility is absent**

Run: `npm test -w apps/admin -- --run apps/admin/src/lib/__tests__/site-preview.test.js`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement snapshot utility**

```js
export const PREVIEW_STORAGE_PREFIX = "aerogp:site-preview:v1:";
export const PREVIEW_TTL_MS = 15 * 60 * 1000;

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createPreviewSnapshot({ kind, payload, context = {}, now = Date.now(), storage = localStorage }) {
  cleanupPreviewSnapshots({ now, storage });
  const token = randomToken();
  const expiresAt = now + PREVIEW_TTL_MS;
  storage.setItem(`${PREVIEW_STORAGE_PREFIX}${token}`, JSON.stringify({
    version: 1, token, kind, createdAt: now, expiresAt,
    adminReturnPath: "/admin/", payload, context
  }));
  return { token, expiresAt, url: `/preview?token=${encodeURIComponent(token)}` };
}
```

- [ ] **Step 4: Write failing child-component contract tests**

Assert refs expose exact drafts:

```js
expect(wrapper.getComponent(SiteSettingsPanel).vm.getPreviewDraft()).toEqual({
  kind: "homepage",
  body: expect.objectContaining({ platformIntro: "尚未保存的简介" }),
  context: {}
});
expect(wrapper.getComponent(EventPublicProfilePanel).vm.getPreviewDraft()).toEqual({
  kind: "event",
  body: expect.objectContaining({ eventId: "EVENT-1", slogan: "尚未保存" }),
  context: { eventId: "EVENT-1" }
});
```

For content, assert a new unsaved content can be previewed and the old dialog-only preview no longer blocks on `form.id`.

- [ ] **Step 5: Expose pure draft readers without saving**

Add refs in `SiteContentPage.vue` and expose these methods from children:

```js
// SiteSettingsPanel.vue
defineExpose({
  getPreviewDraft: () => ({ kind: "homepage", body: payload(), context: {} }),
  getSavedPreviewPath: () => "/"
});

// EventPublicProfilePanel.vue
defineExpose({
  getPreviewDraft: () => selectedId.value ? {
    kind: "event",
    body: { eventId: selectedId.value, ...requestBody() },
    context: { eventId: selectedId.value }
  } : null,
  getSavedPreviewPath: () => profileFor(selectedId.value)?.slug
    ? `/events/${encodeURIComponent(profileFor(selectedId.value).slug)}` : null
});

// ContentEditorPanel.vue
defineExpose({
  requestLeave,
  load,
  isDirty: () => dirty.value,
  getPreviewDraft: () => ({ kind: "content", body: contentPayload({ forPreview: true }), context: { contentId: form.id } }),
  getSavedPreviewPath: () => form.id && form.slug ? `/content/${encodeURIComponent(form.slug)}` : null
});
```

Adapt `contentPayload` so preview accepts a new unsaved item and does not enforce future scheduling or persistence-only version requirements.

- [ ] **Step 6: Run focused admin tests**

Run: `npm test -w apps/admin -- --run apps/admin/src/lib/__tests__/site-preview.test.js apps/admin/src/components/__tests__/ContentEditorPanel.test.js apps/admin/src/pages/__tests__/SiteContentPage.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/lib/site-preview.js apps/admin/src/lib/__tests__/site-preview.test.js apps/admin/src/components/SiteSettingsPanel.vue apps/admin/src/components/EventPublicProfilePanel.vue apps/admin/src/components/ContentEditorPanel.vue apps/admin/src/components/__tests__/ContentEditorPanel.test.js apps/admin/src/pages/__tests__/SiteContentPage.test.js
git commit -m "feat: collect and store site preview drafts"
```

---

### Task 4: 增加官网内容页预览操作

**Files:**
- Modify: `apps/admin/src/pages/SiteContentPage.vue`
- Modify: `apps/admin/src/styles/admin.css`
- Test: `apps/admin/src/pages/__tests__/SiteContentPage.test.js`

**Interfaces:**
- Consumes: Task 2 `POST /api/admin/site-preview/:kind`
- Consumes: Task 3 child `getPreviewDraft`, `getSavedPreviewPath`, `createPreviewSnapshot`
- Produces UI actions: `preview-saved-site`, `preview-site-draft`

- [ ] **Step 1: Write failing page interaction tests**

```js
test("opens saved and draft previews for the active homepage tab", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue({ location: { href: "" } });
  await wrapper.get('[data-action="preview-saved-site"]').trigger("click");
  expect(open).toHaveBeenCalledWith("/", "_blank", "noopener");

  await wrapper.get('[data-action="preview-site-draft"]').trigger("click");
  expect(api).toHaveBeenCalledWith("/api/admin/site-preview/homepage", expect.objectContaining({ method: "POST" }));
  expect(open).toHaveBeenLastCalledWith(expect.stringMatching(/^\/preview\?token=/), "_blank", "noopener");
  expect(api).not.toHaveBeenCalledWith("/api/admin/site-settings", expect.objectContaining({ method: "PATCH" }));
});

test("disables contextual preview until an event or content is selected", async () => {
  await activateTab(wrapper, "events");
  expect(wrapper.get('[data-action="preview-site-draft"]').attributes("disabled")).toBeDefined();
  expect(wrapper.get('[data-preview-help]').text()).toContain("请先选择赛事");
});
```

Also test API validation errors, `localStorage.setItem` errors, and `window.open()` returning `null`.

- [ ] **Step 2: Run the page test and observe missing buttons**

Run: `npm test -w apps/admin -- --run apps/admin/src/pages/__tests__/SiteContentPage.test.js`

Expected: FAIL because `[data-action="preview-saved-site"]` does not exist.

- [ ] **Step 3: Implement contextual preview actions**

Keep refs for all three child panels and select the active one:

```js
const siteSettingsPanel = ref(null);
const eventProfilePanel = ref(null);

const activePreviewPanel = computed(() => activeTab.value === "homepage"
  ? siteSettingsPanel.value
  : activeTab.value === "events"
    ? eventProfilePanel.value
    : contentEditor.value);

async function previewDraft() {
  previewError.value = "";
  const draft = activePreviewPanel.value?.getPreviewDraft?.();
  if (!draft) return;
  const popup = window.open("about:blank", "_blank", "noopener");
  try {
    const response = await api(`/api/admin/site-preview/${draft.kind}`, {
      method: "POST",
      body: JSON.stringify(draft.body)
    });
    const snapshot = createPreviewSnapshot({
      kind: draft.kind,
      payload: response.preview.payload,
      context: response.preview.context
    });
    if (popup) popup.location.href = snapshot.url;
    else blockedPreviewUrl.value = snapshot.url;
  } catch (failure) {
    popup?.close?.();
    previewError.value = failure?.message || "草稿预览生成失败";
  }
}
```

Render both actions beside Refresh, show disabled help text, error alerts and a clickable fallback when popup is blocked. Use normal links/buttons with visible focus styles.

- [ ] **Step 4: Add responsive action styling**

Add `.site-preview-actions`, `.site-preview-help` and mobile wrapping rules under the existing `.site-content-page` styles. At 360px, buttons wrap to full-width rows without horizontal overflow.

- [ ] **Step 5: Run focused admin tests**

Run: `npm test -w apps/admin -- --run apps/admin/src/pages/__tests__/SiteContentPage.test.js`

Expected: PASS, including no save/publish API calls during preview.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/pages/SiteContentPage.vue apps/admin/src/styles/admin.css apps/admin/src/pages/__tests__/SiteContentPage.test.js
git commit -m "feat: add site preview actions to admin"
```

---

### Task 5: 增加公共端快照读取与预览路由

**Files:**
- Create: `apps/web/src/preview/storage.js`
- Create: `apps/web/src/pages/PreviewPage.jsx`
- Create: `apps/web/src/__tests__/PreviewPage.test.jsx`
- Modify: `apps/web/src/router.js`
- Modify: `apps/web/src/App.jsx`
- Modify: `apps/web/src/components/Seo.jsx`
- Test: `apps/web/src/__tests__/router.test.jsx`

**Interfaces:**
- Produces: `readPreviewSnapshot(token, { now = Date.now(), storage = localStorage }) -> { ok: true, snapshot } | { ok: false, reason }`
- Produces route: `matchRoute('/preview') -> { name: 'preview', params: {} }`
- Produces component: `<PreviewPage location={location} />`

- [ ] **Step 1: Write failing storage and routing tests**

```js
test("reads a valid same-browser snapshot and removes an expired one", () => {
  const storage = memoryStorageWith(validSnapshot({ expiresAt: 901_000 }));
  expect(readPreviewSnapshot("token", { now: 900_000, storage }).ok).toBe(true);
  expect(readPreviewSnapshot("token", { now: 901_001, storage })).toEqual({ ok: false, reason: "expired" });
  expect(storage.getItem(`${PREVIEW_STORAGE_PREFIX}token`)).toBeNull();
});

test("router recognizes only the fixed preview path", () => {
  expect(matchRoute("/preview")).toEqual({ name: "preview", params: {} });
  expect(matchRoute("/preview/extra").name).toBe("not-found");
});
```

- [ ] **Step 2: Run tests to verify missing preview support**

Run: `npm test -w apps/web -- --run apps/web/src/__tests__/router.test.jsx apps/web/src/__tests__/PreviewPage.test.jsx`

Expected: FAIL because storage module and preview route do not exist.

- [ ] **Step 3: Implement strict snapshot reader**

```js
export function readPreviewSnapshot(token, { now = Date.now(), storage = localStorage } = {}) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ""))) return { ok: false, reason: "invalid" };
  const key = `${PREVIEW_STORAGE_PREFIX}${token}`;
  let snapshot;
  try { snapshot = JSON.parse(storage.getItem(key) || "null"); }
  catch { storage.removeItem(key); return { ok: false, reason: "invalid" }; }
  if (!snapshot || snapshot.version !== 1 || snapshot.token !== token || !["homepage", "event", "content"].includes(snapshot.kind)) {
    return { ok: false, reason: "invalid" };
  }
  if (!Number.isFinite(snapshot.expiresAt) || snapshot.expiresAt <= now) {
    storage.removeItem(key);
    return { ok: false, reason: "expired" };
  }
  return { ok: true, snapshot };
}
```

- [ ] **Step 4: Add preview route without normal bootstrap dependency**

Return `{ name: "preview" }` from `matchRoute`. In `App.jsx`, render `<PreviewPage location={location} />` before the normal home/bootstrap branch. The preview route may still show the shared site header/footer using snapshot site data, but must not wait for `/api/public/home` to display the preview body.

Extend `Seo` with an explicit robots prop:

```jsx
<Seo title="草稿预览" description="管理员草稿预览" robots="noindex, nofollow" />
```

- [ ] **Step 5: Implement preview status and errors**

`PreviewPage` parses exactly one `token` query parameter, calls `readPreviewSnapshot`, displays the fixed status bar, and dispatches by kind. Invalid and expired states use these messages:

```jsx
const messages = {
  invalid: ["预览链接无效", "请返回管理后台重新生成预览。"],
  expired: ["预览已过期", "草稿预览有效期为 15 分钟，请返回后台重新生成。"]
};
```

The return link uses `snapshot.adminReturnPath || "/admin/"`, `data-router-ignore="true"`, and does not expose the token.

- [ ] **Step 6: Run focused web tests**

Run: `npm test -w apps/web -- --run apps/web/src/__tests__/router.test.jsx apps/web/src/__tests__/PreviewPage.test.jsx`

Expected: PASS for valid, invalid, duplicate-token, malformed, wrong-version and expired cases.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/preview/storage.js apps/web/src/pages/PreviewPage.jsx apps/web/src/components/Seo.jsx apps/web/src/router.js apps/web/src/App.jsx apps/web/src/__tests__/router.test.jsx apps/web/src/__tests__/PreviewPage.test.jsx
git commit -m "feat: add browser-local public preview route"
```

---

### Task 6: 复用正式页面展示组件

**Files:**
- Modify: `apps/web/src/pages/HomePage.jsx`
- Modify: `apps/web/src/pages/EventDetailPage.jsx`
- Modify: `apps/web/src/pages/ContentDetailPage.jsx`
- Modify: `apps/web/src/pages/PreviewPage.jsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/__tests__/PreviewPage.test.jsx`
- Test: `apps/web/src/__tests__/HomePage.test.jsx`
- Test: `apps/web/src/__tests__/PublicPages.test.jsx`
- Test: `apps/web/src/__tests__/Accessibility.test.jsx`

**Interfaces:**
- Produces: `<EventDetailView payload />`
- Produces: `<ContentDetailView row />`
- Consumes: existing `<HomePage data />`

- [ ] **Step 1: Write failing component-reuse tests**

```jsx
test.each([
  ["homepage", "尚未保存的平台简介"],
  ["event", "尚未保存的赛事宣传语"],
  ["content", "尚未保存的正文"]
])("renders %s snapshot through the public view", async (kind, expectedText) => {
  seedPreviewSnapshot(kind);
  renderAt(`/preview?token=${token}`);
  expect(await screen.findByText(expectedText)).toBeInTheDocument();
  expect(screen.getByText("草稿预览 · 未保存 · 仅当前浏览器可见")).toBeInTheDocument();
  expect(document.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
});
```

Add a regression assertion that official `/events/:slug` and `/content/:slug` still fetch their public APIs.

- [ ] **Step 2: Run tests and observe event/content preview gaps**

Run: `npm test -w apps/web -- --run apps/web/src/__tests__/PreviewPage.test.jsx apps/web/src/__tests__/PublicPages.test.jsx`

Expected: FAIL because detail pages own their network loading and cannot yet receive preview data.

- [ ] **Step 3: Extract display-only detail components**

In `EventDetailPage.jsx`, extract the code beginning with `const payload = state.data || {};` through the complete event-detail JSX return into `export function EventDetailView({ payload = {}, preview = false })`. Keep `ResourceNotFound`, `EventContent`, `SAFE_EVENT_ID`, every event section and every registration/result/certificate URL unchanged. The default component keeps its existing fetch effects, 404 handling and `AsyncState`, and its successful child becomes exactly `<EventDetailView payload={state.data || {}} />`. Move the event `<Seo>` into the view and omit its canonical pathname when `preview` is true.

In `ContentDetailPage.jsx`, extract `formatDate`, the rich-body anchor/image normalization effect, heading, metadata, rich HTML and attachment markup into `export function ContentDetailView({ row, preview = false })`. The default component keeps its existing fetch effects, 404 handling and `AsyncState`, and its successful child becomes exactly `{state.row ? <ContentDetailView row={state.row} /> : null}`. `ContentDetailView` owns `bodyRef`, keys its safety effect by `row?.bodyHtml`, preserves all current text and class names, and omits the canonical pathname when `preview` is true.

`PreviewPage` imports `HomePage`, `EventDetailView`, and `ContentDetailView` and passes `snapshot.payload` directly.
}
```

`PreviewPage` imports `HomePage`, `EventDetailView`, and `ContentDetailView` and passes `snapshot.payload` directly.

- [ ] **Step 4: Add preview-only visual treatment**

Add `.preview-banner`, `.preview-page`, `.preview-error` and mobile rules. The banner must remain visible, not cover focus targets, meet contrast requirements and wrap at 360px. Respect `prefers-reduced-motion` and do not add animation.

- [ ] **Step 5: Run web regression and accessibility tests**

Run: `npm test -w apps/web -- --run apps/web/src/__tests__/PreviewPage.test.jsx apps/web/src/__tests__/HomePage.test.jsx apps/web/src/__tests__/PublicPages.test.jsx apps/web/src/__tests__/Accessibility.test.jsx`

Expected: PASS; formal routes still fetch, preview routes do not fetch formal detail APIs, and all three preview types render shared markup.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/HomePage.jsx apps/web/src/pages/EventDetailPage.jsx apps/web/src/pages/ContentDetailPage.jsx apps/web/src/pages/PreviewPage.jsx apps/web/src/styles.css apps/web/src/__tests__/PreviewPage.test.jsx apps/web/src/__tests__/HomePage.test.jsx apps/web/src/__tests__/PublicPages.test.jsx apps/web/src/__tests__/Accessibility.test.jsx
git commit -m "refactor: reuse public pages for draft previews"
```

---

### Task 7: 全量验证、构建与人工验收

**Files:**
- Modify only if a regression is found: files from Tasks 1–6 and their matching tests
- Verify: `docs/superpowers/specs/2026-07-22-site-preview-design.md`

**Interfaces:**
- Consumes all previous task interfaces.
- Produces a deployable branch with no database migration and no preview persistence.

- [ ] **Step 1: Run all admin tests**

Run: `npm test -w apps/admin`

Expected: 23 test files and at least 185 existing tests plus new preview tests PASS.

- [ ] **Step 2: Run all public web tests**

Run: `npm test -w apps/web -- --run`

Expected: all existing 103 tests plus new preview tests PASS.

- [ ] **Step 3: Run API preview and regression tests**

Run: `node --test apps/api/test/site-preview.test.js apps/api/test/site-media.test.js apps/api/test/public-site-service.test.js apps/api/test/public-site-routes.test.js`

Expected: PASS. If the WSL worktree again exceeds the existing 5-second child-server startup limit, run the same command in the established Windows project shell and record that environment result; do not increase production timeouts merely to mask filesystem latency.

- [ ] **Step 4: Build both frontends**

Run: `npm run build`

Expected: React public site and Vue admin production builds complete with exit code 0 and no unresolved imports.

- [ ] **Step 5: Verify no persistence or public contamination**

Using a test database snapshot, generate homepage, event and content previews, then verify:

```js
assert.deepEqual(afterDb, beforeDb);
assert.equal((await publicClient.get("/api/public/home")).body, publicHomeBefore);
assert.equal(sitemapText.includes("/preview"), false);
```

Expected: database, public lists and sitemap remain unchanged.

- [ ] **Step 6: Perform browser checks at required widths**

At 360px, 768px and 1440px verify:

- both admin buttons are visible and keyboard reachable;
- homepage/event/content unsaved edits appear in preview;
- banner, expiry and return link are visible;
- private media either loads with admin session or shows the explicit placeholder;
- expired token shows the expiry recovery message;
- saved preview opens the formal route;
- popup-blocked fallback link opens successfully.

- [ ] **Step 7: Check diff hygiene**

Run: `git diff --check && git status --short && git log --oneline --decorate -8`

Expected: no whitespace errors; only intentional source/test/docs changes; `package-lock.json` peer-marker changes caused solely by local npm version are excluded from commits.

- [ ] **Step 8: Record final verification**

If Steps 1–7 require a correction, amend the matching task commit only after rerunning that task’s exact focused test command. If no correction is required, do not create an empty commit. Record the passing test counts, build result, browser widths and unchanged-database assertion in the task handoff.

