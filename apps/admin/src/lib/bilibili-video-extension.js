import { Node } from "@tiptap/core";
import { VueNodeViewRenderer } from "@tiptap/vue-3";

import BilibiliVideoView from "../components/BilibiliVideoView.vue";
import { BILIBILI_BVID_RE } from "./bilibili-video.js";

export function validBilibiliVideoAttrs(attrs = {}) {
  return BILIBILI_BVID_RE.test(String(attrs.bvid || ""))
    && Boolean(String(attrs.title || "").trim());
}

function normalizedAttrs(attrs = {}) {
  return {
    bvid: String(attrs.bvid || ""),
    title: String(attrs.title || "").trim()
  };
}

function parseVideoFigure(element) {
  const attrs = [...element.attributes];
  const children = [...element.childNodes].filter((node) => (
    node.nodeType !== 3 || node.nodeValue.trim()
  ));
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

  addOptions() {
    return { onEdit: null };
  },

  addAttributes() {
    return {
      bvid: { default: "" },
      title: { default: "" }
    };
  },

  parseHTML() {
    return [{
      tag: "figure.content-bilibili-video[data-bilibili-video]",
      getAttrs: parseVideoFigure
    }];
  },

  renderHTML({ node }) {
    const attrs = normalizedAttrs(node.attrs);
    return [
      "figure",
      { class: "content-bilibili-video", "data-bilibili-video": attrs.bvid },
      ["figcaption", {}, attrs.title]
    ];
  },

  addCommands() {
    return {
      insertBilibiliVideo: (attrs) => ({ state, tr, dispatch, commands }) => {
        const normalized = normalizedAttrs(attrs);
        if (!validBilibiliVideoAttrs(normalized)) return false;
        const { from, to, $from } = state.selection;
        if (
          from === to
          && $from.parent.isTextblock
          && $from.parentOffset > 0
          && $from.parentOffset < $from.parent.content.size
        ) {
          if (dispatch) {
            tr.split(from)
              .insert(from + 1, state.schema.nodes[this.name].create(normalized))
              .scrollIntoView();
          }
          return true;
        }
        return commands.insertContent({ type: this.name, attrs: normalized });
      },
      updateBilibiliVideo: (attrs) => ({ state, commands }) => {
        const normalized = normalizedAttrs(attrs);
        if (
          state.selection.node?.type.name !== this.name
          || !validBilibiliVideoAttrs(normalized)
        ) return false;
        return commands.updateAttributes(this.name, normalized);
      },
      removeBilibiliVideo: () => ({ state, commands }) => (
        state.selection.node?.type.name === this.name && commands.deleteSelection()
      )
    };
  },

  addNodeView() {
    return VueNodeViewRenderer(BilibiliVideoView);
  }
});
