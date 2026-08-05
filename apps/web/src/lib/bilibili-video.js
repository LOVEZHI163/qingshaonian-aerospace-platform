const BVID_RE = /^BV[0-9A-Za-z]{10}$/;

export function enhanceBilibiliVideos(root) {
  for (const figure of root?.querySelectorAll("figure.content-bilibili-video[data-bilibili-video]") || []) {
    const bvid = figure.getAttribute("data-bilibili-video") || "";
    const title = figure.querySelector(":scope > figcaption")?.textContent?.trim() || "";
    if (!BVID_RE.test(bvid) || !title) continue;

    const frameWrap = document.createElement("div");
    frameWrap.className = "content-bilibili-frame";

    const iframe = document.createElement("iframe");
    iframe.src = `https://player.bilibili.com/player.html?bvid=${bvid}&poster=1&autoplay=0&danmaku=0`;
    iframe.title = `B站视频：${title}`;
    iframe.loading = "lazy";
    iframe.allow = "fullscreen";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    frameWrap.append(iframe);

    const caption = document.createElement("figcaption");
    caption.textContent = title;

    const link = document.createElement("a");
    link.href = `https://www.bilibili.com/video/${bvid}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "在哔哩哔哩打开";

    figure.replaceChildren(frameWrap, caption, link);
  }
}
