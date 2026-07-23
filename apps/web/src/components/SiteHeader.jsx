import React, { useEffect, useRef, useState } from "react";

const BRAND_NAME = "温州市青少年航空航天创新比赛";

const navigation = [
  ["首页", "/"],
  ["公告", "/announcements"],
  ["动态与作品", "/news"],
  ["历届赛事", "/history"]
];

export default function SiteHeader({ routeKey }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef(null);
  const navigationRef = useRef(null);
  const currentPath = (() => {
    try { return new URL(routeKey || "/", window.location.origin).pathname; }
    catch { return "/"; }
  })();

  useEffect(() => setMenuOpen(false), [routeKey]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    navigationRef.current?.querySelector("a[href]")?.focus();
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  return (
    <header className="site-header" role="banner">
      <a className="brand" href="/" aria-label="网站首页">
        <img className="brand-mark" src="/brand/mark.svg" alt="" />
        <img className="brand-wordmark" src="/brand/wordmark.svg" alt={BRAND_NAME} />
      </a>

      <button
        ref={menuButtonRef}
        className="menu-trigger"
        type="button"
        aria-label={menuOpen ? "关闭导航菜单" : "打开导航菜单"}
        aria-expanded={menuOpen}
        aria-controls="site-navigation"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span aria-hidden="true">{menuOpen ? "×" : "☰"}</span>
      </button>

      <div ref={navigationRef} id="site-navigation" className="site-navigation" data-open={menuOpen || undefined}>
        <p className="mobile-brand-name">{BRAND_NAME}</p>
        <nav aria-label="主导航">
          {navigation.map(([label, href]) => (
            <a href={href} aria-current={currentPath === href ? "page" : undefined} key={href}>{label}</a>
          ))}
        </nav>
        <div className="header-actions">
          <a className="login-link" href="/admin/" data-router-ignore="true">用户登录</a>
          <a className="registration-link" href="/#registration">报名入口</a>
        </div>
      </div>
    </header>
  );
}
