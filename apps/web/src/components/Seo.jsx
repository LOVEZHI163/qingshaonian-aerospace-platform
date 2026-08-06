import { useEffect } from "react";

function configuredOrigin(value) {
  if (!value || !String(value).trim()) return null;
  try {
    const url = new URL(String(value).trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function pagePath(value) {
  try {
    const url = new URL(value || "/", "https://local.invalid");
    return url.pathname || "/";
  } catch {
    return "/";
  }
}

function appendMeta(attribute, name, content) {
  if (!content) return null;
  const node = document.createElement("meta");
  node.setAttribute(attribute, name);
  node.content = content;
  node.dataset.publicSeo = "true";
  document.head.append(node);
  return node;
}

function absoluteImage(image, origin) {
  if (!image || !origin) return null;
  try {
    const url = new URL(typeof image === "string" ? image : image.url, origin);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export default function Seo({
  title,
  description,
  pathname = window.location.pathname,
  image = null,
  siteUrl = import.meta.env.VITE_PUBLIC_SITE_URL || "",
  type = "website",
  robots = null,
  canonical = true
}) {
  useEffect(() => {
    const previousTitle = document.title;
    document.head.querySelectorAll('[data-public-seo="true"]').forEach((node) => node.remove());
    document.title = title;

    const nodes = [];
    nodes.push(appendMeta("name", "description", description));
    nodes.push(appendMeta("property", "og:title", title));
    nodes.push(appendMeta("property", "og:description", description));
    nodes.push(appendMeta("property", "og:type", type));
    nodes.push(appendMeta("name", "robots", robots));

    const origin = configuredOrigin(siteUrl);
    if (origin && canonical) {
      const canonical = new URL(pagePath(pathname), origin).href;
      const link = document.createElement("link");
      link.rel = "canonical";
      link.href = canonical;
      link.dataset.publicSeo = "true";
      document.head.append(link);
      nodes.push(link);
      nodes.push(appendMeta("property", "og:url", canonical));
    }
    nodes.push(appendMeta("property", "og:image", absoluteImage(image, origin)));

    return () => {
      nodes.filter(Boolean).forEach((node) => {
        if (node.dataset.publicSeo === "true") node.remove();
      });
      document.title = previousTitle;
    };
  }, [canonical, description, image, pathname, robots, siteUrl, title, type]);

  return null;
}
