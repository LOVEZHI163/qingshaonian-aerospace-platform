import { Node } from "@tiptap/core";
import { VueNodeViewRenderer } from "@tiptap/vue-3";

import ContentImageView from "../components/ContentImageView.vue";

const MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validContentMediaId(value) {
  return MEDIA_ID.test(String(value || ""));
}

export function parsePublicMediaFigure(element) {
  const image = [...element.children].find((child) => child.tagName === "IMG");
  if (!image) return false;
  const match = String(image.getAttribute("src") || "").match(/^\/api\/public\/media\/([^/?#]+)$/);
  if (!match) return false;
  let mediaId;
  try {
    mediaId = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  if (!validContentMediaId(mediaId)) return false;
  const figcaption = [...element.children].find((child) => child.tagName === "FIGCAPTION");
  return {
    mediaId,
    alt: image.getAttribute("alt") || "",
    caption: figcaption?.textContent || ""
  };
}

function imageAttrs(attrs = {}) {
  return {
    mediaId: String(attrs.mediaId || ""),
    alt: String(attrs.alt || ""),
    caption: String(attrs.caption || "")
  };
}

export const ContentImage = Node.create({
  name: "contentImage",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { onEdit: null };
  },

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
    const attrs = imageAttrs(node.attrs);
    const image = ["img", {
      src: `/api/public/media/${encodeURIComponent(attrs.mediaId)}`,
      alt: attrs.alt
    }];
    return attrs.caption
      ? ["figure", {}, image, ["figcaption", {}, attrs.caption]]
      : ["figure", {}, image];
  },

  addCommands() {
    return {
      insertContentImage: (attrs) => ({ state, tr, dispatch, commands }) => {
        const normalized = imageAttrs(attrs);
        if (!validContentMediaId(normalized.mediaId)) return false;
        const { from, to, $from } = state.selection;
        if (
          from === to
          && $from.parent.isTextblock
          && $from.parentOffset > 0
          && $from.parentOffset < $from.parent.content.size
        ) {
          if (dispatch) {
            const image = state.schema.nodes[this.name].create(normalized);
            tr.split(from).insert(from + 1, image).scrollIntoView();
          }
          return true;
        }
        return commands.insertContent({ type: this.name, attrs: normalized });
      },
      updateContentImage: (attrs) => ({ state, commands }) => {
        if (state.selection.node?.type.name !== this.name) return false;
        const normalized = imageAttrs(attrs);
        if (!validContentMediaId(normalized.mediaId)) return false;
        return commands.updateAttributes(this.name, normalized);
      },
      removeContentImage: () => ({ state, commands }) => {
        if (state.selection.node?.type.name !== this.name) return false;
        return commands.deleteSelection();
      }
    };
  },

  addNodeView() {
    return VueNodeViewRenderer(ContentImageView);
  }
});
