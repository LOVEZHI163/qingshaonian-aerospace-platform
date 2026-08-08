import { userFacingError } from "./user-facing-error.js";

const LEADER_ERROR_MESSAGES = {
  LEADER_AUTHORIZATION_REQUIRED: "请上传领队授权书后再提交",
  LEADER_REVIEW_PENDING: "领队资料已更新，请刷新后重新审核",
  LEADER_ACCESS_DENIED: "无权查看或管理该领队"
};

export function leaderUserFacingError(cause, fallback) {
  return LEADER_ERROR_MESSAGES[cause?.code] || userFacingError(cause, fallback);
}
