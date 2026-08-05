const ALLOWED_TAGS = new Set(["P", "H2", "H3", "H4", "UL", "OL", "LI", "STRONG", "EM", "BLOCKQUOTE", "A", "IMG", "FIGURE", "FIGCAPTION", "BR"]);
const DROP_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE"]);
const MEDIA_PATH = /^\/api\/public\/media\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function meaningfulFigureNodes(figure) {
  return [...figure.childNodes].filter((node) => (
    node.nodeType !== Node.TEXT_NODE || String(node.nodeValue || "").trim()
  ));
}

function canonicalizeManagedFigures(body) {
  const document = body.ownerDocument;
  const figures = [...body.querySelectorAll("figure")].reverse();
  figures.forEach((figure) => {
    const nodes = meaningfulFigureNodes(figure);
    const bvid = figure.getAttribute("data-bilibili-video");
    if (bvid !== null) {
      const caption = nodes.length === 1 && nodes[0]?.tagName === "FIGCAPTION"
        ? nodes[0]
        : null;
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
    const image = nodes[0];
    const caption = nodes[1];
    const canonical = (nodes.length === 1 || nodes.length === 2)
      && image?.nodeType === Node.ELEMENT_NODE
      && image.tagName === "IMG"
      && (nodes.length === 1 || (
        caption?.nodeType === Node.ELEMENT_NODE
        && caption.tagName === "FIGCAPTION"
      ));

    if (canonical) {
      const rebuilt = document.createElement("figure");
      const rebuiltImage = document.createElement("img");
      rebuiltImage.setAttribute("src", image.getAttribute("src"));
      rebuiltImage.setAttribute("alt", image.getAttribute("alt") || "");
      rebuilt.append(rebuiltImage);
      const captionText = caption?.textContent || "";
      if (captionText) {
        const rebuiltCaption = document.createElement("figcaption");
        rebuiltCaption.textContent = captionText;
        rebuilt.append(rebuiltCaption);
      }
      figure.replaceWith(rebuilt);
      return;
    }

    const preserved = document.createDocumentFragment();
    [...figure.childNodes].forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "IMG") return;
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "FIGCAPTION") {
        preserved.append(...node.childNodes);
        return;
      }
      preserved.append(node);
    });
    figure.replaceWith(preserved);
  });

  body.querySelectorAll("img").forEach((image) => {
    if (image.parentElement?.tagName !== "FIGURE") image.remove();
  });
  body.querySelectorAll("figcaption").forEach((caption) => {
    if (caption.parentElement?.tagName !== "FIGURE") caption.replaceWith(...caption.childNodes);
  });
}

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
    if (!MEDIA_PATH.test(src)) { node.remove(); return; }
    node.setAttribute("data-editor-src", src);
    node.setAttribute("data-editor-alt", alt);
  });
  parsed.body.querySelectorAll("figure[data-bilibili-video]").forEach((node) => {
    node.setAttribute("data-editor-bilibili", node.getAttribute("data-bilibili-video") || "");
    node.setAttribute(
      "data-editor-video-title",
      node.querySelector(":scope > figcaption")?.textContent?.trim() || ""
    );
  });
  visit(parsed.body);
  parsed.body.querySelectorAll("a[data-editor-href]").forEach((node) => {
    node.setAttribute("href", node.getAttribute("data-editor-href")); node.removeAttribute("data-editor-href");
  });
  parsed.body.querySelectorAll("img[data-editor-src]").forEach((node) => {
    node.setAttribute("src", node.getAttribute("data-editor-src")); node.removeAttribute("data-editor-src");
    if (node.hasAttribute("data-editor-alt")) { node.setAttribute("alt", node.getAttribute("data-editor-alt")); node.removeAttribute("data-editor-alt"); }
  });
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
  canonicalizeManagedFigures(parsed.body);
  return parsed.body.innerHTML;
}

export function sanitizedEditorPlainText(html) {
  return sanitizeEditorHtml(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
