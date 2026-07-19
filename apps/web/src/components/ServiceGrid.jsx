import React from "react";

const serviceIcons = {
  registration: "✎",
  guide: "⌁",
  results: "▥",
  certificates: "◇"
};

const eventScopedServices = new Set(["registration", "results", "certificates"]);

function safeServiceHref(service) {
  if (!service?.href || !service.href.startsWith("/")) return null;
  if (!eventScopedServices.has(service.key) || !service.href.startsWith("/admin/")) return service.href;
  if (!service.eventId) return null;
  const url = new URL(service.href, "https://public.invalid");
  return url.searchParams.get("eventId") === String(service.eventId) ? service.href : null;
}

export default function ServiceGrid({ services = [] }) {
  if (!services.length) return null;

  return (
    <section className="home-section service-section" aria-labelledby="service-title">
      <div className="section-heading">
        <div>
          <p className="section-kicker">一站式服务</p>
          <h2 id="service-title">赛事服务</h2>
        </div>
        <p>报名、参赛、成绩与证书服务集中办理</p>
      </div>
      <div className="service-grid">
        {services.map((service) => {
          const href = safeServiceHref(service);
          const available = service.available === true && Boolean(href);
          const unavailableText = service.key === "registration" ? "暂无开放报名" : "暂未开放";
          const unavailableLink = href || "/history";
          return (
            <article className="service-card" aria-label={service.label} key={service.key}>
              <span className="service-icon" aria-hidden="true">{serviceIcons[service.key] || "•"}</span>
              <h3>{service.label}</h3>
              <p>{available ? "服务已开放" : unavailableText}</p>
              <a
                className="text-link"
                href={available ? href : unavailableLink}
                data-router-ignore={available && href.startsWith("/admin/") ? "true" : undefined}
              >
                {available ? `进入${service.label}` : service.key === "registration" ? "查看历史赛事" : "查看赛事信息"}
                <span aria-hidden="true"> →</span>
              </a>
            </article>
          );
        })}
      </div>
    </section>
  );
}
