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
const PUBLIC_NEWS_TYPES = new Set(["news", "work"]);

export function parsePublicListLocation(location) {
  const url = new URL(location || "/", window.location.origin);
  const eventValues = url.searchParams.getAll("event");
  const event = eventValues.length === 1 && EVENT_FILTER_PATTERN.test(eventValues[0])
    ? eventValues[0]
    : null;
  const pageValues = url.searchParams.getAll("page");
  const pageText = pageValues.length === 1 ? pageValues[0] : "";
  const page = /^[1-9]\d{0,5}$/.test(pageText) ? Number(pageText) : 1;
  const eventPageValues = url.searchParams.getAll("eventsPage");
  const eventPageText = eventPageValues.length === 1 ? eventPageValues[0] : "";
  const eventsPage = /^[1-9]\d{0,5}$/.test(eventPageText) ? Number(eventPageText) : 1;
  const typeValues = url.pathname === "/news" ? url.searchParams.getAll("type") : [];
  const type = typeValues.length === 1 && PUBLIC_NEWS_TYPES.has(typeValues[0])
    ? typeValues[0]
    : "news";
  return { event, page, eventsPage, type };
}

export function publicContentListPath(type, page, event) {
  const params = new URLSearchParams({ type, page: String(page), pageSize: "10" });
  if (event) params.set("event", event);
  return `/api/public/content?${params.toString()}`;
}

export function publicHistoryEventsPath(page) {
  return `/api/public/events?page=${page}&pageSize=6`;
}

function navigatePublicList(location, { page, event, type }) {
  const url = new URL(location || window.location.href, window.location.origin);
  url.searchParams.set("page", String(page));
  url.searchParams.delete("event");
  if (event) url.searchParams.set("event", event);
  url.searchParams.delete("type");
  if (PUBLIC_NEWS_TYPES.has(type)) url.searchParams.set("type", type);
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.pushState({}, "", next);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigatePublicListPage(location, page, event, type) {
  navigatePublicList(location, { page, event, type });
}

export function navigatePublicListType(location, type, event) {
  navigatePublicList(location, { page: 1, event, type });
}

export function navigateHistoryEventsPage(location, page) {
  const url = new URL(location || window.location.href, window.location.origin);
  url.searchParams.set("eventsPage", String(page));
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.pushState({}, "", next);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function matchRoute(pathname) {
  if (pathname === "/") return { name: "home", params: {} };
  if (pathname === "/about") return { name: "event-information", params: { section: "about" } };
  if (pathname === "/rules") return { name: "event-information", params: { section: "rules" } };
  if (pathname === "/registration-guide") return { name: "event-information", params: { section: "registration" } };
  if (pathname === "/contact") return { name: "event-information", params: { section: "contact" } };
  if (pathname === "/projects") return { name: "event-information", params: { section: "projects" } };
  if (pathname === "/announcements") return { name: "announcements", params: {} };
  if (pathname === "/news") return { name: "news", params: {} };
  if (pathname === "/history") return { name: "history", params: {} };
  if (pathname === "/preview") return { name: "preview", params: {} };

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

export function focusHashTarget(hash = window.location.hash) {
  if (!hash || hash === "#") return false;
  let id;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return false;
  }
  const target = id ? document.getElementById(id) : null;
  if (!target) return false;
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "start" });
  return document.activeElement === target;
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
      const next = `${url.pathname}${url.search}${url.hash}`;
      const repeatedLocation = next === currentLocation();
      event.preventDefault();
      window.history.pushState({}, "", next);
      setLocation(currentLocation());
      if (repeatedLocation && url.hash) focusHashTarget(url.hash);
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
