export const BILIBILI_BVID_RE = /^BV[0-9A-Za-z]{10}$/;

const VIDEO_HOSTS = new Set(["bilibili.com", "www.bilibili.com", "m.bilibili.com"]);
const INVALID_MESSAGE = "未识别到有效BV号，请粘贴完整B站视频链接或直接输入BV号。";

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
  try {
    url = new URL(value);
  } catch {
    return { ok: false, code: "INVALID", message: INVALID_MESSAGE };
  }

  if (url.hostname.toLowerCase() === "b23.tv") {
    return { ok: false, code: "SHORT_LINK", message: "暂不支持b23.tv短链接，请打开短链接后复制浏览器中的完整视频地址。" };
  }
  if (url.protocol !== "https:" || !VIDEO_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, code: "INVALID", message: "只支持哔哩哔哩完整视频链接。" };
  }

  const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/);
  return match
    ? { ok: true, bvid: match[1], watchUrl: bilibiliWatchUrl(match[1]) }
    : { ok: false, code: "INVALID", message: INVALID_MESSAGE };
}
