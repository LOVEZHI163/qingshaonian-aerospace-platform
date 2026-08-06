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
