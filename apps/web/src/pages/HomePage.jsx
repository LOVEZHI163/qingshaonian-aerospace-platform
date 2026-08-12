import React from "react";
import ConcurrentEvents from "../components/ConcurrentEvents.jsx";
import ContentSection from "../components/ContentSection.jsx";
import FeaturedEvent from "../components/FeaturedEvent.jsx";
import ServiceGrid from "../components/ServiceGrid.jsx";
import { PUBLIC_CONTENT_TYPE_LABELS } from "../lib/public-content-labels.js";

const rows = (value) => Array.isArray(value) ? value : [];

export default function HomePage({ data = {} }) {
  const featuredEvent = data.featuredEvent || null;
  return (
    <div className="home-page">
      <span className="visually-hidden">页面基础数据已加载</span>
      <div id="registration" tabIndex="-1">
        <FeaturedEvent
          event={featuredEvent}
          mode={data.mode === "history" ? "history" : "active"}
        />
      </div>
      <ConcurrentEvents events={rows(data.concurrentEvents)} featuredEventId={featuredEvent?.id} />
      <ServiceGrid services={rows(data.services)} />
      <ContentSection
        id="announcements"
        title={PUBLIC_CONTENT_TYPE_LABELS.announcement}
        kicker="重要通知"
        items={rows(data.announcements)}
        variant="announcements"
        moreHref="/announcements"
        emptyText="暂无最新通知公告"
      />
      <ContentSection
        id="news"
        title={PUBLIC_CONTENT_TYPE_LABELS.news}
        kicker="新闻聚焦"
        items={rows(data.news)}
        moreHref="/news"
        emptyText="暂无最新新闻动态"
      />
      <ContentSection
        id="history"
        title="历届赛事"
        kicker="逐梦足迹"
        items={rows(data.history)}
        variant="history"
        moreHref="/history"
        emptyText="暂无往届回顾"
      />
    </div>
  );
}
