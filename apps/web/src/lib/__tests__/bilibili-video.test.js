import { describe, expect, it } from "vitest";

import { enhanceBilibiliVideos } from "../bilibili-video.js";

describe("公开 B站播放器", () => {
  it("enhances a valid canonical marker into the fixed lazy player and fallback link", () => {
    const root = document.createElement("div");
    root.innerHTML = '<figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV"><figcaption>比赛回顾</figcaption></figure>';

    enhanceBilibiliVideos(root);

    const frame = root.querySelector("iframe");
    expect(frame.src).toBe("https://player.bilibili.com/player.html?bvid=BV1B7411m7LV&poster=1&autoplay=0&danmaku=0");
    expect(frame.loading).toBe("lazy");
    expect(frame.title).toBe("B站视频：比赛回顾");
    expect(frame.allow).toBe("fullscreen");
    expect(frame.allowFullscreen).toBe(true);
    expect(frame.referrerPolicy).toBe("strict-origin-when-cross-origin");
    expect(root.querySelector(".content-bilibili-frame > iframe")).toBe(frame);
    expect(root.querySelector("figcaption")).toHaveTextContent("比赛回顾");
    expect(root.querySelector('a[target="_blank"]')).toHaveAttribute("href", "https://www.bilibili.com/video/BV1B7411m7LV");
    expect(root.querySelector('a[target="_blank"]')).toHaveAttribute("rel", "noopener noreferrer");
    expect(root.querySelector('a[target="_blank"]')).toHaveTextContent("在哔哩哔哩打开");
  });

  it("leaves invalid, empty-title, and non-canonical markers harmless", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <figure class="content-bilibili-video" data-bilibili-video="javascript:bad"><figcaption>恶意</figcaption></figure>
      <figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV"><figcaption> </figcaption></figure>
      <figure data-bilibili-video="BV1B7411m7LV"><figcaption>缺少精确类名</figcaption></figure>
      <div class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV"><figcaption>错误标签</figcaption></div>
    `;

    enhanceBilibiliVideos(root);

    expect(root.querySelector("iframe")).toBeNull();
    expect(root.querySelectorAll(".content-bilibili-frame")).toHaveLength(0);
  });

  it("enhances every valid marker independently and uses text-only captions", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <figure class="content-bilibili-video" data-bilibili-video="BV1B7411m7LV"><figcaption>第一段 <strong>集锦</strong></figcaption></figure>
      <figure class="content-bilibili-video" data-bilibili-video="BV17x411w7KC"><figcaption>第二段回顾</figcaption></figure>
    `;

    enhanceBilibiliVideos(root);

    expect(root.querySelectorAll("iframe")).toHaveLength(2);
    expect([...root.querySelectorAll("iframe")].map((frame) => frame.title)).toEqual([
      "B站视频：第一段 集锦",
      "B站视频：第二段回顾"
    ]);
    expect(root.querySelector("figcaption strong")).toBeNull();
    expect([...root.querySelectorAll("figcaption")].map((caption) => caption.textContent)).toEqual([
      "第一段 集锦",
      "第二段回顾"
    ]);
  });
});
