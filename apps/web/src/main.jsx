import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { animated, useInView, useSpring, useTrail } from "@react-spring/web";
import "./styles.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:4300";

function Reveal({ children, className = "", delay = 0, y = 34, ...props }) {
  const [ref, springs] = useInView(
    () => ({
      from: { opacity: 0, y },
      to: { opacity: 1, y: 0 },
      config: { tension: 190, friction: 26 },
      delay
    }),
    { rootMargin: "-8% 0%" }
  );

  return (
    <animated.div ref={ref} className={className} style={springs} {...props}>
      {children}
    </animated.div>
  );
}

function App() {
  const [eventData, setEventData] = useState(null);

  useEffect(() => {
    fetch(`${API}/api/public/event`)
      .then((res) => res.json())
      .then(setEventData)
      .catch(() => setEventData(null));
  }, []);

  const event = eventData?.event || {};
  const projects = eventData?.projects || [];
  const categories = useMemo(() => [...new Set(projects.map((item) => item.category))], [projects]);

  const heroCopy = useSpring({
    from: { opacity: 0, x: -44 },
    to: { opacity: 1, x: 0 },
    delay: 130,
    config: { tension: 160, friction: 24 }
  });

  const heroImage = useSpring({
    from: { opacity: 0, scale: 1.08 },
    to: { opacity: 1, scale: 1 },
    config: { tension: 80, friction: 22 }
  });

  const infoTrail = useTrail(4, {
    from: { opacity: 0, y: 26 },
    to: { opacity: 1, y: 0 },
    delay: 420,
    config: { tension: 190, friction: 24 }
  });

  const projectTrail = useTrail(categories.length, {
    from: { opacity: 0, y: 38, scale: 0.97 },
    to: { opacity: 1, y: 0, scale: 1 },
    delay: 160,
    config: { tension: 210, friction: 24 }
  });

  const infoItems = [
    ["比赛时间", event.date || "2026年11月21-22日"],
    ["比赛地点", event.venue || "温州市文成县东方职业技术学院"],
    ["报名截止", event.registrationDeadline || "2026-11-01"],
    ["报名限制", "每人最多 1 个个人赛 + 1 个团体赛"]
  ];

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="赛事首页">
          <span className="brand-emblem">航</span>
          <span>
            <strong>2026温州市青少年</strong>
            <small>航空航天创新比赛</small>
          </span>
        </a>
        <nav>
          <a href="#top">首页</a>
          <a href="#rules">赛事规程</a>
          <a href="#projects">赛项组别</a>
          <a href="#news">新闻动态</a>
        </nav>
        <a className="header-action" href="http://localhost:5174">报名入口</a>
      </header>

      <section id="top" className="hero">
        <animated.img src="/images/hero-aerospace.png" alt="" className="hero-image" style={heroImage} />
        <div className="hero-shade" />
        <div className="hero-orbit orbit-a" />
        <div className="hero-orbit orbit-b" />
        <div className="hero-content">
          <animated.div className="hero-copy" style={heroCopy}>
            <h1>{event.name || "2026年温州市青少年航空航天创新比赛"}</h1>
            <p>
              {event.theme || "瓯越少年、星耀未来"}。展示温州市青少年在航模、旋翼机、无人机、
              航空航天创意创作等领域的学习实践成果。
            </p>
            <div className="hero-meta">
              <span>2026年11月21-22日</span>
              <span>温州市文成县东方职业技术学院</span>
            </div>
            <div className="hero-actions">
              <a className="primary" href="http://localhost:5174">立即报名</a>
              <a className="secondary" href="#rules">查看规程</a>
            </div>
          </animated.div>
        </div>
      </section>

      <section id="rules" className="event-strip" aria-label="赛事信息">
        {infoTrail.map((style, index) => (
          <animated.article key={infoItems[index][0]} style={style}>
            <span>{infoItems[index][0]}</span>
            <strong>{infoItems[index][1]}</strong>
          </animated.article>
        ))}
      </section>

      <Reveal className="rule-section">
        <div className="rule-copy">
          <h2>赛事规程</h2>
          <p>
            全市中小学校、青少年宫、青少年活动中心均可组队参加。参赛运动员须为温州市学籍在校中小学生，
            所有参赛人员需办理人身意外保险。本赛事为公益性赛事，不收取参赛费用。
          </p>
        </div>
        <div className="rule-list">
          <div>
            <strong>参赛对象</strong>
            <span>温州市学籍中小学生</span>
          </div>
          <div>
            <strong>报名方式</strong>
            <span>普通用户报名、组织用户代报</span>
          </div>
        </div>
      </Reveal>

      <section id="projects" className="section">
        <Reveal className="section-heading">
          <h2>赛项组别</h2>
          <p>设小学低组、小学中高组和中学组。个人赛与团体赛分开计数，提交时自动校验。</p>
        </Reveal>
        <div className="project-grid">
          {categories.map((category, index) => (
            <animated.article key={category} className="project-card" style={projectTrail[index]}>
              <h3>{category}</h3>
              <ul>
                {projects
                  .filter((item) => item.category === category)
                  .map((item) => (
                    <li key={item.id}>
                      <span>{item.name}</span>
                      <em>{item.type === "team" ? "团体赛" : "个人赛"}</em>
                    </li>
                  ))}
              </ul>
            </animated.article>
          ))}
        </div>
      </section>

      <Reveal className="news-section" id="news">
        <div>
          <h2>新闻动态</h2>
          <p>用于发布赛事通知、赛前提醒、公众号新闻摘要、赛后公示和优秀作品展示。</p>
        </div>
        <div className="news-list">
          <article>
            <span>赛事通知</span>
            <strong>2026年温州市青少年航空航天创新比赛通知</strong>
          </article>
          <article>
            <span>过往回顾</span>
            <strong>温州市青少年航空航天赛事新闻与活动成果</strong>
          </article>
        </div>
      </Reveal>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
