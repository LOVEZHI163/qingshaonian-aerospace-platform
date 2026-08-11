import React, { useEffect, useRef, useState } from "react";
import PublicMegaDrawer from "./PublicMegaDrawer.jsx";
import {
  accountEntry,
  eventScopedPath,
  publicEventOptions,
  selectedPublicEvent
} from "../lib/public-navigation.js";

const BRAND_NAME = "温州市青少年航空航天创新比赛";
const MOBILE_NAVIGATION_QUERY = "(max-width: 1120px)";
const HOVER_NAVIGATION_QUERY = "(hover: hover) and (pointer: fine)";

export default function SiteHeader({ routeKey, homeData, homeStatus }) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [lockedOpen, setLockedOpen] = useState(false);
  const menuOpen = hoverOpen || lockedOpen;
  const menuButtonRef = useRef(null);
  const navigationZoneRef = useRef(null);
  const closeTimerRef = useRef(null);
  const focusDrawerOnOpenRef = useRef(false);
  const currentPath = (() => {
    try { return new URL(routeKey || "/", window.location.origin).pathname; }
    catch { return "/"; }
  })();
  const events = publicEventOptions(homeData);
  const activeEvent = selectedPublicEvent(homeData, routeKey);
  const primaryLinks = [
    { label: "首页", href: "/" },
    { label: "关于大赛", href: eventScopedPath("/about", activeEvent) },
    { label: "赛事资讯", href: eventScopedPath("/news", activeEvent) },
    { label: "获奖查询", href: accountEntry("certificates", activeEvent), routerIgnore: true },
    { label: "联系我们", href: eventScopedPath("/contact", activeEvent) },
    { label: "报名入口", href: accountEntry("eventCenter", activeEvent), routerIgnore: true }
  ];

  const cancelClose = () => {
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const closeMenu = () => {
    cancelClose();
    setHoverOpen(false);
    setLockedOpen(false);
  };
  const openFromHover = () => {
    if (!window.matchMedia?.(HOVER_NAVIGATION_QUERY).matches) return;
    cancelClose();
    setHoverOpen(true);
  };
  const scheduleHoverClose = () => {
    if (lockedOpen) return;
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setHoverOpen(false), 300);
  };

  useEffect(() => {
    cancelClose();
    setHoverOpen(false);
    setLockedOpen(false);
  }, [routeKey]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    if (focusDrawerOnOpenRef.current) {
      focusDrawerOnOpenRef.current = false;
      navigationZoneRef.current?.querySelector("#public-mega-drawer a[href]")?.focus();
    }
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      closeMenu();
      menuButtonRef.current?.focus();
    };
    const handlePointerDown = (event) => {
      if (navigationZoneRef.current?.contains(event.target)) return;
      closeMenu();
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const mediaQuery = window.matchMedia?.(MOBILE_NAVIGATION_QUERY);
    if (!mediaQuery) return undefined;
    const previousOverflow = document.body.style.overflow;
    const syncBodyScroll = () => {
      document.body.style.overflow = mediaQuery.matches ? "hidden" : previousOverflow;
    };
    syncBodyScroll();
    mediaQuery.addEventListener?.("change", syncBodyScroll);
    return () => {
      mediaQuery.removeEventListener?.("change", syncBodyScroll);
      document.body.style.overflow = previousOverflow;
    };
  }, [menuOpen]);

  useEffect(() => () => cancelClose(), []);

  const toggleLockedOpen = () => {
    if (lockedOpen) {
      closeMenu();
      return;
    }
    if (menuOpen) {
      navigationZoneRef.current?.querySelector("#public-mega-drawer a[href]")?.focus();
    } else {
      focusDrawerOnOpenRef.current = true;
    }
    setLockedOpen(true);
  };

  return (
    <header
      ref={navigationZoneRef}
      className="site-header"
      role="banner"
      data-testid="public-navigation-zone"
      onMouseEnter={openFromHover}
      onMouseLeave={scheduleHoverClose}
    >
      <div className="site-header-inner">
        <a className="brand" href="/" aria-label="网站首页">
          <img className="brand-mark" src="/brand/mark.svg" alt="" />
          <img className="brand-wordmark" src="/brand/wordmark.svg" alt={BRAND_NAME} />
        </a>

        <button
          ref={menuButtonRef}
          className="menu-trigger"
          type="button"
          aria-label={lockedOpen ? "关闭赛事导航" : hoverOpen ? "固定赛事导航" : "打开赛事导航"}
          aria-expanded={menuOpen}
          aria-controls="public-mega-drawer"
          onClick={toggleLockedOpen}
        >
          <span aria-hidden="true">{menuOpen ? "×" : "☰"}</span>
        </button>

        <div id="site-navigation" className="site-navigation" data-open={menuOpen || undefined}>
          <p className="mobile-brand-name">{BRAND_NAME}</p>
          <div className="header-actions">
            <a className="login-link" href="/admin/" data-router-ignore="true" onClick={closeMenu}>用户登录</a>
          </div>
          <nav aria-label="主导航">
            {primaryLinks.map((link) => (
              <a
                className={link.label === "报名入口" ? "registration-link" : undefined}
                href={link.href}
                data-router-ignore={link.routerIgnore ? "true" : undefined}
                aria-current={currentPath === new URL(link.href, window.location.origin).pathname ? "page" : undefined}
                key={link.label}
                onClick={closeMenu}
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>
      </div>
      <PublicMegaDrawer
        open={menuOpen}
        activeEvent={activeEvent}
        events={events}
        currentPath={routeKey || "/"}
        onClose={closeMenu}
      />
    </header>
  );
}
