import sanitizeHtml from "sanitize-html";

const MEDIA_PATH = /^\/api\/public\/media\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LINK_PROTOCOL = /^(https?:|mailto:)/i;

export function sanitizeContentHtml(html) {
  return sanitizeHtml(String(html ?? ""), {
    allowedTags: ["p", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em", "blockquote", "a", "img", "figure", "figcaption", "br"],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title"]
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    nonTextTags: ["script", "style", "iframe"],
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
      })
    }
  });
}
