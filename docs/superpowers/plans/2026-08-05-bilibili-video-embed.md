# 官网正文 B 站视频组件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在官网内容编辑器中加入安全、可编辑的 B 站视频节点，支持完整 B 站链接或 BV 号，并在公开正文中通过 B 站封面点击原位播放。

**Architecture:** 管理端使用独立的 BV 号解析器、输入弹窗和 Tiptap 原子节点，将视频保存为受控 `figure[data-bilibili-video]` 标记。API 仅清洗并规范该标记，不访问 B 站；官网在现有正文 DOM 增强阶段把合法标记替换为固定来源的懒加载播放器。数据库结构保持不变，任意管理员 `iframe` 继续被过滤。

**Tech Stack:** Vue 3、Tiptap 3、Vitest、Node.js、sanitize-html、React 18、Testing Library、Nginx

## Global Constraints

- 第一版只支持 `https://www.bilibili.com/video/BV...`、`https://m.bilibili.com/video/BV...`、不带 `www` 的同类完整链接，以及直接 BV 号。
- BV 号必须符合 `^BV[0-9A-Za-z]{10}$`。
- 明确拒绝 `b23.tv`、AV 号、番剧、直播、播放列表和其他视频网站。
- 视频标题由管理员必填；不读取 B 站标题。
- 不调用 B 站数据接口，不执行外部短链接跳转，不下载或保存视频和封面。
- 播放器固定使用 `https://player.bilibili.com/player.html`，参数固定为 `poster=1&autoplay=0&danmaku=0`。
- 任意手写 `iframe`、脚本、危险 URL 和事件属性继续被清除。
- 不新增数据库表、数据库字段或运行时第三方依赖。
- 草稿预览、已保存内容预览和正式官网共用相同公开渲染逻辑。
- 本计划完成本地实现、测试和构建；生产部署必须在获得单独授权后执行。

---

## File Structure

### New files

- `apps/admin/src/lib/bilibili-video.js`：解析管理员输入，生成规范观看地址和固定播放器地址。
- `apps/admin/src/lib/bilibili-video-extension.js`：定义 Tiptap `bilibiliVideo` 原子节点及插入、修改、删除命令。
- `apps/admin/src/components/BilibiliVideoDialog.vue`：输入链接和标题、显示识别错误及播放器预览。
- `apps/admin/src/components/BilibiliVideoView.vue`：可视化编辑器中的视频节点视图和编辑操作。
- `apps/admin/src/components/__tests__/BilibiliVideoDialog.test.js`：弹窗解析、校验、提示和事件测试。
- `apps/admin/src/lib/__tests__/bilibili-video.test.js`：纯函数 BV 号解析测试。
- `apps/web/src/lib/bilibili-video.js`：公开正文中的视频标记验证和播放器 DOM 增强。
- `apps/web/src/lib/__tests__/bilibili-video.test.js`：公开播放器增强的单元测试。

### Modified files

- `apps/admin/src/components/RichTextEditor.vue`：注册视频节点，加入工具栏按钮、帮助提示、弹窗和纯文本切换保护。
- `apps/admin/src/lib/rich-text.js`：管理端清洗时保留并规范合法 B 站视频标记。
- `apps/admin/src/components/__tests__/RichTextEditor.test.js`：覆盖插入位置、编辑、删除、模式往返和纯文本确认。
- `apps/admin/src/styles/admin.css`：视频按钮帮助、弹窗和编辑器节点响应式样式。
- `apps/api/src/content/sanitize.js`：服务端只允许合法、规范的视频占位标记。
- `apps/api/test/content-publishing.test.js`：覆盖合法视频保留与恶意标记清除。
- `apps/web/src/pages/ContentDetailPage.jsx`：调用公开视频增强器。
- `apps/web/src/__tests__/PublicPages.test.jsx`：覆盖公开内容和草稿预览共同渲染行为。
- `apps/web/src/styles/content.css`：16:9 播放器、标题和备用链接样式。
- `deploy/nginx.conf`：站点 CSP 允许 `https://player.bilibili.com` 作为唯一外部播放器 frame 来源。
- `apps/api/test/public-site-deployment.test.js`：验证生产 Nginx CSP。

---

### Task 1: BV 号解析器与输入弹窗

**Files:**
- Create: `apps/admin/src/lib/bilibili-video.js`
- Create: `apps/admin/src/lib/__tests__/bilibili-video.test.js`
- Create: `apps/admin/src/components/BilibiliVideoDialog.vue`
- Create: `apps/admin/src/components/__tests__/BilibiliVideoDialog.test.js`
- Modify: `apps/admin/src/styles/admin.css`

**Interfaces:**
- Produces: `parseBilibiliInput(input: string): { ok: true, bvid: string, watchUrl: string } | { ok: false, code: "EMPTY" | "SHORT_LINK" | "INVALID", message: string }`.
- Produces: `bilibiliWatchUrl(bvid: string): string` and `bilibiliPlayerUrl(bvid: string): string`.
- Produces: `BilibiliVideoDialog` props `{ open, initial, disabled }`; emits `close`, `select({ bvid, title })`.
- Consumes: no API calls and no external network requests.

- [ ] **Step 1: Write failing parser tests**

Create `apps/admin/src/lib/__tests__/bilibili-video.test.js` with exact cases:

```js
import { describe, expect, it } from "vitest";
import { bilibiliPlayerUrl, bilibiliWatchUrl, parseBilibiliInput } from "../bilibili-video.js";

describe("B站视频输入", () => {
  it.each([
    ["BV1B7411m7LV", "BV1B7411m7LV"],
    ["https://www.bilibili.com/video/BV1B7411m7LV", "BV1B7411m7LV"],
    ["https://m.bilibili.com/video/BV1B7411m7LV?spm_id_from=333.999.0.0", "BV1B7411m7LV"],
    ["https://bilibili.com/video/BV1B7411m7LV/", "BV1B7411m7LV"]
  ])("解析 %s", (input, bvid) => expect(parseBilibiliInput(input)).toMatchObject({ ok: true, bvid }));

  it.each([
    ["", "EMPTY"],
    ["https://b23.tv/abcd", "SHORT_LINK"],
    ["https://evil.test/video/BV1B7411m7LV", "INVALID"],
    ["av12345", "INVALID"],
    ["BV1B7411m7L<script>", "INVALID"]
  ])("拒绝 %s", (input, code) => expect(parseBilibiliInput(input)).toMatchObject({ ok: false, code }));

  it("只生成固定的观看和播放器地址", () => {
    expect(bilibiliWatchUrl("BV1B7411m7LV")).toBe("https://www.bilibili.com/video/BV1B7411m7LV");
    expect(bilibiliPlayerUrl("BV1B7411m7LV")).toBe("https://player.bilibili.com/player.html?bvid=BV1B7411m7LV&poster=1&autoplay=0&danmaku=0");
  });
});
```

- [ ] **Step 2: Run parser tests and verify RED**

Run:

```powershell
npm test -w apps/admin -- src/lib/__tests__/bilibili-video.test.js
```

Expected: FAIL because `apps/admin/src/lib/bilibili-video.js` does not exist.

- [ ] **Step 3: Implement the parser without network access**

Create `apps/admin/src/lib/bilibili-video.js`:

```js
export const BILIBILI_BVID_RE = /^BV[0-9A-Za-z]{10}$/;
const VIDEO_HOSTS = new Set(["bilibili.com", "www.bilibili.com", "m.bilibili.com"]);

export function bilibiliWatchUrl(bvid) {
  return `https://www.bilibili.com/video/${bvid}`;
}

export function bilibiliPlayerUrl(bvid) {
  return `https://player.bilibili.com/player.html?bvid=${bvid}&poster=1&autoplay=0&danmaku=0`;
}

export function parseBilibiliInput(input) {
  const value = String(input || "").trim();
  if (!value) return { ok: false, code: "EMPTY", message: "请填写B站完整视频链接或BV号。" };
  if (BILIBILI_BVID_RE.test(value)) return { ok: true, bvid: value, watchUrl: bilibiliWatchUrl(value) };
  let url;
  try { url = new URL(value); } catch { return { ok: false, code: "INVALID", message: "未识别到有效BV号，请粘贴完整B站视频链接或直接输入BV号。" }; }
  if (url.hostname.toLowerCase() === "b23.tv") return { ok: false, code: "SHORT_LINK", message: "暂不支持b23.tv短链接，请打开短链接后复制浏览器中的完整视频地址。" };
  if (url.protocol !== "https:" || !VIDEO_HOSTS.has(url.hostname.toLowerCase())) return { ok: false, code: "INVALID", message: "只支持哔哩哔哩完整视频链接。" };
  const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/);
  return match
    ? { ok: true, bvid: match[1], watchUrl: bilibiliWatchUrl(match[1]) }
    : { ok: false, code: "INVALID", message: "未识别到有效BV号，请粘贴完整B站视频链接或直接输入BV号。" };
}
```

- [ ] **Step 4: Run parser tests and verify GREEN**

Run the command from Step 2. Expected: all parser tests PASS.

- [ ] **Step 5: Write failing dialog tests**

Create `apps/admin/src/components/__tests__/BilibiliVideoDialog.test.js`. Test all of the following with explicit selectors:

```js
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import BilibiliVideoDialog from "../BilibiliVideoDialog.vue";

describe("BilibiliVideoDialog", () => {
  it("explains accepted input and previews a valid video", async () => {
    const wrapper = mount(BilibiliVideoDialog, { props: { open: true } });
    expect(wrapper.text()).toContain("暂不支持b23.tv短链接");
    await wrapper.get('[data-field="bilibili-url"]').setValue("https://www.bilibili.com/video/BV1B7411m7LV");
    await wrapper.get('[data-field="bilibili-title"]').setValue("比赛精彩回顾");
    expect(wrapper.get('iframe[title="B站视频预览：比赛精彩回顾"]').attributes("src")).toContain("bvid=BV1B7411m7LV");
    await wrapper.get('[data-action="confirm-bilibili-video"]').trigger("click");
    expect(wrapper.emitted("select").at(-1)[0]).toEqual({ bvid: "BV1B7411m7LV", title: "比赛精彩回顾" });
  });

  it("shows a short-link explanation and disables insertion", async () => {
    const wrapper = mount(BilibiliVideoDialog, { props: { open: true } });
    await wrapper.get('[data-field="bilibili-url"]').setValue("https://b23.tv/abcd");
    expect(wrapper.get('[role="alert"]').text()).toContain("暂不支持b23.tv短链接");
    expect(wrapper.get('[data-action="confirm-bilibili-video"]').attributes("disabled")).toBeDefined();
  });

  it("requires a title and restores initial values when editing", async () => {
    const wrapper = mount(BilibiliVideoDialog, { props: { open: true, initial: { bvid: "BV1B7411m7LV", title: "原标题" } } });
    expect(wrapper.get('[data-field="bilibili-title"]').element.value).toBe("原标题");
    await wrapper.get('[data-field="bilibili-title"]').setValue("");
    expect(wrapper.text()).toContain("请填写视频标题");
    expect(wrapper.get('[data-action="confirm-bilibili-video"]').attributes("disabled")).toBeDefined();
  });
});
```

- [ ] **Step 6: Run dialog tests and verify RED**

Run:

```powershell
npm test -w apps/admin -- src/components/__tests__/BilibiliVideoDialog.test.js
```

Expected: FAIL because the dialog component does not exist.

- [ ] **Step 7: Implement the accessible dialog and its local styles**

Implement `BilibiliVideoDialog.vue` using the same focus trap, Escape handling and backdrop behavior as `ContentImageDialog.vue`. It must:

- watch `open` and `initial` to reset fields;
- compute `parsed = parseBilibiliInput(url)`;
- trim the title before emitting;
- render the exact `data-field` and `data-action` selectors used above;
- set preview `iframe` attributes `loading="lazy"`, `allowfullscreen`, `referrerpolicy="strict-origin-when-cross-origin"`;
- never call `fetch`, `api`, or any B站 endpoint other than loading the preview iframe;
- use a responsive `.content-bilibili-preview` wrapper in `admin.css` with `aspect-ratio: 16 / 9` and `width: 100%`.

The dialog state and submit path must be exactly:

```js
const url = ref("");
const title = ref("");
const parsed = computed(() => parseBilibiliInput(url.value));
const normalizedTitle = computed(() => title.value.trim());
const canSubmit = computed(() => !props.disabled && parsed.value.ok && Boolean(normalizedTitle.value));

watch(() => [props.open, props.initial], ([open]) => {
  if (!open) return;
  url.value = props.initial?.bvid || "";
  title.value = props.initial?.title || "";
  nextTick(() => urlInput.value?.focus());
}, { immediate: true, deep: true });

function confirm() {
  if (!canSubmit.value) return;
  emit("select", { bvid: parsed.value.bvid, title: normalizedTitle.value });
}
```

Render the player preview only when `parsed.ok && normalizedTitle`, and derive `src` only with `bilibiliPlayerUrl(parsed.bvid)`. The help copy and error messages must come from `parseBilibiliInput`; do not duplicate a second URL parser in the component.

- [ ] **Step 8: Run all Task 1 tests**

Run:

```powershell
npm test -w apps/admin -- src/lib/__tests__/bilibili-video.test.js src/components/__tests__/BilibiliVideoDialog.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```powershell
git add apps/admin/src/lib/bilibili-video.js apps/admin/src/lib/__tests__/bilibili-video.test.js apps/admin/src/components/BilibiliVideoDialog.vue apps/admin/src/components/__tests__/BilibiliVideoDialog.test.js apps/admin/src/styles/admin.css
git commit -m "feat: add bilibili video dialog"
```

---

### Task 2: Tiptap 视频节点与编辑器操作

**Files:**
- Create: `apps/admin/src/lib/bilibili-video-extension.js`
- Create: `apps/admin/src/components/BilibiliVideoView.vue`
- Modify: `apps/admin/src/components/RichTextEditor.vue:1-450`
- Modify: `apps/admin/src/lib/rich-text.js:1-110`
- Modify: `apps/admin/src/components/__tests__/RichTextEditor.test.js`
- Modify: `apps/admin/src/styles/admin.css`

**Interfaces:**
- Consumes: Task 1 `BilibiliVideoDialog`, `BILIBILI_BVID_RE`, `bilibiliPlayerUrl`, `bilibiliWatchUrl`.
- Produces: Tiptap node name `bilibiliVideo`, attributes `{ bvid: string, title: string }`.
- Produces commands: `insertBilibiliVideo(attrs)`, `updateBilibiliVideo(attrs)`, `removeBilibiliVideo()` returning `boolean`.
- Produces canonical HTML: `<figure class="content-bilibili-video" data-bilibili-video="BV..."><figcaption>标题</figcaption></figure>`.

- [ ] **Step 1: Write failing editor behavior tests**

Extend `RichTextEditor.test.js` with tests that assert:

```js
it("advertises and inserts an editable B站 video at the current selection", async () => {
  const wrapper = await mountEditor({ attachTo: document.body, props: { modelValue: "<p>前文后文</p>" } });
  expect(wrapper.get('[data-command="bilibili-video"]').attributes("title")).toContain("完整链接或BV号");
  wrapper.vm.editor.commands.setTextSelection(3);
  expect(wrapper.vm.insertBilibiliVideo({ bvid: "BV1B7411m7LV", title: "比赛回顾" })).toBe(true);
  expect(wrapper.emitted("update:modelValue").at(-1)[0]).toContain('data-bilibili-video="BV1B7411m7LV"');
  expect(wrapper.emitted("update:modelValue").at(-1)[0]).toContain("<figcaption>比赛回顾</figcaption>");
  wrapper.unmount();
});

it("updates and removes only the selected video node", async () => {
  const wrapper = await mountEditor({ props: { modelValue: '<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV"><figcaption>旧标题</figcaption></figure>' } });
  wrapper.vm.editor.commands.setNodeSelection(0);
  expect(wrapper.vm.updateSelectedBilibiliVideo({ bvid: "BV1SS4y1n7Fc", title: "新标题" })).toBe(true);
  expect(wrapper.vm.editor.getHTML()).toContain("BV1SS4y1n7Fc");
  expect(wrapper.vm.removeSelectedBilibiliVideo()).toBe(true);
  expect(wrapper.vm.editor.getHTML()).not.toContain("data-bilibili-video");
});

it("preserves videos through visual and HTML modes", async () => {
  const html = '<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV"><figcaption>比赛回顾</figcaption></figure>';
  const wrapper = await mountEditor({ props: { modelValue: html } });
  await wrapper.get('[data-editor-mode="html"]').trigger("click");
  expect(wrapper.get('[data-rich-editor="html"]').element.value).toContain("data-bilibili-video");
  await wrapper.get('[data-editor-mode="visual"]').trigger("click");
  expect(wrapper.vm.editor.getHTML()).toContain("data-bilibili-video");
});

it("warns before pure text mode removes structured media", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const wrapper = await mountEditor({ props: { modelValue: '<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV"><figcaption>比赛回顾</figcaption></figure>' } });
  await wrapper.get('[data-editor-mode="text"]').trigger("click");
  expect(confirm).toHaveBeenCalledWith("纯文本编辑会移除正文媒体，是否继续？");
  expect(wrapper.find('[data-rich-editor="text"]').exists()).toBe(false);
  confirm.mockRestore();
});
```

Also add `sanitizeEditorHtml` cases that retain one valid canonical video figure, strip invalid BV attributes, strip extra classes/attributes, and continue removing hand-written iframes.

- [ ] **Step 2: Run focused editor tests and verify RED**

Run:

```powershell
npm test -w apps/admin -- src/components/__tests__/RichTextEditor.test.js
```

Expected: FAIL because the node commands and toolbar entry do not exist and the current figure canonicalizer treats every figure as an image.

- [ ] **Step 3: Implement the Tiptap node extension**

Create `bilibili-video-extension.js` following `content-image-extension.js`:

```js
import { Node } from "@tiptap/core";
import { VueNodeViewRenderer } from "@tiptap/vue-3";
import BilibiliVideoView from "../components/BilibiliVideoView.vue";
import { BILIBILI_BVID_RE } from "./bilibili-video.js";

export function validBilibiliVideoAttrs(attrs = {}) {
  return BILIBILI_BVID_RE.test(String(attrs.bvid || "")) && Boolean(String(attrs.title || "").trim());
}

function normalizedAttrs(attrs = {}) {
  return { bvid: String(attrs.bvid || ""), title: String(attrs.title || "").trim() };
}

function parseVideoFigure(element) {
  const attrs = [...element.attributes];
  const children = [...element.childNodes].filter((node) => node.nodeType !== 3 || node.nodeValue.trim());
  const caption = children[0];
  const parsed = {
    bvid: element.getAttribute("data-bilibili-video") || "",
    title: caption?.textContent?.trim() || ""
  };
  if (
    attrs.some((attribute) => !["class", "data-bilibili-video"].includes(attribute.name))
    || element.className !== "content-bilibili-video"
    || children.length !== 1
    || caption?.nodeType !== 1
    || caption.tagName !== "FIGCAPTION"
    || caption.attributes.length
    || caption.childNodes.length !== 1
    || caption.firstChild?.nodeType !== 3
    || !validBilibiliVideoAttrs(parsed)
  ) return false;
  return parsed;
}

export const BilibiliVideo = Node.create({
  name: "bilibiliVideo",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addOptions() { return { onEdit: null }; },
  addAttributes() { return { bvid: { default: "" }, title: { default: "" } }; },
  parseHTML() { return [{ tag: "figure.content-bilibili-video[data-bilibili-video]", getAttrs: parseVideoFigure }]; },
  renderHTML({ node }) {
    const attrs = normalizedAttrs(node.attrs);
    return ["figure", { class: "content-bilibili-video", "data-bilibili-video": attrs.bvid }, ["figcaption", {}, attrs.title]];
  },
  addCommands() {
    return {
      insertBilibiliVideo: (attrs) => ({ state, tr, dispatch, commands }) => {
        const normalized = normalizedAttrs(attrs);
        if (!validBilibiliVideoAttrs(normalized)) return false;
        const { from, to, $from } = state.selection;
        if (from === to && $from.parent.isTextblock && $from.parentOffset > 0 && $from.parentOffset < $from.parent.content.size) {
          if (dispatch) tr.split(from).insert(from + 1, state.schema.nodes[this.name].create(normalized)).scrollIntoView();
          return true;
        }
        return commands.insertContent({ type: this.name, attrs: normalized });
      },
      updateBilibiliVideo: (attrs) => ({ state, commands }) => {
        const normalized = normalizedAttrs(attrs);
        if (state.selection.node?.type.name !== this.name || !validBilibiliVideoAttrs(normalized)) return false;
        return commands.updateAttributes(this.name, normalized);
      },
      removeBilibiliVideo: () => ({ state, commands }) => state.selection.node?.type.name === this.name && commands.deleteSelection()
    };
  },
  addNodeView() { return VueNodeViewRenderer(BilibiliVideoView); }
});
```

`parseHTML()` must accept only a `figure.content-bilibili-video[data-bilibili-video]` containing exactly one non-empty text-only `figcaption`. `renderHTML()` must reconstruct the canonical figure and never copy arbitrary input attributes.

- [ ] **Step 4: Implement the node view**

Create `BilibiliVideoView.vue` following `ContentImageView.vue`. Render:

- fixed-player preview iframe from `bilibiliPlayerUrl(node.attrs.bvid)`;
- `<figcaption>{{ node.attrs.title }}</figcaption>`;
- external link from `bilibiliWatchUrl(node.attrs.bvid)`;
- actions `edit-bilibili-video` and `remove-bilibili-video` only while editable.

The edit action must call `extension.options.onEdit({ node, position: getPos() })`; remove must call `deleteNode()`.

The script state is:

```js
const props = defineProps(nodeViewProps);
const editable = ref(props.editor.isEditable);
function syncEditable() { editable.value = props.editor.isEditable; }
function edit() {
  if (editable.value) props.extension.options.onEdit?.({ node: props.node, position: props.getPos() });
}
function remove() { if (editable.value) props.deleteNode(); }
onMounted(() => { props.editor.on("transaction", syncEditable); props.editor.on("update", syncEditable); });
onBeforeUnmount(() => { props.editor.off("transaction", syncEditable); props.editor.off("update", syncEditable); });
```

Use this exact view shape so selectors and accessibility stay stable:

```vue
<NodeViewWrapper as="figure" class="content-bilibili-video" :data-bilibili-video="node.attrs.bvid" :class="{ 'is-selected': selected }" contenteditable="false">
  <div class="content-bilibili-frame">
    <iframe :src="bilibiliPlayerUrl(node.attrs.bvid)" :title="`B站视频预览：${node.attrs.title}`" loading="lazy" allow="fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" />
  </div>
  <figcaption>{{ node.attrs.title }}</figcaption>
  <a :href="bilibiliWatchUrl(node.attrs.bvid)" target="_blank" rel="noopener noreferrer">在哔哩哔哩打开</a>
  <div v-if="editable" class="content-bilibili-actions">
    <button type="button" data-action="edit-bilibili-video" @click="edit">编辑视频</button>
    <button type="button" data-action="remove-bilibili-video" @click="remove">删除视频</button>
  </div>
</NodeViewWrapper>
```

- [ ] **Step 5: Preserve canonical video figures in the admin sanitizer**

Modify `rich-text.js` so `canonicalizeManagedFigures` first recognizes a valid video figure and rebuilds only:

```html
<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV"><figcaption>纯文本标题</figcaption></figure>
```

Continue using the existing image canonicalization for non-video figures. Invalid `data-bilibili-video` figures must be flattened to harmless text and cannot become an editor video node.

Add the following branch before existing image handling:

```js
const bvid = figure.getAttribute("data-bilibili-video");
if (bvid !== null) {
  const caption = nodes.length === 1 && nodes[0]?.tagName === "FIGCAPTION" ? nodes[0] : null;
  const title = caption?.textContent?.trim() || "";
  if (/^BV[0-9A-Za-z]{10}$/.test(bvid) && title) {
    const rebuilt = document.createElement("figure");
    rebuilt.className = "content-bilibili-video";
    rebuilt.setAttribute("data-bilibili-video", bvid);
    const rebuiltCaption = document.createElement("figcaption");
    rebuiltCaption.textContent = title;
    rebuilt.append(rebuiltCaption);
    figure.replaceWith(rebuilt);
  } else {
    figure.replaceWith(document.createTextNode(title));
  }
  return;
}
```

Before `visit(parsed.body)`, temporarily preserve video values with trusted internal attributes; after `visit`, restore only canonical values before `canonicalizeManagedFigures` runs:

```js
parsed.body.querySelectorAll("figure[data-bilibili-video]").forEach((node) => {
  node.setAttribute("data-editor-bilibili", node.getAttribute("data-bilibili-video") || "");
  node.setAttribute("data-editor-video-title", node.querySelector(":scope > figcaption")?.textContent?.trim() || "");
});
visit(parsed.body);
parsed.body.querySelectorAll("figure[data-editor-bilibili]").forEach((node) => {
  const bvid = node.getAttribute("data-editor-bilibili") || "";
  const title = node.getAttribute("data-editor-video-title") || "";
  node.removeAttribute("data-editor-bilibili");
  node.removeAttribute("data-editor-video-title");
  node.className = "content-bilibili-video";
  node.setAttribute("data-bilibili-video", bvid);
  const caption = parsed.createElement("figcaption");
  caption.textContent = title;
  node.replaceChildren(caption);
});
```

Keep the existing global removal of untrusted incoming `data-editor-*` attributes before these trusted attributes are created.

- [ ] **Step 6: Integrate the dialog and commands into RichTextEditor**

Modify `RichTextEditor.vue` to:

- register `BilibiliVideo.configure({ onEdit: editBilibiliVideo })` after `ContentImage`;
- add `bilibiliDialogOpen`, saved selection and editing target state mirroring image behavior;
- render the “B站视频” toolbar button immediately after “图片” with `title="粘贴B站完整链接或BV号，插入可播放视频"`;
- render an adjacent accessible help button/text explaining supported formats and short-link rejection;
- open `BilibiliVideoDialog` for insertion or selected-node editing;
- expose `insertBilibiliVideo`, `updateSelectedBilibiliVideo`, `removeSelectedBilibiliVideo` for tests;
- before `setMode("text")`, detect `figure`, `img`, or `[data-bilibili-video]` in the current safe HTML and require the exact confirmation text from the test;
- preserve existing image selection/revision conflict protections.

- [ ] **Step 7: Add editor-node styles**

In `admin.css`, add `.content-bilibili-video`, `.content-bilibili-frame`, `.content-bilibili-actions`, focus/selected state, and mobile rules. Every iframe wrapper must use `aspect-ratio: 16 / 9`; action buttons must wrap at narrow widths without causing horizontal scrolling.

- [ ] **Step 8: Run focused editor tests and full admin component tests**

Run:

```powershell
npm test -w apps/admin -- src/components/__tests__/RichTextEditor.test.js src/components/__tests__/BilibiliVideoDialog.test.js src/components/__tests__/ContentImageDialog.test.js
```

Expected: PASS, including all pre-existing content-image tests.

- [ ] **Step 9: Commit Task 2**

```powershell
git add apps/admin/src/lib/bilibili-video-extension.js apps/admin/src/components/BilibiliVideoView.vue apps/admin/src/components/RichTextEditor.vue apps/admin/src/lib/rich-text.js apps/admin/src/components/__tests__/RichTextEditor.test.js apps/admin/src/styles/admin.css
git commit -m "feat: embed bilibili videos in content editor"
```

---

### Task 3: 服务端规范化和安全清洗

**Files:**
- Modify: `apps/api/src/content/sanitize.js`
- Modify: `apps/api/test/content-publishing.test.js`

**Interfaces:**
- Consumes: canonical figure HTML produced by Task 2.
- Produces: `sanitizeContentHtml(html)` that preserves only valid `figure.content-bilibili-video[data-bilibili-video]` video markers while continuing to reject every iframe.
- Produces no new route, database field, external request or dependency.

- [ ] **Step 1: Write failing sanitizer tests**

Extend `content-publishing.test.js`:

```js
test("sanitize content preserves only canonical B站 video markers", () => {
  const clean = sanitizeContentHtml([
    '<figure class="content-bilibili-video extra" data-bilibili-video="BV1B7411m7LV" onclick="bad()"><figcaption>比赛<strong>回顾</strong><script>bad()</script></figcaption></figure>',
    '<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7L<script>"><figcaption>恶意</figcaption></figure>',
    '<iframe src="https://player.bilibili.com/player.html?bvid=BV1B7411m7LV"></iframe>'
  ].join(""));
  assert.match(clean, /<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV"><figcaption>比赛<strong>回顾<\/strong><\/figcaption><\/figure>/);
  assert.equal(clean.includes("onclick"), false);
  assert.equal(clean.includes("BV1B7411m7L<script>"), false);
  assert.equal(clean.includes("iframe"), false);
});
```

Add a second test confirming ordinary image figures remain unchanged. The public renderer in Task 4 reads the caption with `textContent`, so formatting tags that are otherwise legal rich text can never become executable title HTML inside the generated player component.

- [ ] **Step 2: Run sanitizer tests and verify RED**

Run:

```powershell
npm test -w apps/api -- test/content-publishing.test.js
```

Expected: FAIL because `figure` currently permits no class/data attributes and strips the marker.

- [ ] **Step 3: Implement strict figure transformation**

In `sanitize.js` add:

```js
const BILIBILI_BVID_RE = /^BV[0-9A-Za-z]{10}$/;
const BILIBILI_CLASS = "content-bilibili-video";
```

Allow only `class` and `data-bilibili-video` on `figure`. Add a `figure` transform that:

- leaves ordinary image figures attribute-free;
- for a valid BV marker, reconstructs exactly `{ class: BILIBILI_CLASS, "data-bilibili-video": bvid }`;
- for a figure claiming to be a B站 video with an invalid BV value, changes it to an attribute-free harmless block so the public renderer cannot enhance it;
- never preserves input styles, event handlers or extra class names.

Keep `iframe` in `nonTextTags`; do not add it to `allowedTags`.

Use this exact transformation in `allowedAttributes` and `transformTags`:

```js
allowedAttributes: {
  a: ["href", "title"],
  img: ["src", "alt", "title"],
  figure: ["class", "data-bilibili-video"]
},
transformTags: {
  a: (tagName, attribs) => ({
    tagName,
    attribs: LINK_PROTOCOL.test(attribs.href || "")
      ? attribs
      : Object.fromEntries(Object.entries(attribs).filter(([key]) => key !== "href"))
  }),
  img: (tagName, attribs) => ({
    tagName,
    attribs: MEDIA_PATH.test(attribs.src || "")
      ? attribs
      : Object.fromEntries(Object.entries(attribs).filter(([key]) => key !== "src"))
  }),
  figure: (tagName, attribs) => {
    const claimedVideo = Object.hasOwn(attribs, "data-bilibili-video") || String(attribs.class || "").split(/\s+/).includes(BILIBILI_CLASS);
    const bvid = String(attribs["data-bilibili-video"] || "");
    if (!claimedVideo) return { tagName, attribs: {} };
    if (!BILIBILI_BVID_RE.test(bvid)) return { tagName: "div", attribs: {} };
    return { tagName, attribs: { class: BILIBILI_CLASS, "data-bilibili-video": bvid } };
  }
}
```

Because `div` is not in `allowedTags`, an invalid claimed video loses its player marker and is reduced to harmless child content by `sanitize-html`.

- [ ] **Step 4: Run API sanitizer and publishing suites**

Run:

```powershell
npm test -w apps/api -- test/content-publishing.test.js test/public-site-service.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```powershell
git add apps/api/src/content/sanitize.js apps/api/test/content-publishing.test.js
git commit -m "feat: sanitize bilibili content embeds"
```

---

### Task 4: 官网封面点击原位播放

**Files:**
- Create: `apps/web/src/lib/bilibili-video.js`
- Create: `apps/web/src/lib/__tests__/bilibili-video.test.js`
- Modify: `apps/web/src/pages/ContentDetailPage.jsx:27-82`
- Modify: `apps/web/src/__tests__/PublicPages.test.jsx`
- Modify: `apps/web/src/__tests__/PreviewPage.test.jsx`
- Modify: `apps/web/src/styles/content.css`

**Interfaces:**
- Consumes: API-cleaned canonical video figures.
- Produces: `enhanceBilibiliVideos(root: HTMLElement): void`.
- Produces fixed iframe URL, `loading="lazy"`, title, fullscreen permission and external fallback link.

- [ ] **Step 1: Write failing DOM enhancement tests**

Create `apps/web/src/lib/__tests__/bilibili-video.test.js`:

```js
import { describe, expect, it } from "vitest";
import { enhanceBilibiliVideos } from "../bilibili-video.js";

describe("公开 B站播放器", () => {
  it("enhances a valid marker into a fixed lazy player and fallback link", () => {
    const root = document.createElement("div");
    root.innerHTML = '<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV"><figcaption>比赛回顾</figcaption></figure>';
    enhanceBilibiliVideos(root);
    const frame = root.querySelector("iframe");
    expect(frame.src).toBe("https://player.bilibili.com/player.html?bvid=BV1B7411m7LV&poster=1&autoplay=0&danmaku=0");
    expect(frame.loading).toBe("lazy");
    expect(frame.title).toBe("B站视频：比赛回顾");
    expect(root.querySelector('a[target="_blank"]').href).toBe("https://www.bilibili.com/video/BV1B7411m7LV");
  });

  it("does not create a frame for an invalid marker", () => {
    const root = document.createElement("div");
    root.innerHTML = '<figure class="content-bilibili-video" data-bilibili-video="javascript:bad"><figcaption>恶意</figcaption></figure>';
    enhanceBilibiliVideos(root);
    expect(root.querySelector("iframe")).toBeNull();
  });
});
```

- [ ] **Step 2: Run web helper tests and verify RED**

Run:

```powershell
npm test -w apps/web -- --run src/lib/__tests__/bilibili-video.test.js
```

Expected: FAIL because the enhancer does not exist.

- [ ] **Step 3: Implement public DOM enhancement**

Create `apps/web/src/lib/bilibili-video.js`. `enhanceBilibiliVideos(root)` must:

- query only `figure.content-bilibili-video[data-bilibili-video]`;
- revalidate `^BV[0-9A-Za-z]{10}$` before creating any URL;
- read the title only from `figcaption.textContent.trim()` and skip enhancement if empty;
- clear the figure and append a `.content-bilibili-frame` wrapper containing the iframe;
- assign iframe `src`, `title`, `loading="lazy"`, `allow="fullscreen"`, `allowFullscreen = true`, `referrerPolicy="strict-origin-when-cross-origin"`;
- append a fresh text-only `figcaption` and an external `<a target="_blank" rel="noopener noreferrer">在哔哩哔哩打开</a>`;
- use DOM property assignment and `textContent`; never concatenate title text into HTML.

Implement the helper with this concrete structure:

```js
const BVID_RE = /^BV[0-9A-Za-z]{10}$/;

export function enhanceBilibiliVideos(root) {
  for (const figure of root?.querySelectorAll("figure.content-bilibili-video[data-bilibili-video]") || []) {
    const bvid = figure.getAttribute("data-bilibili-video") || "";
    const title = figure.querySelector(":scope > figcaption")?.textContent?.trim() || "";
    if (!BVID_RE.test(bvid) || !title) continue;
    const frameWrap = document.createElement("div");
    frameWrap.className = "content-bilibili-frame";
    const iframe = document.createElement("iframe");
    iframe.src = `https://player.bilibili.com/player.html?bvid=${bvid}&poster=1&autoplay=0&danmaku=0`;
    iframe.title = `B站视频：${title}`;
    iframe.loading = "lazy";
    iframe.allow = "fullscreen";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    frameWrap.append(iframe);
    const caption = document.createElement("figcaption");
    caption.textContent = title;
    const link = document.createElement("a");
    link.href = `https://www.bilibili.com/video/${bvid}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "在哔哩哔哩打开";
    figure.replaceChildren(frameWrap, caption, link);
  }
}
```

- [ ] **Step 4: Call the enhancer from the shared content detail view**

Import `enhanceBilibiliVideos` in `ContentDetailPage.jsx` and call it in the existing `useEffect` after image normalization. Because `PreviewPage.jsx` already renders `ContentDetailView`, this single integration covers draft preview and public content.

- [ ] **Step 5: Add integration tests for public and preview rendering**

In `PublicPages.test.jsx`, return API-cleaned body HTML containing one valid video marker and assert an iframe with the exact fixed source, accessible title, caption and external link. Hand-written iframe rejection remains covered at the authoritative API boundary in Task 3.

In `PreviewPage.test.jsx`, put the same marker in the preview snapshot and assert the same iframe source and title. This proves preview and published content share the renderer.

- [ ] **Step 6: Add responsive public styles**

In `content.css` add:

```css
.rich-content .content-bilibili-video { margin: 24px 0; }
.rich-content .content-bilibili-frame { width: 100%; aspect-ratio: 16 / 9; overflow: hidden; background: #0b1f3a; border-radius: 12px; }
.rich-content .content-bilibili-frame iframe { display: block; width: 100%; height: 100%; border: 0; }
.rich-content .content-bilibili-video figcaption { margin-top: 10px; font-weight: 700; color: #10233f; }
.rich-content .content-bilibili-video a { display: inline-block; margin-top: 6px; }
```

Add a test in `PublicPages.test.jsx` reading `content.css` and asserting `aspect-ratio: 16 / 9`, `width: 100%`, and no fixed pixel iframe width.

- [ ] **Step 7: Run focused and related web tests**

Run:

```powershell
npm test -w apps/web -- --run src/lib/__tests__/bilibili-video.test.js src/__tests__/PublicPages.test.jsx src/__tests__/PreviewPage.test.jsx
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```powershell
git add apps/web/src/lib/bilibili-video.js apps/web/src/lib/__tests__/bilibili-video.test.js apps/web/src/pages/ContentDetailPage.jsx apps/web/src/__tests__/PublicPages.test.jsx apps/web/src/__tests__/PreviewPage.test.jsx apps/web/src/styles/content.css
git commit -m "feat: render bilibili videos on public site"
```

---

### Task 5: 生产环境播放器权限

**Files:**
- Modify: `deploy/nginx.conf`
- Modify: `apps/api/test/public-site-deployment.test.js`

**Interfaces:**
- Consumes: Task 4 iframe source `https://player.bilibili.com`.
- Produces: page response CSP containing `frame-src https://player.bilibili.com` while retaining the stricter media-file sandbox CSP in `/api/public/media/`.

- [ ] **Step 1: Write a failing deployment-policy test**

Add to `public-site-deployment.test.js`:

```js
test("public pages allow only the official B站 player as an external frame", async () => {
  const nginx = await read("deploy/nginx.conf");
  const policies = nginx.match(/add_header Content-Security-Policy [^\r\n]+/g) || [];
  assert.ok(policies.some((line) => line.includes("frame-src 'self' https://player.bilibili.com")));
  const htmlLocation = nginx.match(/location ~\* \\.html\$ \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(htmlLocation, /Content-Security-Policy[^\r\n]+frame-src 'self' https:\/\/player\.bilibili\.com/);
  assert.doesNotMatch(nginx, /frame-src[^\r\n]+\*/);
});
```

- [ ] **Step 2: Run the deployment test and verify RED**

Run:

```powershell
npm test -w apps/api -- test/public-site-deployment.test.js
```

Expected: FAIL because the page-level policy has no B站 frame source.

- [ ] **Step 3: Add the minimum page-level CSP**

Add a server-level Nginx header compatible with current same-origin bundles and APIs:

```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-src 'self' https://player.bilibili.com; object-src 'none'; base-uri 'self'; frame-ancestors 'self'" always;
```

Repeat the same page CSP inside `location ~* \.html$` after its `Cache-Control` header because any location containing its own `add_header` does not inherit server-level `add_header` values. Do not replace the existing stricter `sandbox; default-src 'none'` CSP inside the `/api/public/media/` location; that location must continue overriding the page policy for media responses.

- [ ] **Step 4: Run deployment tests**

Run:

```powershell
npm test -w apps/api -- test/public-site-deployment.test.js
```

Expected: PASS.

- [ ] **Step 5: Validate Nginx syntax in the same container image used by compose**

Run:

```powershell
$env:POSTGRES_PASSWORD="local-build-only"
$env:SESSION_SECRET="local-build-only"
$env:RELEASE_SHA=(git rev-parse HEAD)
docker compose build web
docker run --rm --entrypoint nginx aerogp-web -t
```

Compose project name is `aerogp`, so the built web image is `aerogp-web`. Success criterion is `syntax is ok` and `test is successful`.

- [ ] **Step 6: Commit Task 5**

```powershell
git add deploy/nginx.conf apps/api/test/public-site-deployment.test.js
git commit -m "chore: allow official bilibili player frames"
```

---

### Task 6: Full regression and release readiness

**Files:**
- Verify only; do not change production state.

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: a clean, fully tested branch ready for separately authorized deployment.

- [ ] **Step 1: Run the complete Admin test suite**

```powershell
npm test -w apps/admin
```

Expected: every Admin test file PASS.

- [ ] **Step 2: Run the complete API test suite**

```powershell
npm test -w apps/api
```

Expected: every Node test PASS with no open-handle warning.

- [ ] **Step 3: Run the complete Web test suite once**

```powershell
npm test -w apps/web -- --run
```

Expected: every Web test file PASS.

- [ ] **Step 4: Build both frontends from the repository root**

```powershell
npm run build
```

Expected: both Vite builds complete successfully and emit no unresolved-import error.

- [ ] **Step 5: Inspect the final diff and working tree**

```powershell
git diff --check
git status --short
git log --oneline -6
```

Expected: `git diff --check` is empty; the working tree is clean; the five task commits are visible.

- [ ] **Step 6: Perform a local browser smoke test**

Start the local stack and verify:

1. “B站视频” button, hover help and dialog instructions are visible.
2. Full B站 URL and BV input insert a video; `b23.tv` shows the agreed error.
3. Video title can be edited and the node can be removed.
4. Draft preview shows the B站 cover; clicking it plays in place.
5. Mobile viewport has no horizontal scroll.
6. HTML containing `<iframe src="https://evil.test">` is removed after save.

Record the tested local URL and viewport sizes in the handoff message. Stop only locally started development processes after verification. Do not SSH, deploy, restart production containers or modify production data in this task.

---

## Implementation Completion Criteria

- All six tasks are complete and their focused tests have passed through RED then GREEN.
- Full Admin, API and Web suites pass.
- Root production build passes.
- Nginx configuration test passes.
- Working tree is clean and each independently reviewable task has its own commit.
- No database migration, external video download, B站 metadata API call or short-link resolver has been introduced.
- Production remains unchanged until the user separately authorizes deployment.
