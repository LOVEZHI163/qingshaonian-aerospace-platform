import React from "react";

const serviceIcons = {
  registration: "✎",
  guide: "⌁",
  results: "▥",
  certificates: "◇"
};

const eventScopedServices = new Set(["registration", "results", "certificates"]);
const fallbackTarget = { href: "/history", available: false, isAdmin: false };

function resolveServiceTarget(service) {
  if (service?.available !== true || typeof service.href !== "string" || !service.href) {
    return fallbackTarget;
  }

  let url;
  try {
    url = new URL(service.href, window.location.origin);
  } catch {
    return fallbackTarget;
  }

  if (!["http:", "https:"].includes(url.protocol)
    || url.origin !== window.location.origin
    || url.username
    || url.password) {
    return fallbackTarget;
  }

  const isAdmin = url.pathname === "/admin" || url.pathname === "/admin/";
  if (isAdmin) {
    const eventIds = url.searchParams.getAll("eventId");
    if (!eventScopedServices.has(service.key)
      || !service.eventId
      || eventIds.length !== 1
      || eventIds[0] !== String(service.eventId)) {
      return fallbackTarget;
    }
  }

  return { href: service.href, available: true, isAdmin };
}

export default function ServiceGrid({ services = [] }) {
  if (!services.length) return null;

  return (
    <section id="services" className="home-section service-section" aria-labelledby="service-title">
      <div className="section-heading">
        <div>
          <p className="section-kicker">一站式服务</p>
          <h2 id="service-title">赛事服务</h2>
        </div>
        <p>报名、参赛、成绩与证书服务集中办理</p>
      </div>
      <div className="service-grid">
        {services.map((service) => {
          const target = resolveServiceTarget(service);
          const unavailableText = service.key === "registration" ? "暂无开放报名" : "暂未开放";
          return (
            <article className="service-card" aria-label={service.label} key={service.key}>
              <span className="service-icon" aria-hidden="true">{serviceIcons[service.key] || "•"}</span>
              <h3>{service.label}</h3>
              <p>{target.available ? "服务已开放" : unavailableText}</p>
              <a
                className="text-link"
                href={target.href}
                data-router-ignore={target.isAdmin ? "true" : undefined}
              >
                {target.available ? `进入${service.label}` : service.key === "registration" ? "查看历史赛事" : "查看赛事信息"}
                <span aria-hidden="true"> →</span>
              </a>
            </article>
          );
        })}
      </div>
    </section>
  );
}
