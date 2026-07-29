const ALLOWED_TAGS = new Set(["P", "H2", "H3", "H4", "UL", "OL", "LI", "STRONG", "EM", "BLOCKQUOTE", "A", "IMG", "FIGURE", "FIGCAPTION", "BR"]);
const DROP_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE"]);

export function sanitizeEditorHtml(raw) {
  const parsed = new DOMParser().parseFromString(String(raw || ""), "text/html");
  function visit(parent) {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (DROP_TAGS.has(node.tagName)) { node.remove(); continue; }
      visit(node);
      if (!ALLOWED_TAGS.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
      for (const attribute of [...node.attributes]) {
        if (!attribute.name.startsWith("data-editor-")) node.removeAttribute(attribute.name);
      }
    }
  }
  parsed.body.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (attribute.name.startsWith("data-editor-")) node.removeAttribute(attribute.name);
    }
  });
  parsed.body.querySelectorAll("a").forEach((node) => {
    const href = node.getAttribute("href") || "";
    if (/^(https?:|mailto:)/i.test(href)) node.setAttribute("data-editor-href", href);
  });
  parsed.body.querySelectorAll("img").forEach((node) => {
    const src = node.getAttribute("src") || "";
    const alt = node.getAttribute("alt") || "";
    if (!src.startsWith("/api/public/media/")) { node.remove(); return; }
    node.setAttribute("data-editor-src", src);
    if (alt) node.setAttribute("data-editor-alt", alt);
  });
  visit(parsed.body);
  parsed.body.querySelectorAll("a[data-editor-href]").forEach((node) => {
    node.setAttribute("href", node.getAttribute("data-editor-href")); node.removeAttribute("data-editor-href");
  });
  parsed.body.querySelectorAll("img[data-editor-src]").forEach((node) => {
    node.setAttribute("src", node.getAttribute("data-editor-src")); node.removeAttribute("data-editor-src");
    if (node.hasAttribute("data-editor-alt")) { node.setAttribute("alt", node.getAttribute("data-editor-alt")); node.removeAttribute("data-editor-alt"); }
  });
  return parsed.body.innerHTML;
}

export function sanitizedEditorPlainText(html) {
  return sanitizeEditorHtml(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
