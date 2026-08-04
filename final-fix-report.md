# 最终修复报告

基线：`4b8ed19e986`

代码修复提交 SHA：`a8f3b5050877c5a92be76b5d476f6f6f0dfcab16`

## RED / GREEN

- RED：已存在 active 组织关系的用户仍可创建跨组织申请/邀请；GREEN：创建阶段返回 `MEMBERSHIP_ACTIVE_CONFLICT`。
- RED：禁用组织关系被隐藏且不能退出/撤回；GREEN：历史关系仍可见，非激活动作可完成。
- RED：平台管理员无法读取组织资质；GREEN：管理员可通过受控下载端点预览/下载，普通无关用户仍为 403。
- RED：`/api/users` 和管理员组织列表会透传未知内部字段；GREEN：用户、组织均使用显式白名单 DTO。
- RED：旧 `PATCH /api/memberships/:id` 一律按组织所有者处理；GREEN：根据服务端认证身份及关系归属选择个人或组织动作。
- RED：旧 owner/system active 及未绑定邀请会污染关系数据；GREEN：数据整形时将其迁移到不可操作的终态。

## 验证

- `node --test apps/api/test/membership-service.test.js`
- `node --test apps/api/test/membership-relations.test.js`
- `node --test apps/api/test/admin-users.test.js`
- `node --test apps/api/test/organization-credentials.test.js`
- `npm test -w apps/admin -- src/pages/__tests__/AdminEventContext.test.js`
- `npm test -w apps/admin -- src/pages/__tests__/MyOrganizationPage.test.js`
- `npm test -w apps/api`：445/445 通过。
- `npm run build`：通过。

## 残余风险

- 生产历史数据会在下一次读取并写回时按兼容规则规范化；尚未额外增加一次性 SQL 回填迁移。
- 前端生产构建仍有既存的 chunk 体积警告，未影响本次功能或构建结果。

## 复审补充（基线 `077b65c`）

- 新增 `012-membership-data-normalization.sql`：处理已经执行 011 的历史库，规范 owner/system active、未绑定邀请及重复 active，并重新保证唯一索引。
- 普通用户的组织返回改为角色化 DTO；账户事件不再嵌入完整组织；管理员用户详情增加跨赛事报名的显式展示 DTO。
- 负责人成员汇总排除遗留伪关系，并拒绝对 owner/system 关系执行成员移除。
- 已通过 PostgreSQL 迁移真实夹具及相关 API/服务回归（51 项）。完整 API/admin/build 仍需在主复审任务继续执行。

## 最终复审收尾

- 真实 HTTP 并发 accept 回归证明同一用户两个不同组织邀请只会产生一个 active，另一请求为 409，且仅赢家写入 accept 审计。
- 部署 smoke 新增管理员用户 DTO 敏感字段检查、管理员资质流式访问、`schema_migrations` 的 012 记录检查。
- 管理端全套测试：419/419 通过；生产构建通过。
- 管理员的 `/api/me/:userId` 现包含跨赛事、字段白名单的报名摘要；普通用户自身详情不暴露该字段，旧未分赛事管理员报名路由仍保持 404。
