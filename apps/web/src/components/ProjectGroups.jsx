import React from "react";

const typeLabels = { individual: "个人赛", team: "团体赛" };

export default function ProjectGroups({ projects = [], groups = [] }) {
  return (
    <section className="project-section" aria-labelledby="project-title">
      <div className="section-heading compact-heading">
        <div>
          <p className="section-kicker">比赛项目</p>
          <h2 id="project-title">赛项与组别</h2>
        </div>
        <p>各赛项开放组别以赛事公开信息为准</p>
      </div>

      {groups.length ? (
        <ul className="group-strip" aria-label="赛事组别">
          {groups.map((group) => <li key={group}>{group}</li>)}
        </ul>
      ) : null}

      {!projects.length ? <p className="compact-empty">赛项信息即将公布</p> : (
        <div className="project-grid">
          {projects.map((project) => (
            <article key={project.id}>
              <p>{project.category || "航空航天"} · {typeLabels[project.type] || project.type || "赛项"}</p>
              <h3>{project.name}</h3>
              {project.instructorRequired ? <span className="project-note">需填写指导老师</span> : null}
              <ul aria-label={`${project.name}适用组别`}>
                {(project.allowedGroups || []).map((group) => <li key={group}>{group}</li>)}
              </ul>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

