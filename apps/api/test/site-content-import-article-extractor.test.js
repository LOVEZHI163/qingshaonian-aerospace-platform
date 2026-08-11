import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractImportedArticle } from "../src/services/site-content-import/article-extractor.js";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "site-content-import");

async function fixture(name) {
  return fs.readFile(path.join(fixtureRoot, name), "utf8");
}

test("extracts wechat metadata, body and lazy-loaded images", async () => {
  const article = extractImportedArticle({
    html: await fixture("wechat-article.html"),
    finalUrl: "https://mp.weixin.qq.com/s/ExampleArticle?from=share"
  });

  assert.equal(article.sourceType, "wechat");
  assert.equal(article.title, "青少年航空比赛正式启动");
  assert.equal(article.summary, "这是一篇用于导入测试的微信文章摘要。");
  assert.equal(article.sourceName, "温州青少年航空");
  assert.equal(article.sourceAuthor, "温州青少年航空");
  assert.equal(article.sourcePublishedAt, "2026-08-10T01:30:00.000Z");
  assert.equal(article.canonicalUrl, "https://mp.weixin.qq.com/s/ExampleArticle");
  assert.deepEqual(article.images, [
    {
      id: "IMG1",
      url: "https://mmbiz.qpic.cn/mmbiz_jpg/article-main/0?wx_fmt=jpeg",
      alt: "比赛现场",
      title: ""
    },
    {
      id: "IMG2",
      url: "https://mmbiz.qpic.cn/mmbiz_png/qrcode/0?wx_fmt=png",
      alt: "二维码",
      title: ""
    }
  ]);
  assert.match(article.bodyTemplateHtml, /<img src="@@SITE_IMPORT_IMAGE:IMG1@@" alt="比赛现场"/);
  assert.doesNotMatch(article.bodyTemplateHtml, /mmbiz\.qpic\.cn|iframe|script/i);
});

test("extracts a generic news article from structured metadata and readability content", async () => {
  const article = extractImportedArticle({
    html: await fixture("generic-news.html"),
    finalUrl: "https://news.example.cn/education/aerospace.html?utm_source=test"
  });

  assert.equal(article.sourceType, "web");
  assert.equal(article.title, "航空科普活动走进校园");
  assert.equal(article.summary, "学生在活动中学习航空知识并体验飞行模型。");
  assert.equal(article.sourceName, "温州教育新闻网");
  assert.equal(article.sourceAuthor, "王老师");
  assert.equal(article.sourcePublishedAt, "2026-08-09T00:00:00.000Z");
  assert.equal(article.canonicalUrl, "https://news.example.cn/education/aerospace.html?utm_source=test");
  assert.deepEqual(article.images, [{
    id: "IMG1",
    url: "https://news.example.cn/images/classroom.webp",
    alt: "航空课堂",
    title: ""
  }]);
  assert.match(article.bodyTemplateHtml, /学生参加航空科普课堂/);
  assert.doesNotMatch(article.bodyTemplateHtml, /site-logo|tracker|https:\/\/news\.example\.cn\/images/);
});

test("removes executable html, external players and unsafe image sources", async () => {
  const article = extractImportedArticle({
    html: await fixture("malicious-page.html"),
    finalUrl: "https://news.example.cn/unsafe"
  });

  assert.equal(article.title, "不安全页面");
  assert.match(article.bodyTemplateHtml, /应当保留的正文/);
  assert.deepEqual(article.images, []);
  assert.doesNotMatch(article.bodyTemplateHtml, /script|style|form|input|iframe|video|onclick|onmouseover|onerror|javascript:/i);
  assert.doesNotMatch(article.bodyTemplateHtml, /bilibili/i);
});

test("resolves safe article links and removes unsafe link protocols", () => {
  const article = extractImportedArticle({
    finalUrl: "https://news.example.cn/path/article.html",
    html: `<!doctype html><html><head><title>链接测试文章</title></head><body><article>
      <p>这是一段足够明确的正文，用于验证文章链接的安全转换。</p>
      <p><a href="../rules">查看规则</a> <a href="javascript:alert(1)">危险链接</a></p>
    </article></body></html>`
  });

  assert.match(article.bodyTemplateHtml, /href="https:\/\/news\.example\.cn\/rules"/);
  assert.doesNotMatch(article.bodyTemplateHtml, /javascript:/i);
});

test("returns a stable error when no article body can be identified", () => {
  assert.throws(
    () => extractImportedArticle({
      finalUrl: "https://news.example.cn/empty",
      html: "<!doctype html><html><head><title>空页面</title></head><body><nav>只有导航</nav></body></html>"
    }),
    (error) => error?.status === 422 && error?.code === "IMPORT_ARTICLE_NOT_FOUND"
  );
});
