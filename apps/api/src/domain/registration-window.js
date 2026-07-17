export function isRegistrationOpen(event, now = new Date()) {
  if (event.registrationMode === "force_open") return { open: true, reason: "管理员临时开放" };
  if (event.registrationMode === "force_closed") return { open: false, reason: "管理员临时关闭" };

  const current = now.getTime();
  const start = new Date(event.registrationStartAt).getTime();
  const end = new Date(event.registrationEndAt).getTime();
  if (current < start) return { open: false, reason: "报名尚未开始" };
  if (current > end) return { open: false, reason: "报名已截止" };
  return { open: true, reason: "报名进行中" };
}
