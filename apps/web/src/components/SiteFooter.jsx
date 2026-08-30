import React from "react";

const valueOrPlaceholder = (value) => value || "待管理员完善";
const LEGAL_OWNER = "温州市少航科创中心";
const SITE_DOMAIN = "aerogp.cn";
const SITE_URL = "https://aerogp.cn/";
const ICP_QUERY_URL = "https://beian.miit.gov.cn/";

function contactContent(value) {
  const contact = valueOrPlaceholder(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)
    ? <a href={`mailto:${contact}`}>{contact}</a>
    : contact;
}

export default function SiteFooter({ site = {} }) {
  const organizers = Array.isArray(site.organizers) ? site.organizers.join("、") : site.organizers;
  return (
    <footer className="site-footer" role="contentinfo">
      <div>
        <strong>{valueOrPlaceholder(site.platformName)}</strong>
        <p>{valueOrPlaceholder(site.platformIntro)}</p>
      </div>
      <dl>
        <div><dt>赛事主办单位</dt><dd>{valueOrPlaceholder(organizers)}</dd></div>
        <div><dt>网站主办单位</dt><dd>{LEGAL_OWNER}</dd></div>
        <div><dt>网站域名</dt><dd><a href={SITE_URL}>{SITE_DOMAIN}</a></dd></div>
        <div><dt>联系方式</dt><dd>{contactContent(site.contact)}</dd></div>
      </dl>
      <a href="/admin/" data-router-ignore="true">管理入口</a>
      <div className="site-footer-legal" aria-label="网站备案信息">
        {site.icp
          ? <a href={ICP_QUERY_URL} target="_blank" rel="noreferrer">{site.icp}</a>
          : <span>{valueOrPlaceholder(site.icp)}</span>}
      </div>
    </footer>
  );
}
