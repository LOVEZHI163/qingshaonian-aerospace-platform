import React, { useEffect, useMemo, useState } from "react";

import { fetchJson } from "../api/client.js";
import AsyncState from "../components/AsyncState.jsx";
import AttachmentList from "../components/AttachmentList.jsx";
import EventStatus from "../components/EventStatus.jsx";
import { EventPicture } from "../components/FeaturedEvent.jsx";
import ProjectGroups from "../components/ProjectGroups.jsx";

const contentLabels = {
  announcement: "赛事公告",
  news: "赛事动态",
  work: "优秀作品",
  guide: "参赛指南",
  recap: "赛事回顾"
};

function ResourceNotFound() {
  return (
    <section className="resource-state" aria-labelledby="event-not-found-title">
      <p>404</p>
      <h1 id="event-not-found-title">赛事不存在</h1>
      <p>该赛事可能尚未公开或已经停止展示。</p>
      <a className="button button-solid" href="/history">查看历届赛事</a>
    </section>
  );
}
function EventContent({ rows = [] }) {
  if (!rows.length) return null;
  return (
    <section className="event-content-section" aria-labelledby="event-content-title">
      <div className="section-heading compact-heading">
        <div><p className="section-kicker">最新信息</p><h2 id="event-content-title">赛事内容</h2></div>
      </div>
      <div className="event-content-grid">
        {rows.map((row) => (
          <article key={row.id || row.slug}>
            <span>{contentLabels[row.type] || "赛事内容"}</span>
            <h3>{row.slug ? <a href={`/content/${encodeURIComponent(row.slug)}`}>{row.title}</a> : row.title}</h3>
            {row.summary ? <p>{row.summary}</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export default function EventDetailPage({ slug }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: "loading", data: null });
  const requestKey = useMemo(() => String(slug || ""), [slug]);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setState({ status: "loading", data: null });
    fetchJson(`/api/public/events/${encodeURIComponent(slug)}`, { signal: controller.signal })
      .then((data) => current && setState({ status: "success", data }))
      .catch((error) => {
        if (!current || error?.name === "AbortError") return;
        setState({ status: error?.status === 404 ? "not-found" : "error", data: null });
      });
    return () => { current = false; controller.abort(); };
  }, [attempt, requestKey, slug]);

  if (state.status === "not-found") return <ResourceNotFound />;

  const payload = state.data || {};
  const event = payload.event;
  const eventId = typeof event?.id === "string" && event.id.trim() ? event.id : null;
  const canRegister = event?.registrationWindow?.open === true && eventId;

  return (
    <div className="content-page event-detail-page">
      <AsyncState status={state.status} onRetry={() => setAttempt((value) => value + 1)}>
        {event ? (
          <>
            <section className="event-detail-hero" aria-labelledby="event-detail-title">
              <EventPicture event={event} className="event-detail-media" />
              <div className="event-detail-overlay" />
              <div className="event-detail-copy">
                <div className="event-detail-status"><EventStatus event={event} /></div>
                <h1 id="event-detail-title">{event.name}</h1>
                {event.theme ? <p className="event-detail-theme">{event.theme}</p> : null}
                {event.slogan ? <p>{event.slogan}</p> : null}
              </div>
            </section>

            <section className="event-detail-facts" aria-label="赛事核心信息">
              <dl>
                <div><dt>比赛时间</dt><dd>{event.dateLabel || "待公布"}</dd></div>
                <div><dt>比赛地点</dt><dd>{event.venue || "待公布"}</dd></div>
                <div><dt>报名截止</dt><dd>{event.registrationEndAt ? new Date(event.registrationEndAt).toLocaleString("zh-CN", { hour12: false }) : "待公布"}</dd></div>
                <div><dt>报名状态</dt><dd>{event.registrationWindow?.reason || (event.registrationWindow?.open ? "报名开放中" : "暂未开放")}</dd></div>
              </dl>
              <div className="event-detail-actions">
                {canRegister ? (
                  <a className="button button-solid" href={`/admin/?view=registration&eventId=${encodeURIComponent(eventId)}`} data-router-ignore="true">立即报名</a>
                ) : null}
                {eventId ? <a className="button button-outline" href={`/admin/?view=records&eventId=${encodeURIComponent(eventId)}`} data-router-ignore="true">查询成绩</a> : null}
                {eventId ? <a className="button button-outline" href={`/admin/?view=certificates&eventId=${encodeURIComponent(eventId)}`} data-router-ignore="true">查询证书</a> : null}
              </div>
            </section>

            <section className="event-intro" aria-labelledby="event-intro-title">
              <p className="section-kicker">赛事介绍</p>
              <h2 id="event-intro-title">关于本届赛事</h2>
              <p>{event.summary || "赛事介绍即将公布。"}</p>
              {event.contact ? <p><strong>联系方式：</strong>{event.contact}</p> : null}
            </section>

            <ProjectGroups projects={payload.projects || []} groups={payload.groups || []} />
            <AttachmentList attachments={payload.resources || []} title="指南与规程" />
            <EventContent rows={payload.content || []} />
          </>
        ) : null}
      </AsyncState>
    </div>
  );
}
