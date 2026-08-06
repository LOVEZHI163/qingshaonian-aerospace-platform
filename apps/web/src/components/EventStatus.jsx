import React from "react";

export default function EventStatus({ event, mode = "active" }) {
  let icon = "●";
  let label = event?.registrationWindow?.reason || "报名暂未开放";
  let tone = "neutral";

  if (mode === "history") {
    icon = "↺";
    label = "赛事回顾";
    tone = "history";
  } else if (event?.registrationWindow?.open) {
    icon = "✓";
    label = "报名中";
    tone = "open";
  }

  return (
    <span className="event-status" data-tone={tone}>
      <span aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
}
