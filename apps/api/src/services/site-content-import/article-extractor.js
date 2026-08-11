import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import sanitizeHtml from "sanitize-html";

const ARTICLE_TYPES = new Set(["Article", "NewsArticle", "BlogPosting", "ReportageNewsArticle"]);
const REMOVED_NODES = "script,style,iframe,form,input,button,video,audio,source,object,embed,noscript,svg,canvas,template";
const BODY_TAGS = ["p", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em", "blockquote", "a", "img", "figure", "figcaption", "br"];

function extractionError() {
  return Object.assign(new Error("未能识别网页正文，请检查链接后重试"), {
    status: 422,
    code: "IMPORT_ARTICLE_NOT_FOUND"
  });
}

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function metaContent(document, ...selectors) {
  for (const selector of selectors) {
    const value = text(document.querySelector(selector)?.getAttribute("content"));
    if (value) return value;
  }
  return "";
}

function structuredObjects(value) {
  if (Array.isArray(value)) return value.flatMap(structuredObjects);
  if (!value || typeof value !== "object") return [];
  return [value, ...structuredObjects(value["@graph"])];
}

function structuredArticle(document) {
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(node.textContent || "null");
      const match = structuredObjects(parsed).find((entry) => {
        const types = Array.isArray(entry["@type"]) ? entry["@type"] : [entry["@type"]];
        return types.some((typeName) => ARTICLE_TYPES.has(typeName));
      });
      if (match) return match;
    } catch {
      // Ignore invalid publisher metadata and continue with the document.
    }
  }
  return {};
}

function entityName(value) {
  if (Array.isArray(value)) return value.map(entityName).filter(Boolean).join("、");
  if (value && typeof value === "object") return text(value.name);
  return text(value);
}

function isoDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const chinese = raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s+(\d{1,2}):(\d{2}))?/);
  if (chinese) {
    const [, year, month, day, hour = "0", minute = "0"] = chinese;
    const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute));
    return new Date(utc).toISOString();
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function absoluteHttpUrl(value, baseUrl) {
  try {
    const url = new URL(String(value || ""), baseUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function canonicalUrl(document, finalUrl) {
  const candidate = metaContent(document, 'meta[property="og:url"]')
    || document.querySelector('link[rel~="canonical"]')?.getAttribute("href")
    || finalUrl;
  return absoluteHttpUrl(candidate, finalUrl) || new URL(finalUrl).href;
}

function cloneWechatBody(document) {
  return document.querySelector("#js_content")?.cloneNode(true) || null;
}

function genericBody(document) {
  let readable = null;
  try {
    readable = new Readability(document.cloneNode(true)).parse();
  } catch {
    readable = null;
  }
  const explicitArticle = document.querySelector("article, main");
  if (explicitArticle) {
    return { root: explicitArticle.cloneNode(true), readable };
  }
  if (text(readable?.textContent).length >= 80) {
    const container = document.createElement("div");
    container.innerHTML = readable.content;
    return { root: container, readable };
  }
  return { root: null, readable };
}

function prepareLinks(root, finalUrl) {
  for (const anchor of root.querySelectorAll("a")) {
    const raw = anchor.getAttribute("href") || "";
    try {
      const resolved = new URL(raw, finalUrl);
      if (!["http:", "https:", "mailto:"].includes(resolved.protocol)) throw new Error("unsafe");
      anchor.setAttribute("href", resolved.href);
    } catch {
      anchor.removeAttribute("href");
    }
  }
}

function prepareImages(root, finalUrl) {
  const images = [];
  const byUrl = new Map();
  for (const node of root.querySelectorAll("img")) {
    const raw = node.getAttribute("data-src")
      || node.getAttribute("data-original")
      || node.getAttribute("data-lazy-src")
      || node.getAttribute("src")
      || "";
    const url = absoluteHttpUrl(raw, finalUrl);
    if (!url) {
      node.remove();
      continue;
    }
    let image = byUrl.get(url);
    if (!image) {
      image = {
        id: `IMG${images.length + 1}`,
        url,
        alt: text(node.getAttribute("alt")),
        title: text(node.getAttribute("title"))
      };
      byUrl.set(url, image);
      images.push(image);
    }
    const alt = text(node.getAttribute("alt")) || image.alt;
    const title = text(node.getAttribute("title")) || image.title;
    for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
    node.setAttribute("src", `@@SITE_IMPORT_IMAGE:${image.id}@@`);
    if (alt) node.setAttribute("alt", alt);
    if (title) node.setAttribute("title", title);
  }
  return images;
}

function cleanBody(root, finalUrl) {
  for (const node of root.querySelectorAll(REMOVED_NODES)) node.remove();
  prepareLinks(root, finalUrl);
  const images = prepareImages(root, finalUrl);
  const bodyTemplateHtml = sanitizeHtml(root.innerHTML, {
    allowedTags: BODY_TAGS,
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title"]
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    nonTextTags: ["script", "style", "iframe", "form", "video", "audio", "object", "embed"],
    transformTags: { h1: "h2" }
  }).trim();
  const bodyText = text(sanitizeHtml(bodyTemplateHtml, { allowedTags: [], allowedAttributes: {} }));
  if (!bodyText) throw extractionError();
  return { bodyTemplateHtml, images };
}

export function extractImportedArticle({ html, finalUrl }) {
  let dom;
  try {
    dom = new JSDOM(String(html ?? ""), { url: finalUrl });
  } catch {
    throw extractionError();
  }
  try {
    const { document } = dom.window;
    const isWechat = new URL(finalUrl).hostname.toLowerCase() === "mp.weixin.qq.com";
    const structured = structuredArticle(document);
    const readableResult = isWechat ? { root: cloneWechatBody(document), readable: null } : genericBody(document);
    if (!readableResult.root) throw extractionError();

    const title = text(isWechat
      ? document.querySelector("#activity-name")?.textContent
      : structured.headline || metaContent(document, 'meta[property="og:title"]') || readableResult.readable?.title || document.title);
    const summary = text(metaContent(document, 'meta[property="og:description"]', 'meta[name="description"]')
      || structured.description
      || readableResult.readable?.excerpt);
    const wechatName = text(document.querySelector("#js_name")?.textContent);
    const sourceName = text(isWechat
      ? wechatName
      : entityName(structured.publisher) || metaContent(document, 'meta[property="og:site_name"]') || new URL(finalUrl).hostname);
    const sourceAuthor = text(isWechat
      ? metaContent(document, 'meta[name="author"]') || text(document.querySelector("#js_author_name")?.textContent) || wechatName
      : entityName(structured.author) || readableResult.readable?.byline || metaContent(document, 'meta[name="author"]'));
    const sourcePublishedAt = isoDate(isWechat
      ? document.querySelector("#publish_time")?.textContent || metaContent(document, 'meta[property="article:published_time"]')
      : structured.datePublished || metaContent(document, 'meta[property="article:published_time"]'));
    const cleaned = cleanBody(readableResult.root, finalUrl);

    if (!title) throw extractionError();
    return {
      sourceType: isWechat ? "wechat" : "web",
      title,
      summary,
      sourceName,
      sourceAuthor,
      sourcePublishedAt,
      canonicalUrl: canonicalUrl(document, finalUrl),
      bodyTemplateHtml: cleaned.bodyTemplateHtml,
      images: cleaned.images
    };
  } finally {
    dom.window.close();
  }
}
