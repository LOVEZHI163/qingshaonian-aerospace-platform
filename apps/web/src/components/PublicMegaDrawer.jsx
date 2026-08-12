import React, { useLayoutEffect, useRef, useState } from "react";
import { eventScopedPath, navigationHref } from "../lib/public-navigation.js";

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

export default function PublicMegaDrawer({ item, open, activeEvent, currentPath, onClose }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  const animationFrameRef = useRef(null);
  const hideTimerRef = useRef(null);

  useLayoutEffect(() => {
    const cancelPending = () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame?.(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    };
    const reducedMotion = window.matchMedia?.(REDUCED_MOTION_QUERY).matches;

    cancelPending();
    if (open) {
      setMounted(true);
      if (reducedMotion) {
        setVisible(true);
        return cancelPending;
      }
      animationFrameRef.current = window.requestAnimationFrame?.(() => {
        animationFrameRef.current = null;
        setVisible(true);
      }) ?? null;
      return cancelPending;
    }

    setVisible(false);
    if (!mounted || reducedMotion) {
      setMounted(false);
      return cancelPending;
    }
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setMounted(false);
    }, DRAWER_TRANSITION_MS);
    return cancelPending;
  }, [mounted, open]);

  useLayoutEffect(() => () => {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame?.(animationFrameRef.current);
    window.clearTimeout(hideTimerRef.current);
  }, []);

  const currentLocation = normalizedDrawerLocation(eventScopedPath(currentPath, activeEvent));

  return (
    <div
      id={`public-drawer-${item.id}`}
      className="public-mega-drawer"
      data-group-id={item.id}
      data-navigation-hover-group={item.id}
      data-open={visible || undefined}
      aria-hidden={!open}
      inert={!open ? "" : undefined}
      hidden={!mounted}
      style={{ "--drawer-transition-duration": `${DRAWER_TRANSITION_MS}ms` }}
    >
      <div className="public-mega-drawer-inner">
        <nav aria-label={`${item.label}子导航`}>
          <ul>
            {item.children.map((child) => {
              const href = navigationHref(child, activeEvent);
              return (
                <li key={child.id}>
                  <a
                    href={href}
                    data-router-ignore={child.accountView ? "true" : undefined}
                    aria-current={currentLocation === normalizedDrawerLocation(href) ? "page" : undefined}
                    onClick={onClose}
                  >
                    {child.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </div>
  );
}
