# 官网内容富文本与正文媒体完善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将后台内容发布页升级为可靠的文章编辑器，支持完整常用格式、正文图片上传/媒体库选择/说明编辑，并保证正文图片从草稿到发布、公开访问和删除保护的数据链路完整。

**Architecture:** 管理端使用 TipTap 管理编辑器状态，并用自定义正文图片节点将编辑态的管理员预览 URL 与持久化的公开 URL 分离。API 通过统一的正文媒体提取与校验服务识别 `bodyHtml` 中的媒体 ID，在保存、预览、发布和删除媒体时复用同一规则；数据库继续保存现有 HTML，不增加迁移。

**Tech Stack:** Vue 3、TipTap/ProseMirror、Vite、Vitest、Express、PostgreSQL、sanitize-html、Docker Compose。

## Global Constraints

- 正文继续以经过清理的 `bodyHtml` 保存，不改变数据库正文结构，不迁移已有文章。
- 只支持 PNG、JPEG、WebP 正文图片；不支持视频、音频、外部图片、Data URL、SVG 或任意嵌入。
- 工具栏仅包含段落、H2、H3、粗体、斜体、有序/无序列表、引用、链接、撤销/重做、清除格式和图片。
- 保持手动保存草稿、未保存提示和离开确认，不增加自动保存。
- 已发布内容保持只读，必须先下线再编辑。
- 正文图片持久化为本站 `/api/public/media/:id` 地址；草稿编辑预览使用管理员受保护接口。
- 管理 API 不返回 `filePath`、`storedName`、数据库连接信息或服务器目录。
- 所有行为变更先写失败测试并确认 RED，再写最小实现并确认 GREEN。
- 生产部署前必须备份数据库、上传卷和源码；API 与 Web 必须在同一发布窗口更新。

---

## 文件结构

### API

- Create: `apps/api/src/services/content-body-media.js`  
  负责从服务器清理后的 HTML 提取正文媒体 ID、校验媒体存在性/类型、返回正文媒体行。
- Modify: `apps/api/src/services/site-admin.js`  
  在内容创建、更新、发布时校验正文图片，并在发布时提升正文媒体公开状态。
- Modify: `apps/api/src/services/site-preview.js`  
  草稿预览使用与保存一致的正文媒体校验，但不持久化和不提升媒体状态。
- Modify: `apps/api/src/services/site-media.js`  
  将正文 HTML 纳入媒体引用保护。
- Modify: `apps/api/src/routes/site-media.js`  
  增加管理员媒体列表接口。
- Test: `apps/api/test/content-body-media.test.js`
- Test: `apps/api/test/site-admin.test.js`
- Test: `apps/api/test/site-preview.test.js`
- Test: `apps/api/test/site-media.test.js`

### 管理端

- Modify: `apps/admin/package.json`
- Modify: `package-lock.json`
- Create: `apps/admin/src/lib/content-image-extension.js`  
  TipTap 自定义 `figure/img/figcaption` 节点与 HTML 解析/序列化规则。
- Create: `apps/admin/src/components/ContentImageView.vue`  
  编辑态使用管理员预览 URL，提供选中态与图片说明展示。
- Create: `apps/admin/src/components/ContentImageDialog.vue`  
  上传新图片、查询已有媒体、搜索、填写 alt/caption 并返回选择结果。
- Rewrite: `apps/admin/src/components/RichTextEditor.vue`  
  TipTap 编辑器、工具栏、HTML/纯文本修复模式、图片对话框和版本同步。
- Modify: `apps/admin/src/components/ContentEditorPanel.vue`  
  接收正文媒体错误/提示，保持保存状态与正文焦点定位。
- Modify: `apps/admin/src/styles/admin.css`
- Test: `apps/admin/src/components/__tests__/RichTextEditor.test.js`
- Create: `apps/admin/src/components/__tests__/ContentImageDialog.test.js`
- Modify: `apps/admin/src/components/__tests__/ContentEditorPanel.test.js`
- Modify: `apps/admin/src/pages/__tests__/SiteContentPage.test.js`

### 官网

- Modify: `apps/web/src/styles/content.css`
- Modify: `apps/web/src/__tests__/PublicPages.test.jsx`

---

### Task 1: 正文媒体提取、校验、发布与引用保护

**Files:**
- Create: `apps/api/src/services/content-body-media.js`
- Modify: `apps/api/src/services/site-admin.js`
- Modify: `apps/api/src/services/site-preview.js`
- Modify: `apps/api/src/services/site-media.js`
- Create: `apps/api/test/content-body-media.test.js`
- Modify: `apps/api/test/site-admin.test.js`
- Modify: `apps/api/test/site-preview.test.js`
- Modify: `apps/api/test/site-media.test.js`

**Interfaces:**
- Produces: `contentBodyMediaIds(html: string): string[]`
- Produces: `contentBodyMedia(db, html, { label?: string }): MediaAsset[]`
- Consumes: `sanitizeContentHtml(html)` and `promoteMedia(db, ids)`
- Later tasks rely on `GET /api/admin/site-media` returning rows compatible with these media assets.

- [ ] **Step 1: Write failing extraction and validation tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { contentBodyMedia, contentBodyMediaIds } from "../src/services/content-body-media.js";

test("extracts unique media ids from sanitized body html in document order", () => {
  assert.deepEqual(contentBodyMediaIds([
    '<p>开头</p><img src="/api/public/media/M2" alt="二">',
    '<figure><img src="/api/public/media/M1"><figcaption>一</figcaption></figure>',
    '<img src="/api/public/media/M2">'
  ].join("")), ["M2", "M1"]);
});

test("rejects missing and non-image body media", () => {
  const db = { mediaAssets: [
    { id: "PDF", mimeType: "application/pdf", cleanedAt: null }
  ] };
  assert.throws(
    () => contentBodyMedia(db, '<img src="/api/public/media/MISSING">'),
    (error) => error.status === 422 && error.code === "CONTENT_BODY_MEDIA_INVALID"
  );
  assert.throws(
    () => contentBodyMedia(db, '<img src="/api/public/media/PDF">'),
    (error) => error.status === 422 && error.code === "CONTENT_BODY_MEDIA_INVALID"
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/content-body-media.test.js
```

Expected: FAIL because `content-body-media.js` does not exist.

- [ ] **Step 3: Implement the minimal shared service**

```js
import { sanitizeContentHtml } from "../content/sanitize.js";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PUBLIC_MEDIA = /\/api\/public\/media\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;

export function contentBodyMediaIds(html) {
  const ids = [];
  const seen = new Set();
  for (const match of sanitizeContentHtml(html).matchAll(PUBLIC_MEDIA)) {
    const id = match[1];
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

export function contentBodyMedia(db, html, { label = "正文图片" } = {}) {
  return contentBodyMediaIds(html).map((id) => {
    const media = (db.mediaAssets || []).find((row) => row.id === id && !row.cleanedAt);
    if (!media || !IMAGE_MIME_TYPES.has(media.mimeType)) {
      const error = new Error(`${label}不存在、已失效或不是支持的图片`);
      error.status = 422;
      error.code = "CONTENT_BODY_MEDIA_INVALID";
      throw error;
    }
    return media;
  });
}
```

- [ ] **Step 4: Verify the shared service GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Write failing integration tests**

Add assertions that:

```js
test("publishing content promotes body images together with cover and attachments", () => {
  const draft = createContent({
    bodyHtml: '<figure><img src="/api/public/media/BODY" alt="现场"></figure>'
  });
  publishContent(draft.id);
  assert.equal(db.mediaAssets.find((row) => row.id === "BODY").visibility, "public");
});

test("saving and previewing reject a missing body image without changing media visibility", () => {
  const before = structuredClone(db.mediaAssets);
  for (const operation of [
    () => createContent({ bodyHtml: '<img src="/api/public/media/MISSING">' }),
    () => updateContent("POST1", { bodyHtml: '<img src="/api/public/media/MISSING">' }),
    () => previewContent({ bodyHtml: '<img src="/api/public/media/MISSING">' })
  ]) {
    assert.throws(operation, (error) => (
      error.status === 422 && error.code === "CONTENT_BODY_MEDIA_INVALID"
    ));
  }
  assert.deepEqual(db.mediaAssets, before);
});

test("body references prevent media deletion until the reference is removed", () => {
  db.contentPosts[0].bodyHtml = '<img src="/api/public/media/BODY">';
  assert.equal(mediaReference(db, "BODY"), "文章正文");
  assert.throws(() => deleteMedia(db, "BODY"), (error) => (
    error.status === 409 && error.code === "MEDIA_IN_USE"
  ));
  db.contentPosts[0].bodyHtml = "<p>已移除图片</p>";
  assert.equal(deleteMedia(db, "BODY").id, "BODY");
});
```

- [ ] **Step 6: Run integration tests and verify RED**

Run:

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/site-admin.test.js test/site-preview.test.js test/site-media.test.js
```

Expected: FAIL because body media are not validated, promoted, or protected.

- [ ] **Step 7: Integrate the shared service**

In `site-admin.js`:

```js
contentBodyMedia(db, row.bodyHtml);
if (nextStatus === "published") {
  promoteMedia(db, contentBodyMediaIds(bodyHtml));
}
```

Call validation from content creation and update candidates after `bodyHtml` is normalized. In `site-preview.js`, validate the sanitized preview body without persisting or promoting. In `site-media.js`, add:

```js
if ((db.contentPosts || []).some((post) => contentBodyMediaIds(post.bodyHtml).includes(mediaId))) {
  return "文章正文";
}
```

- [ ] **Step 8: Verify integration GREEN and run API regression**

Run:

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/content-body-media.test.js test/site-admin.test.js test/site-preview.test.js test/site-media.test.js
npm.cmd test -w apps/api -- --test-concurrency=1
```

Expected: focused tests PASS; full API suite PASS.

- [ ] **Step 9: Commit**

```powershell
git add apps/api/src/services/content-body-media.js apps/api/src/services/site-admin.js apps/api/src/services/site-preview.js apps/api/src/services/site-media.js apps/api/test/content-body-media.test.js apps/api/test/site-admin.test.js apps/api/test/site-preview.test.js apps/api/test/site-media.test.js
git commit -m "feat: track body media through content publication"
```

---

### Task 2: 管理员图片媒体库接口

**Files:**
- Modify: `apps/api/src/routes/site-media.js`
- Modify: `apps/api/test/site-media.test.js`

**Interfaces:**
- Produces: `GET /api/admin/site-media?kind=image&limit=100&q=`
- Response: `{ rows: Array<{ id, eventId, purpose, visibility, originalName, mimeType, sizeBytes, width, height, createdAt, previewUrl }> }`
- Must never return `filePath`, `storedName`, `variants`, or cleanup paths.

- [ ] **Step 1: Write failing route tests**

```js
test("admin lists recent image media without storage fields", async () => {
  const response = await fetch(`${baseUrl}/api/admin/site-media?kind=image&limit=2&q=hero`, adminSession);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.rows.map((row) => row.id), ["M-NEW", "M-OLD"]);
  assert.equal(payload.rows.every((row) => row.mimeType.startsWith("image/")), true);
  assert.equal(payload.rows.every((row) => !("filePath" in row) && !("storedName" in row)), true);
  assert.equal(payload.rows[0].previewUrl, "/api/admin/site-media/M-NEW/preview");
});

test("media listing requires a ready administrator and validates limit", async () => {
  assert.equal((await fetch(`${baseUrl}/api/admin/site-media`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/admin/site-media?limit=101`, adminSession)).status, 422);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/site-media.test.js
```

Expected: FAIL with 404 or method mismatch for the list route.

- [ ] **Step 3: Implement the list route**

Add the route before `/:id/preview`:

```js
router.get("/admin/site-media", ...admin, asyncRoute(async (req, res) => {
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw routeError(422, "媒体数量范围为 1 至 100");
  const kind = String(req.query.kind || "").trim();
  if (kind && kind !== "image") throw routeError(422, "媒体类型筛选无效");
  const query = String(req.query.q || "").trim().toLowerCase();
  const db = await store.readDb();
  const rows = (db.mediaAssets || [])
    .filter((row) => !row.cleanedAt)
    .filter((row) => kind !== "image" || ["image/png", "image/jpeg", "image/webp"].includes(row.mimeType))
    .filter((row) => !query || [row.id, row.originalName].some((value) => String(value || "").toLowerCase().includes(query)))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || right.id.localeCompare(left.id))
    .slice(0, limit)
    .map(({ id, eventId, purpose, visibility, originalName, mimeType, sizeBytes, width, height, createdAt }) => ({
      id, eventId, purpose, visibility, originalName, mimeType, sizeBytes, width, height, createdAt,
      previewUrl: `/api/admin/site-media/${encodeURIComponent(id)}/preview`
    }));
  res.json({ rows });
}));
```

- [ ] **Step 4: Verify GREEN and run authorization regression**

Run:

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/site-media.test.js test/authorization.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/routes/site-media.js apps/api/test/site-media.test.js
git commit -m "feat: list administrator image media"
```

---

### Task 3: TipTap 编辑器核心与格式工具栏

**Files:**
- Modify: `apps/admin/package.json`
- Modify: `package-lock.json`
- Rewrite: `apps/admin/src/components/RichTextEditor.vue`
- Modify: `apps/admin/src/components/__tests__/RichTextEditor.test.js`
- Modify: `apps/admin/src/lib/rich-text.js`

**Interfaces:**
- `RichTextEditor` props remain `modelValue`, `disabled`, `revision`.
- Emits remain `update:modelValue` and `normalized`; add `notice`.
- Expose `editor` in tests with `defineExpose({ editor })`; production callers continue to use props and emits.
- Image support is introduced in Task 4; Task 3 reserves a tested `open-image-dialog` toolbar event hook that Task 4 connects to the dialog.

- [ ] **Step 1: Install pinned editor dependencies**

Run:

```powershell
npm.cmd install -w apps/admin @tiptap/core @tiptap/pm @tiptap/vue-3 @tiptap/starter-kit @tiptap/extension-link
```

Expected: `apps/admin/package.json` and `package-lock.json` record exact resolved versions.

- [ ] **Step 2: Replace old toolbar tests with failing behavior tests**

Tests must assert real editor output:

```js
it("formats the selected text without losing the selection to the toolbar", async () => {
  const wrapper = mount(RichTextEditor, { attachTo: document.body, props: { modelValue: "<p>正文内容</p>" } });
  wrapper.vm.editor.commands.setTextSelection({ from: 1, to: 3 });
  await wrapper.get('[data-command="bold"]').trigger("mousedown");
  await wrapper.get('[data-command="bold"]').trigger("click");
  expect(wrapper.emitted("update:modelValue").at(-1)[0]).toContain("<strong>正文</strong>");
});

it("supports paragraph h2 h3 lists quote links undo redo and clear formatting", async () => {
  const wrapper = mount(RichTextEditor, { attachTo: document.body, props: { modelValue: "<p>正文</p>" } });
  const commands = ["heading-2", "heading-3", "paragraph", "bullet-list", "ordered-list", "blockquote"];
  for (const command of commands) {
    wrapper.vm.editor.commands.selectAll();
    await wrapper.get(`[data-command="${command}"]`).trigger("click");
    expect(wrapper.get(`[data-command="${command}"]`).attributes("aria-pressed")).toBe("true");
  }
  await wrapper.get('[data-command="undo"]').trigger("click");
  expect(wrapper.get('[data-command="redo"]').attributes("disabled")).toBeUndefined();
  await wrapper.get('[data-command="clear-formatting"]').trigger("click");
  expect(wrapper.emitted("update:modelValue").at(-1)[0]).toContain("<p>");
});

it("keeps the document and selection during same-revision parent writeback", async () => {
  const wrapper = mount(RichTextEditor, {
    props: { modelValue: "<p>初始正文</p>", revision: 3 }
  });
  const editor = wrapper.vm.editor;
  editor.commands.setTextSelection(3);
  editor.commands.insertContent("新增");
  const emittedHtml = wrapper.emitted("update:modelValue").at(-1)[0];
  const selection = { ...editor.state.selection };
  await wrapper.setProps({ modelValue: emittedHtml, revision: 3 });
  expect(wrapper.vm.editor).toBe(editor);
  expect(wrapper.vm.editor.state.selection.from).toBe(selection.from);
  expect(wrapper.vm.editor.getHTML()).toBe(emittedHtml);
});
```

- [ ] **Step 3: Run editor tests and verify RED**

Run:

```powershell
npm.cmd test -w apps/admin -- src/components/__tests__/RichTextEditor.test.js
```

Expected: FAIL because the current editor has no TipTap instance, stable commands, active states, undo/redo, or clear formatting.

- [ ] **Step 4: Implement TipTap editor core**

Use `useEditor` with:

```js
StarterKit.configure({
  heading: { levels: [2, 3] },
  code: false,
  codeBlock: false,
  horizontalRule: false
}),
Link.configure({ openOnClick: false, autolink: false, protocols: ["http", "https", "mailto"] })
```

Create toolbar command definitions with stable `data-command` attributes. Use `@mousedown.prevent` so the toolbar does not move the DOM selection. Emit sanitized HTML from TipTap `onUpdate`. Watch `modelValue` and `revision` so:

- a new revision always calls `editor.commands.setContent(safe, false)`;
- same-revision parent writeback equal to the last emitted value does not replace content;
- disabled state calls `editor.setEditable(false)`.

Keep HTML and plain-text repair buffers. Switching back to visual mode calls `setContent(sanitizeEditorHtml(buffer), true)`.

- [ ] **Step 5: Extend the client sanitizer only for the selected schema**

Keep allowed tags aligned with the server. Preserve `figure`, `img[src,alt]`, `figcaption`, H2/H3, lists, blockquote and links. Reject external image paths and dangerous attributes exactly as before.

- [ ] **Step 6: Verify GREEN and run related admin tests**

Run:

```powershell
npm.cmd test -w apps/admin -- src/components/__tests__/RichTextEditor.test.js src/components/__tests__/ContentEditorPanel.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/admin/package.json package-lock.json apps/admin/src/components/RichTextEditor.vue apps/admin/src/components/__tests__/RichTextEditor.test.js apps/admin/src/lib/rich-text.js
git commit -m "feat: replace content editor with tiptap"
```

---

### Task 4: 正文图片上传、媒体库选择与自定义图片节点

**Files:**
- Create: `apps/admin/src/lib/content-image-extension.js`
- Create: `apps/admin/src/components/ContentImageView.vue`
- Create: `apps/admin/src/components/ContentImageDialog.vue`
- Modify: `apps/admin/src/components/RichTextEditor.vue`
- Create: `apps/admin/src/components/__tests__/ContentImageDialog.test.js`
- Modify: `apps/admin/src/components/__tests__/RichTextEditor.test.js`

**Interfaces:**
- `ContentImageDialog` props: `open: boolean`, `initial?: { mediaId, alt, caption }`, `disabled?: boolean`
- Emits: `close`, `select({ media, alt, caption })`, `error(error)`
- TipTap node attrs: `{ mediaId: string, alt: string, caption: string }`
- Persisted HTML: `<figure><img src="/api/public/media/:id" alt=""><figcaption>...</figcaption></figure>`
- `RichTextEditor` test-only exposed methods: `insertContentImage`, `updateSelectedContentImage`, `removeSelectedContentImage`; each delegates to TipTap commands and keeps the production component API event-driven.

- [ ] **Step 1: Write failing image dialog tests**

```js
it("lists and searches existing image media without exposing storage fields", async () => {
  apiMock.mockResolvedValueOnce({ rows: [{ id: "M1", originalName: "飞行.png", previewUrl: "/api/admin/site-media/M1/preview" }] });
  const wrapper = mount(ContentImageDialog, { props: { open: true } });
  await flushPromises();
  expect(apiMock).toHaveBeenCalledWith("/api/admin/site-media?kind=image&limit=100&q=");
  expect(wrapper.get('[data-media-id="M1"] img').attributes("src")).toBe("/api/admin/site-media/M1/preview");
});

it("uploads an image and emits the chosen media with alt and caption", async () => {
  const wrapper = mount(ContentImageDialog, { props: { open: true } });
  const file = new File(["png"], "现场.png", { type: "image/png" });
  await wrapper.get('input[type="file"]').trigger("change", { target: { files: [file] } });
  await flushPromises();
  await wrapper.get('[data-field="image-alt"]').setValue("飞行器");
  await wrapper.get('[data-field="image-caption"]').setValue("比赛现场");
  await wrapper.get('[data-action="confirm-image"]').trigger("click");
  expect(wrapper.emitted("select")[0][0]).toEqual({
    media: expect.objectContaining({ id: "M-UPLOADED" }),
    alt: "飞行器",
    caption: "比赛现场"
  });
});

it("keeps the dialog open and preserves fields after list or upload errors", async () => {
  apiMock.mockRejectedValueOnce(new Error("网络错误"));
  const wrapper = mount(ContentImageDialog, {
    props: { open: true, initial: { mediaId: "", alt: "原说明", caption: "原题注" } }
  });
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("网络错误");
  expect(wrapper.get('[data-field="image-alt"]').element.value).toBe("原说明");
  expect(wrapper.get('[data-field="image-caption"]').element.value).toBe("原题注");
  expect(wrapper.get('[data-action="retry-media"]').exists()).toBe(true);
});
```

- [ ] **Step 2: Write failing image-node tests**

```js
it("serializes a selected media item as canonical public figure html", async () => {
  wrapper.vm.editor.commands.setTextSelection(3);
  await wrapper.vm.insertContentImage({ media: { id: "M1" }, alt: "飞行器", caption: "比赛现场" });
  expect(wrapper.emitted("update:modelValue").at(-1)[0]).toContain(
    '<figure><img src="/api/public/media/M1" alt="飞行器"><figcaption>比赛现场</figcaption></figure>'
  );
});

it("edits replaces and removes the selected content image", async () => {
  const wrapper = mount(RichTextEditor, {
    props: {
      modelValue: '<figure><img src="/api/public/media/M1" alt="旧"><figcaption>旧题注</figcaption></figure>'
    }
  });
  wrapper.vm.editor.commands.setNodeSelection(0);
  wrapper.vm.updateSelectedContentImage({ media: { id: "M2" }, alt: "新", caption: "新题注" });
  expect(wrapper.vm.editor.getHTML()).toContain('/api/public/media/M2');
  expect(wrapper.vm.editor.getHTML()).toContain("新题注");
  wrapper.vm.removeSelectedContentImage();
  expect(wrapper.vm.editor.getHTML()).not.toContain("<figure");
});

it("inserts at the saved selection or appends with a notice when the selection is invalid", async () => {
  const wrapper = mount(RichTextEditor, { props: { modelValue: "<p>甲乙</p>" } });
  wrapper.vm.editor.commands.setTextSelection(2);
  await wrapper.get('[data-command="image"]').trigger("click");
  wrapper.vm.insertContentImage({ media: { id: "M1" }, alt: "", caption: "" });
  expect(wrapper.vm.editor.getHTML().indexOf("M1")).toBeLessThan(wrapper.vm.editor.getHTML().indexOf("乙"));
  wrapper.vm.editor.commands.clearContent();
  wrapper.vm.insertContentImage({ media: { id: "M2" }, alt: "", caption: "" });
  expect(wrapper.vm.editor.getHTML()).toContain("/api/public/media/M2");
  expect(wrapper.emitted("notice").at(-1)[0]).toContain("已插入到正文末尾");
});
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
npm.cmd test -w apps/admin -- src/components/__tests__/ContentImageDialog.test.js src/components/__tests__/RichTextEditor.test.js
```

Expected: FAIL because the dialog, node extension and image commands do not exist.

- [ ] **Step 4: Implement the TipTap content-image node**

Create a custom block atom node:

```js
export const ContentImage = Node.create({
  name: "contentImage",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      mediaId: { default: "" },
      alt: { default: "" },
      caption: { default: "" }
    };
  },
  parseHTML() {
    return [{ tag: "figure", getAttrs: parsePublicMediaFigure }];
  },
  renderHTML({ node }) {
    const img = ["img", { src: `/api/public/media/${encodeURIComponent(node.attrs.mediaId)}`, alt: node.attrs.alt || "" }];
    return node.attrs.caption
      ? ["figure", {}, img, ["figcaption", {}, node.attrs.caption]]
      : ["figure", {}, img];
  },
  addNodeView() {
    return VueNodeViewRenderer(ContentImageView);
  }
});
```

The NodeView renders `/api/admin/site-media/:id/preview`, never the public URL, while editing.

- [ ] **Step 5: Implement the dialog**

`ContentImageDialog.vue`:

- fetches the list only when opened;
- URL-encodes `q`;
- uses `MediaPicker purpose="content-body"` for uploads;
- shows only API-provided preview URLs;
- stores `selectedMedia`, `alt`, and `caption`;
- disables confirm until a media row is selected;
- restores focus to the image toolbar button after close.

- [ ] **Step 6: Integrate image operations into RichTextEditor**

When opening the dialog, store a ProseMirror bookmark or `{ from, to, revision }`. On confirmation:

```js
const selection = restoreSelectionOrEnd(editor, savedSelection);
editor.chain().focus().setTextSelection(selection).insertContent({
  type: "contentImage",
  attrs: { mediaId: media.id, alt, caption }
}).run();
```

Clicking an existing image opens the same dialog with initial values. The image view exposes edit, replace and delete controls only while the editor is editable.

- [ ] **Step 7: Verify GREEN and run component regression**

Run:

```powershell
npm.cmd test -w apps/admin -- src/components/__tests__/ContentImageDialog.test.js src/components/__tests__/RichTextEditor.test.js src/components/__tests__/ContentEditorPanel.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add apps/admin/src/lib/content-image-extension.js apps/admin/src/components/ContentImageView.vue apps/admin/src/components/ContentImageDialog.vue apps/admin/src/components/RichTextEditor.vue apps/admin/src/components/__tests__/ContentImageDialog.test.js apps/admin/src/components/__tests__/RichTextEditor.test.js
git commit -m "feat: add body image media workflow"
```

---

### Task 5: 编辑页布局、错误定位与官网图片样式

**Files:**
- Modify: `apps/admin/src/components/ContentEditorPanel.vue`
- Modify: `apps/admin/src/styles/admin.css`
- Modify: `apps/admin/src/components/__tests__/ContentEditorPanel.test.js`
- Modify: `apps/admin/src/pages/__tests__/SiteContentPage.test.js`
- Modify: `apps/web/src/styles/content.css`
- Modify: `apps/web/src/__tests__/PublicPages.test.jsx`

**Interfaces:**
- `RichTextEditor` emits `notice: string` for non-blocking fallback insertion messages.
- API error code `CONTENT_BODY_MEDIA_INVALID` focuses `[data-content-section="body-media"]`.

- [ ] **Step 1: Write failing editor-page layout tests**

```js
it("focuses the body media section when the API rejects a body image", async () => {
  apiMock.mockRejectedValueOnce(Object.assign(new Error("正文图片无效"), {
    status: 422, code: "CONTENT_BODY_MEDIA_INVALID"
  }));
  await wrapper.get('[data-action="save-content"]').trigger("click");
  expect(document.activeElement).toBe(wrapper.get('[data-content-section="body-media"]').element);
});

it("keeps the action bar compact at 904px and horizontally scrollable on mobile", () => {
  expect(css).toMatch(/\\.content-editor-sticky-actions[^}]*flex-wrap:\\s*nowrap/);
  expect(css).toMatch(/@media \\(max-width:\\s*760px\\)[\\s\\S]*overflow-x:\\s*auto/);
});
```

- [ ] **Step 2: Write failing public content image tests**

```jsx
it("renders responsive figures and captions without horizontal overflow", async () => {
  render(<ContentDetailPage />, {
    route: "/contents/demo",
    api: {
      bodyHtml: '<figure><img src="/api/public/media/M1" alt="现场"><figcaption>比赛现场</figcaption></figure>'
    }
  });
  expect(await screen.findByAltText("现场")).toHaveAttribute("src", "/api/public/media/M1");
  expect(screen.getByText("比赛现场")).toBeInTheDocument();
  expect(css).toMatch(/\\.rich-content figure[^}]*max-width:\\s*100%/);
  expect(css).toMatch(/\\.rich-content figcaption[^}]*text-align:\\s*center/);
});
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
npm.cmd test -w apps/admin -- src/components/__tests__/ContentEditorPanel.test.js src/pages/__tests__/SiteContentPage.test.js
npm.cmd test -w apps/web -- src/__tests__/PublicPages.test.jsx
```

Expected: FAIL because the focus contract and compact styles do not exist.

- [ ] **Step 4: Implement error focus and notices**

Add `tabindex="-1"` to the body/media section and a `ref`. When save/preview returns `CONTENT_BODY_MEDIA_INVALID`, focus it and preserve all fields. Route editor `notice` into the existing non-blocking status message.

- [ ] **Step 5: Implement compact responsive layout**

Desktop:

```css
.content-editor-sticky-actions {
  display: flex;
  flex-wrap: nowrap;
  min-height: 64px;
}
```

Mobile:

```css
@media (max-width: 760px) {
  .content-editor-sticky-actions {
    flex-direction: row;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
  }
  .content-editor-sticky-actions button { flex: 0 0 auto; min-height: 44px; }
  .rich-editor-surface { min-height: min(50vh, 22rem); }
}
```

Add TipTap toolbar, dialog grid, media thumbnails, selected image and node-view styles with visible focus states.

- [ ] **Step 6: Add public figure styles**

```css
.rich-content figure { max-width: 100%; margin: var(--space-4) auto; }
.rich-content figure img { width: auto; max-width: 100%; height: auto; margin: 0 auto; }
.rich-content figcaption { margin-top: var(--space-1); color: var(--color-text-muted); text-align: center; font-size: .9rem; }
```

- [ ] **Step 7: Verify GREEN and run admin/web regression**

Run:

```powershell
npm.cmd test -w apps/admin
npm.cmd test -w apps/web
npm.cmd run build
```

Expected: all tests PASS; both production builds PASS.

- [ ] **Step 8: Commit**

```powershell
git add apps/admin/src/components/ContentEditorPanel.vue apps/admin/src/styles/admin.css apps/admin/src/components/__tests__/ContentEditorPanel.test.js apps/admin/src/pages/__tests__/SiteContentPage.test.js apps/web/src/styles/content.css apps/web/src/__tests__/PublicPages.test.jsx
git commit -m "fix: complete content editor responsive workflow"
```

---

### Task 6: 全量回归、真实浏览器验收与阿里云部署

**Files:**
- Modify: `docs/deployment/aliyun-test.md`
- Create: `docs/superpowers/plans/2026-07-30-content-editor-media-report.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces a deployed release SHA, backup stamp, browser acceptance evidence and clean final production state.

- [ ] **Step 1: Run static and full local verification**

Run:

```powershell
git diff --check
npm.cmd test -w apps/api -- --test-concurrency=1
npm.cmd test -w apps/admin
npm.cmd test -w apps/web
npm.cmd run build
powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1
```

Expected: all commands PASS with no new warnings beyond documented Vite chunk-size warnings.

- [ ] **Step 2: Create and validate deployment backups**

On the server:

```bash
cd /opt/aerogp
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "backups/aerogp-$stamp.dump"
docker compose exec -T backup tar -czf "/backups/uploads/aerogp-uploads-$stamp.tar.gz" -C /uploads .
pg_restore --list "backups/aerogp-$stamp.dump" >/dev/null
tar -tzf "backups/uploads/aerogp-uploads-$stamp.tar.gz" >/dev/null
```

Also archive the current source and tag current API/Web images with the same stamp.

- [ ] **Step 3: Deploy the exact reviewed commit**

Build an archive from `git archive HEAD`, upload it to a candidate directory, run preflight checks, then atomically replace `/opt/aerogp` source. Rebuild API and Web together:

```bash
docker compose up -d --build api web
docker compose ps
```

Expected: API, Web, PostgreSQL and Backup are healthy; only Web maps port 80.

- [ ] **Step 4: Perform real administrator browser acceptance**

Using a temporary draft and ordinary PNG files:

1. Open content editor at desktop width and 904px.
2. Select text and apply H2/H3, bold, italic, both lists, quote and link.
3. Verify undo/redo and clear formatting.
4. Upload image A and insert it at the current caret with alt/caption.
5. Upload image B, choose it from media library, replace image A, then remove one image.
6. Save, reload and confirm positions and captions persist.
7. Confirm bottom action bar does not hide the editor at 904px and 360px.
8. Publish the temporary article and verify the public image returns 200 with an image MIME type.
9. Confirm the public content page has no horizontal overflow and no console errors.
10. Confirm an in-use body image DELETE returns 409; remove the reference and confirm cleanup succeeds.

- [ ] **Step 5: Remove temporary acceptance data**

Take the temporary article offline, delete it, delete its unreferenced temporary media, and verify:

- original content/event/media counts are restored;
- temporary media files no longer exist;
- no cleanup journal failures remain;
- the unique administrator account remains active.

- [ ] **Step 6: Run authenticated smoke and final health checks**

Verify public home, public content, admin login, admin content detail, media list, protected preview and expected unauthenticated 401 behavior. Record runtime `.release`, database counts and `docker compose ps`.

- [ ] **Step 7: Write deployment report**

Record:

- test counts and commands;
- release SHA;
- backup filenames and validation;
- real browser steps and results;
- temporary data cleanup;
- final container and database state;
- rollback instructions.

Do not include passwords, session cookies, connection strings or storage paths outside the already documented deployment roots.

- [ ] **Step 8: Commit evidence**

```powershell
git add docs/deployment/aliyun-test.md docs/superpowers/plans/2026-07-30-content-editor-media-report.md
git commit -m "docs: record content editor media deployment"
```
