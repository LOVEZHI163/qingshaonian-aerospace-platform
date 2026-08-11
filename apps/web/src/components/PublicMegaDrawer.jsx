import React, { useLayoutEffect, useRef, useState } from "react";
import {
  accountEntry,
  eventScopedPath,
  PUBLIC_NAVIGATION_GROUPS
} from "../lib/public-navigation.js";

const DRAWER_QUERY_KEYS = ["event", "type"];
const DRAWER_TRANSITION_MS = 200;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function normalizedDrawerLocation(location) {
  try {
    const url = new URL(location || "/", window.location.origin);
    const params = new URLSearchParams();
    DRAWER_QUERY_KEYS.forEach((key) => {
      url.searchParams.getAll(key).sort().forEach((value) => params.append(key, value));
    });
    params.sort();
    const query = params.toString();
    return `${url.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return "/";
  }
}

export default function PublicMegaDrawer({ open, activeEvent, events, currentPath, onClose }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  const animationFrameRef = useRef(null);
  const hideTimerRef = useRef(null);

  useLayoutEffect(() => {
    const cancelPendingAnimation = () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame?.(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    };
    const reducedMotion = window.matchMedia?.(REDUCED_MOTION_QUERY).matches;

    cancelPendingAnimation();
    if (open) {
      setMounted(true);
      if (reducedMotion) {
        setVisible(true);
        return undefined;
      }
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = null;
        setVisible(true);
      });
      return cancelPendingAnimation;
    }

    setVisible(false);
    if (!mounted || reducedMotion) {
      setMounted(false);
      return undefined;
    }
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setMounted(false);
    }, DRAWER_TRANSITION_MS);
    return cancelPendingAnimation;
  }, [mounted, open]);

  useLayoutEffect(() => () => {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame?.(animationFrameRef.current);
    window.clearTimeout(hideTimerRef.current);
  }, []);

  const theme = activeEvent?.theme || activeEvent?.slogan || "科技强国，未来有我";
  const currentLocation = normalizedDrawerLocation(eventScopedPath(currentPath, activeEvent));
  const hrefFor = (link) => link.accountView
    ? accountEntry(link.accountView, activeEvent)
    : eventScopedPath(link.path, activeEvent);

  return (
    <div
      id="public-mega-drawer"
      className="public-mega-drawer"
      data-open={visible || undefined}
      aria-hidden={!open}
      inert={!open ? "" : undefined}
      hidden={!mounted}
      style={{ "--drawer-transition-duration": `${DRAWER_TRANSITION_MS}ms` }}
    >
      <div className="public-mega-drawer-inner">
        <nav aria-label="赛事导航">
          {PUBLIC_NAVIGATION_GROUPS.map((group) => (
            <section className="public-mega-drawer-group" key={group.label}>
              <h2>{group.label}</h2>
              <ul>
                {group.links.map((link) => {
                  const href = hrefFor(link);
                  return (
                    <li key={`${group.label}:${link.label}`}>
                      <a
                        href={href}
                        data-router-ignore={link.accountView ? "true" : undefined}
                        onClick={onClose}
                        aria-current={currentLocation === normalizedDrawerLocation(href) ? "page" : undefined}
                      >
                        {link.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </nav>
        <aside className="public-mega-drawer-featured">
          <p>{theme}</p>
          <strong>{activeEvent?.name || "温州少航赛事平台"}</strong>
          {events.length > 1 ? (
            <div aria-label="切换赛事">
              {events.map((event) => (
                <a
                  key={event.id}
                  href={eventScopedPath("/about", event)}
                  aria-current={
                    (event.id && event.id === activeEvent?.id) || (event.slug && event.slug === activeEvent?.slug)
                      ? "page"
                      : undefined
                  }
                  onClick={onClose}
                >
                  {event.name}
                </a>
              ))}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
