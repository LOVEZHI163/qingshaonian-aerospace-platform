import React from "react";

const valueOrPlaceholder = (value) => value || "待管理员完善";

export default function SiteFooter({ site = {} }) {
  const organizers = Array.isArray(site.organizers) ? site.organizers.join("、") : site.organizers;
  return (
    <footer className="site-footer" role="contentinfo">
      <div>
        <strong>{valueOrPlaceholder(site.platformName)}</strong>
        <p>{valueOrPlaceholder(site.platformIntro)}</p>
      </div>
      <dl>
        <div><dt>主办单位</dt><dd>{valueOrPlaceholder(organizers)}</dd></div>
        <div><dt>联系方式</dt><dd>{valueOrPlaceholder(site.contact)}</dd></div>
        <div><dt>备案信息</dt><dd>{valueOrPlaceholder(site.icp)}</dd></div>
      </dl>
      <a href="/admin/" data-router-ignore="true">管理入口</a>
    </footer>
  );
}
