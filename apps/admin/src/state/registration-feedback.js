export function registrationSuccessMessage(payload) {
  const status = payload?.row?.status;
  const review = {
    pending: "等待审核，提交成功不代表审核通过。",
    approved: "审核通过。",
    rejected: "审核未通过，请到报名记录查看原因。",
    cancelled: "已取消，请到报名记录核对。"
  }[status] || "请到报名记录查看当前审核状态。";
  return `${payload?.merged ? "已与现有报名合并，未重复创建。" : "报名提交成功，无需重复提交。"} ${review}`;
}
