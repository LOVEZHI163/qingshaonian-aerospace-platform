import { WZ_AEROSPACE_2026_COPY } from "../content/wz-aerospace-2026.js";
import { accountEntry } from "./public-navigation.js";

const TITLES = {
  about: "大赛简介",
  rules: "大赛章程",
  registration: "报名流程",
  contact: "联系我们",
  projects: "赛事项目与组别"
};

const GENERIC_COPY = {
  about: [{ heading: "大赛简介", paragraphs: ["赛事详细介绍正在整理中，请以通知公告为准。"] }],
  rules: [{ heading: "大赛章程", paragraphs: ["请按照通知公告、赛项规程和现场安全要求参赛。"] }],
  registration: [{ heading: "报名说明", paragraphs: ["请登录赛事报名系统，选择赛事后按照页面要求提交信息。"] }],
  contact: []
};

const text = (value) => String(value || "").trim();
const MOBILE_PHONE_SOURCE = String.raw`(?:\+?86[\s-]?)?1[3-9]\d(?:[\s-]?\d){8}`;
const LANDLINE_PHONE_SOURCE = String.raw`(?:\(0\d{2,3}\)|0\d{2,3})[\s-]?\d{7,8}`;
const LOCAL_PHONE_SOURCE = String.raw`\d{7,8}`;
const PHONE_CANDIDATE_SOURCE = `(?:${MOBILE_PHONE_SOURCE}|${LANDLINE_PHONE_SOURCE}|${LOCAL_PHONE_SOURCE})`;

function normalizedPhone(value) {
  const label = text(typeof value === "object" ? value?.label : value).replace(/\s+/g, " ");
  const digits = label.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return {
    label,
    href: `tel:${label.startsWith("+") ? "+" : ""}${digits}`
  };
}

function normalizedContact(value) {
  if (!value) return null;
  if (typeof value === "object") {
    const phones = (Array.isArray(value.phones) ? value.phones : [])
      .map(normalizedPhone)
      .filter(Boolean);
    const name = text(value.name);
    return name || phones.length ? { name, phones } : null;
  }

  const raw = text(value);
  if (!raw) return null;
  const candidates = raw.match(new RegExp(PHONE_CANDIDATE_SOURCE, "g")) || [];
  const phones = candidates.map(normalizedPhone).filter(Boolean);
  const name = raw
    .replace(new RegExp(PHONE_CANDIDATE_SOURCE, "g"), " ")
    .replace(/(?:联系人|联系电话|电话)\s*[:：]?/g, " ")
    .replace(/[\/／、,，;；]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name || phones.length ? { name, phones } : null;
}

function normalizedSection(section) {
  const paragraphs = (Array.isArray(section?.paragraphs) ? section.paragraphs : [])
    .map(text)
    .filter(Boolean);
  const items = (Array.isArray(section?.items) ? section.items : [])
    .map((item) => ({ ...item, name: text(item?.name) }))
    .filter((item) => item.name);
  const contact = normalizedContact(section?.contact);
  return {
    heading: text(section?.heading),
    ...(paragraphs.length ? { paragraphs } : {}),
    ...(items.length ? { items } : {}),
    ...(contact ? { contact } : {})
  };
}

function visibleSections(sections) {
  return sections
    .map(normalizedSection)
    .filter((section) => section.heading && (
      section.paragraphs?.length || section.items?.length || section.contact
    ));
}

function contactSection(heading, value) {
  const contact = normalizedContact(value);
  return contact ? { heading, contact } : null;
}

function dynamicFacts(event) {
  return [
    ["比赛时间", event.dateLabel],
    ["比赛地点", event.venue],
    ["报名截止", event.registrationEndAt ? new Date(event.registrationEndAt).toLocaleString("zh-CN", { hour12: false }) : ""]
  ].filter(([, value]) => text(value)).map(([label, value]) => ({ label, value }));
}

function projectSections(detail) {
  const projects = Array.isArray(detail?.projects) ? detail.projects : [];
  const groups = Array.isArray(detail?.groups) ? detail.groups : [];
  return [
    { heading: "赛事项目", items: projects.map(({ id, name, category, type, allowedGroups }) => ({ id, name, category, type, allowedGroups })) },
    { heading: "参赛组别", items: groups.map((name) => ({ id: name, name })) }
  ];
}

export function buildPublicEventContent(section, { event, detail, site = {} }) {
  if (!event) {
    const platformContact = contactSection("平台联系", site.contact);
    return {
      title: TITLES[section] || "赛事信息",
      eyebrow: "温州少航",
      lead: site.platformIntro || "赛事信息正在整理中，请稍后查看。",
      facts: [],
      sections: platformContact ? [platformContact] : [],
      actions: [{ label: "查看历届赛事", href: "/history" }]
    };
  }

  const eventCopy = event.slug === "wz-aerospace-2026" ? WZ_AEROSPACE_2026_COPY : GENERIC_COPY;
  const sections = section === "projects"
    ? projectSections(detail)
    : [...(eventCopy[section] || GENERIC_COPY[section] || [])];
  if (section === "contact" && event.slug !== "wz-aerospace-2026") {
    const contact = contactSection("赛事联系", event.contact || site.contact);
    if (contact) sections.push(contact);
  }
  return {
    title: TITLES[section] || "赛事信息",
    eyebrow: event.name,
    lead: event.summary || event.slogan || event.theme || `${event.name}公开信息`,
    facts: dynamicFacts(event),
    sections: visibleSections(sections),
    actions: [
      { label: "立即报名", href: accountEntry("eventCenter", event), externalRouter: true },
      { label: "返回首页", href: "/" },
      { label: "查看赛事资讯", href: `/news?event=${encodeURIComponent(event.slug)}` }
    ]
  };
}
