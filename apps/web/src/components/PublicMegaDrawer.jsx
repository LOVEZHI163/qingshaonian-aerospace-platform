import React from "react";
import {
  accountEntry,
  eventScopedPath,
  PUBLIC_NAVIGATION_GROUPS
} from "../lib/public-navigation.js";

export default function PublicMegaDrawer({ open, activeEvent, events, currentPath, onClose }) {
  const theme = activeEvent?.theme || activeEvent?.slogan || "科技强国，未来有我";
  const hrefFor = (link) => link.accountView
    ? accountEntry(link.accountView, activeEvent)
    : eventScopedPath(link.path, activeEvent);

  return (
    <div
      id="public-mega-drawer"
      className="public-mega-drawer"
      data-open={open || undefined}
      aria-hidden={!open}
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
                        aria-current={currentPath === link.path ? "page" : undefined}
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
                <a key={event.id} href={eventScopedPath("/about", event)}>{event.name}</a>
              ))}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
