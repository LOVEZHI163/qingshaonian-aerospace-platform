import React, { useEffect, useRef, useState } from "react";
import PublicMegaDrawer from "./PublicMegaDrawer.jsx";
import {
  activePrimaryNavigationLabel,
  navigationHref,
  PUBLIC_PRIMARY_NAVIGATION,
  selectedPublicEvent
} from "../lib/public-navigation.js";

const BRAND_NAME = "温州市青少年航空航天创新比赛";
const MOBILE_BRAND_NAME = "温州少航";
const MOBILE_NAVIGATION_QUERY = "(max-width: 1280px)";
const HOVER_NAVIGATION_QUERY = "(hover: hover) and (pointer: fine)";
const HOVER_CLOSE_DELAY_MS = 300;

export default function SiteHeader({ routeKey, homeData }) {
  const [hoverGroupId, setHoverGroupId] = useState(null);
  const [lockedGroupId, setLockedGroupId] = useState(null);
  const [focusGroupId, setFocusGroupId] = useState(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileGroupId, setMobileGroupId] = useState(null);
  const openGroupId = hoverGroupId || lockedGroupId;
  const navigationZoneRef = useRef(null);
  const mobilePanelRef = useRef(null);
  const menuButtonRef = useRef(null);
  const triggerRefs = useRef(new Map());
  const closeTimerRef = useRef(null);
  const activeEvent = selectedPublicEvent(homeData, routeKey);
  const activePrimaryLabel = activePrimaryNavigationLabel(routeKey);

  const cancelHoverClose = () => {
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const closeDesktopNavigation = () => {
    cancelHoverClose();
    setHoverGroupId(null);
    setLockedGroupId(null);
  };

  const closeMobileNavigation = () => {
    setMobileOpen(false);
    setMobileGroupId(null);
  };

  const closeAllNavigation = () => {
    closeDesktopNavigation();
    closeMobileNavigation();
  };

  const openFromHover = (groupId) => {
    if (!window.matchMedia?.(HOVER_NAVIGATION_QUERY).matches) return;
    cancelHoverClose();
    setHoverGroupId(groupId);
  };

  const scheduleHoverClose = () => {
    cancelHoverClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setHoverGroupId(null);
    }, HOVER_CLOSE_DELAY_MS);
  };

  const toggleDesktopGroup = (groupId) => {
    cancelHoverClose();
    setFocusGroupId(lockedGroupId === groupId ? null : groupId);
    setHoverGroupId(null);
    setLockedGroupId((current) => current === groupId ? null : groupId);
  };

  const handleDesktopTriggerKeyDown = (event, groupId) => {
    if (event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    toggleDesktopGroup(groupId);
  };

  const handleHoverOver = (event) => {
    const zone = event.target.closest?.("[data-navigation-hover-group]");
    if (!zone || !navigationZoneRef.current?.contains(zone)) return;
    openFromHover(zone.dataset.navigationHoverGroup);
  };

  const handleHoverOut = (event) => {
    const zone = event.target.closest?.("[data-navigation-hover-group]");
    if (!zone || !navigationZoneRef.current?.contains(zone)) return;
    const nextZone = event.relatedTarget?.closest?.("[data-navigation-hover-group]");
    if (nextZone?.dataset.navigationHoverGroup === zone.dataset.navigationHoverGroup) return;
    scheduleHoverClose();
  };

  useEffect(() => {
    closeAllNavigation();
  }, [routeKey]);

  useEffect(() => {
    if (!openGroupId && !mobileOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        const focusTarget = mobileOpen
          ? menuButtonRef.current
          : triggerRefs.current.get(openGroupId);
        closeAllNavigation();
        focusTarget?.focus();
        return;
      }
      if (!mobileOpen || event.key !== "Tab") return;
      const focusable = [...(mobilePanelRef.current?.querySelectorAll("button:not([disabled]), a[href]") || [])];
      if (!focusable.length) return;
      const currentIndex = focusable.indexOf(document.activeElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
        : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
      event.preventDefault();
      focusable[nextIndex].focus();
    };
    const handlePointerDown = (event) => {
      if (navigationZoneRef.current?.contains(event.target)) return;
      closeAllNavigation();
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [mobileOpen, openGroupId]);

  useEffect(() => {
    if (!mobileOpen) return undefined;
    mobilePanelRef.current?.querySelector("button:not([disabled]), a[href]")?.focus();
    const mediaQuery = window.matchMedia?.(MOBILE_NAVIGATION_QUERY);
    const previousOverflow = document.body.style.overflow;
    const syncMobileState = () => {
      if (mediaQuery && !mediaQuery.matches) {
        document.body.style.overflow = previousOverflow;
        closeMobileNavigation();
        return;
      }
      document.body.style.overflow = "hidden";
    };
    syncMobileState();
    mediaQuery?.addEventListener?.("change", syncMobileState);
    return () => {
      mediaQuery?.removeEventListener?.("change", syncMobileState);
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileOpen]);

  useEffect(() => () => cancelHoverClose(), []);

  return (
    <header
      ref={navigationZoneRef}
      className="site-header"
      role="banner"
      data-testid="public-navigation-zone"
      onMouseOver={handleHoverOver}
      onMouseOut={handleHoverOut}
    >
      <div className="site-header-inner">
        <a className="brand" href="/" aria-label="网站首页">
          <img className="brand-mark" src="/brand/mark.svg" alt="" />
          <img className="brand-wordmark" src="/brand/wordmark.svg" alt={BRAND_NAME} />
        </a>
        <p className="mobile-brand-name">{MOBILE_BRAND_NAME}</p>

        <button
          ref={menuButtonRef}
          className="menu-trigger"
          type="button"
          aria-label={mobileOpen ? "关闭赛事导航" : "打开赛事导航"}
          aria-expanded={mobileOpen}
          aria-controls="public-mobile-navigation"
          onClick={() => {
            closeDesktopNavigation();
            setMobileOpen((current) => !current);
            if (mobileOpen) setMobileGroupId(null);
          }}
        >
          <span aria-hidden="true">{mobileOpen ? "×" : "☰"}</span>
        </button>

        <div id="site-navigation" className="site-navigation">
          <nav className="primary-navigation-links" aria-label="主导航">
            {PUBLIC_PRIMARY_NAVIGATION.filter((item) => item.id !== "registration").map((item) => {
              const current = activePrimaryLabel === item.label;
              if (item.children?.length > 0) {
                const open = openGroupId === item.id;
                return (
                  <div
                    className="primary-navigation-item"
                    data-navigation-hover-group={item.id}
                    key={item.id}
                  >
                    <button
                      ref={(node) => {
                        if (node) triggerRefs.current.set(item.id, node);
                        else triggerRefs.current.delete(item.id);
                      }}
                      className="primary-navigation-trigger"
                      type="button"
                      aria-expanded={open}
                      aria-controls={`public-drawer-${item.id}`}
                      aria-current={current ? "page" : undefined}
                      onClick={() => toggleDesktopGroup(item.id)}
                      onKeyDown={(event) => handleDesktopTriggerKeyDown(event, item.id)}
                    >
                      {item.label}
                    </button>
                    <PublicMegaDrawer
                      item={item}
                      open={open}
                      activeEvent={activeEvent}
                      currentPath={routeKey || "/"}
                      focusFirstChild={focusGroupId === item.id}
                      onFocusComplete={() => setFocusGroupId(null)}
                      onClose={closeAllNavigation}
                    />
                  </div>
                );
              }
              return (
                <a
                  className={item.id === "registration" ? "registration-link" : undefined}
                  href={navigationHref(item, activeEvent)}
                  data-router-ignore={item.accountView ? "true" : undefined}
                  aria-current={current ? "page" : undefined}
                  key={item.id}
                  onClick={closeAllNavigation}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>
          <div className="header-actions">
            <a className="login-link" href="/admin/" data-router-ignore="true" onClick={closeAllNavigation}>用户登录</a>
            <a
              className="registration-link"
              href={navigationHref(PUBLIC_PRIMARY_NAVIGATION.find((item) => item.id === "registration"), activeEvent)}
              data-router-ignore="true"
              onClick={closeAllNavigation}
            >
              报名入口
            </a>
          </div>
        </div>
      </div>

      <div
        ref={mobilePanelRef}
        id="public-mobile-navigation"
        className="public-mobile-navigation"
        aria-hidden={!mobileOpen}
        inert={!mobileOpen ? "" : undefined}
        hidden={!mobileOpen}
      >
        <div className="public-mega-drawer-inner">
          <nav aria-label="移动端主导航">
            {PUBLIC_PRIMARY_NAVIGATION.filter((item) => item.id !== "registration").map((item) => {
              if (item.children?.length > 0) {
                const expanded = mobileGroupId === item.id;
                return (
                  <div className="mobile-navigation-group" key={item.id}>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={`mobile-navigation-group-${item.id}`}
                      aria-current={activePrimaryLabel === item.label ? "page" : undefined}
                      onClick={() => setMobileGroupId((current) => current === item.id ? null : item.id)}
                    >
                      {item.label}
                    </button>
                    {expanded ? (
                      <div id={`mobile-navigation-group-${item.id}`}>
                        {item.children.map((child) => (
                          <a
                            href={navigationHref(child, activeEvent)}
                            data-router-ignore={child.accountView ? "true" : undefined}
                            onClick={closeAllNavigation}
                            key={child.id}
                          >
                            {child.label}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              }
              return (
                <a
                  href={navigationHref(item, activeEvent)}
                  data-router-ignore={item.accountView ? "true" : undefined}
                  aria-current={activePrimaryLabel === item.label ? "page" : undefined}
                  onClick={closeAllNavigation}
                  key={item.id}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>
          <div className="mobile-navigation-actions">
            <a href="/admin/" data-router-ignore="true" onClick={closeAllNavigation}>用户登录</a>
            <a
              href={navigationHref(PUBLIC_PRIMARY_NAVIGATION.find((item) => item.id === "registration"), activeEvent)}
              data-router-ignore="true"
              onClick={closeAllNavigation}
            >
              报名入口
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}
