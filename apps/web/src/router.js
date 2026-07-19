import { useEffect, useState } from "react";

const decodeSlug = (value) => {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !decoded.includes("/") ? decoded : null;
  } catch {
    return null;
  }
};

const EVENT_FILTER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{0,127})$/;

export function parsePublicListLocation(location) {
  const url = new URL(location || "/", window.location.origin);
  const eventValues = url.searchParams.getAll("event");
  const event = eventValues.length === 1 && EVENT_FILTER_PATTERN.test(eventValues[0])
    ? eventValues[0]
    : null;
  const pageValues = url.searchParams.getAll("page");
  const pageText = pageValues.length === 1 ? pageValues[0] : "";
  const page = /^[1-9]\d{0,5}$/.test(pageText) ? Number(pageText) : 1;
  return { event, page };
}

export function publicContentListPath(type, page, event) {
  const params = new URLSearchParams({ type, page: String(page), pageSize: "10" });
  if (event) params.set("event", event);
  return `/api/public/content?${params.toString()}`;
}

export function navigatePublicListPage(location, page, event) {
  const url = new URL(location || window.location.href, window.location.origin);
  url.searchParams.set("page", String(page));
  url.searchParams.delete("event");
  if (event) url.searchParams.set("event", event);
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.pushState({}, "", next);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function matchRoute(pathname) {
  if (pathname === "/") return { name: "home", params: {} };
  if (pathname === "/announcements") return { name: "announcements", params: {} };
  if (pathname === "/news") return { name: "news", params: {} };
  if (pathname === "/history") return { name: "history", params: {} };

  const eventMatch = pathname.match(/^\/events\/([^/]+)\/?$/);
  if (eventMatch) {
    const slug = decodeSlug(eventMatch[1]);
    return slug ? { name: "event", params: { slug } } : { name: "not-found", params: {} };
  }

  const contentMatch = pathname.match(/^\/content\/([^/]+)\/?$/);
  if (contentMatch) {
    const slug = decodeSlug(contentMatch[1]);
    return slug ? { name: "content", params: { slug } } : { name: "not-found", params: {} };
  }

  return { name: "not-found", params: {} };
}

const getAnchor = (target) => {
  if (!(target instanceof Element)) return null;
  return target.closest("a[href]");
};

export function shouldHandleLinkClick(event) {
  const anchor = getAnchor(event.target);
  if (!anchor || event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.dataset.routerIgnore === "true") return false;
  if (anchor.hasAttribute("download")) return false;
  if (anchor.target && anchor.target.toLowerCase() !== "_self") return false;

  const url = new URL(anchor.href, window.location.href);
  return url.origin === window.location.origin;
}

const currentLocation = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

export function useRouter() {
  const [location, setLocation] = useState(currentLocation);

  useEffect(() => {
    const handlePopState = () => setLocation(currentLocation());
    const handleClick = (event) => {
      if (!shouldHandleLinkClick(event)) return;
      const anchor = getAnchor(event.target);
      const url = new URL(anchor.href, window.location.href);
      event.preventDefault();
      window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
      setLocation(currentLocation());
    };

    window.addEventListener("popstate", handlePopState);
    document.addEventListener("click", handleClick);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("click", handleClick);
    };
  }, []);

  return {
    location,
    route: matchRoute(window.location.pathname)
  };
}
