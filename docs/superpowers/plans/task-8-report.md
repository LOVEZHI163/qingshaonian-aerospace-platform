# Task 8：普通用户多赛事工作流交付报告

## 状态

已完成并通过管理端全量回归。

- 业务提交：`4b10d3a feat: scope ordinary users to selected events`
- 基线：`7869dd6 docs: record task 7 review fix`
- 范围：仅普通用户赛事工作流；组织工作台留给 Task 9，管理员流程未改动。

## 红绿测试记录

### Red

先新增 `OrdinaryEventWorkflow.test.js`，在旧实现上执行：

```powershell
npm.cmd test -w apps/admin -- src/pages/__tests__/OrdinaryEventWorkflow.test.js
```

结果：3 项按预期失败，分别捕获普通用户仍提交 `/api/registrations`、未加入赛事的关联组织未被禁用、报名记录/证书仍请求旧的隐式赛事接口。

随后新增 App 赛事上下文导航用例，在旧导航上失败，验证未选择赛事时不应显示“报名”和“当前报名”。

### Green

```powershell
npm.cmd test -w apps/admin -- src/__tests__/App.test.js src/pages/__tests__/OrdinaryEventWorkflow.test.js src/pages/__tests__/RegistrationPage.event-context.test.js
# 24 passed

npm.cmd test -w apps/admin
# 29 files, 290 passed

npm.cmd run build -w apps/admin
# vite build passed

git diff HEAD^ HEAD --check
# clean
```

## 改动摘要

- 普通用户创建报名改为 `POST /api/me/events/:eventId/registrations`。
- 普通用户当前报名改为 `GET /api/me/events/:eventId/registrations`。
- 普通用户证书改为 `GET /api/me/events/:eventId/certificates`。
- 赛事中心选择结果保存在 URL 的 `eventId`；未选择赛事时隐藏“报名”和“当前报名”，返回赛事中心会清除该上下文。
- 报名页消费赛事中心中的成员组织关系：未加入该赛事的组织保留名称和说明，但不可选择；可用关联组织自动匹配。
- 空赛事、未开始、已截止均显示明确状态且不渲染可提交报名表单。
- 为窄屏状态面板和组织不可用提示增加基础样式；全面响应式验收仍由 Task 11 负责。

## 自审

- 普通用户业务读写不再回退到旧的 `/api/me/registrations`、`/api/me/certificates` 或 `/api/registrations` 路由。
- 表单资料仍使用带 `eventId` 的 `GET /api/me/registration-context` 获取赛项和年级；它不承担报名读写。
- 组织和管理员分支保留原有接口与导航，避免提前侵入 Task 9 和管理员任务边界。
- 个人范围和跨组织归属约束由已有的事件范围 API 服务端守卫执行；前端只负责避免无效选择并呈现原因。

## 关注点

- 本任务未新增普通用户报名编辑界面；已有服务端 `PATCH /api/me/events/:eventId/registrations/:registrationId` 继续使用显式赛事上下文。

## Review Fix Round 1：历史证书独立查询

已完成审查反馈修复。

- 修复提交：`c4a9b70 fix: preserve historical certificate lookup`
- 普通用户 `?view=certificates&eventId=<archived>` 深链不再依赖 `/api/me/events` 的未归档赛事行；页面保留该 `eventId` 并请求 `GET /api/me/events/:eventId/certificates`，由服务端完成归属授权。
- 证书查询页在没有当前活动赛事时仍可进入，提供赛事 ID 输入框、明确空状态和历史赛事提示；不会显示历史报名列表。
- 手动查询会同步证书页 URL 的 `eventId`，但不把归档赛事设为活动报名上下文，因此“报名”和“当前报名”仍只接受赛事中心中可见的未归档赛事。
- 新增红测后转绿：归档证书深链保留并请求其事件端点、无活动赛事输入 ID 后查询、归档报名深链回退赛事中心。

验证：

```powershell
npm.cmd test -w apps/admin
# 29 files, 293 passed

npm.cmd run build -w apps/admin
# vite build passed
```

## Review Fix Round 2：历史查询上下文一致性

- 修复提交：`03de2a5 fix: keep historical certificate context aligned`
- 已在活动赛事 E1 的证书页手工查询 `E-ARCHIVED` 时，清除活动报名上下文；URL 更新为历史 `eventId`，顶部改为“历史赛事证书查询”，证书结果来自同一历史赛事。
- 手工查询请求由当前证书页实例单一负责；父级只同步上下文，避免父级重建或重复加载。交互用例在进入证书页完成初始加载后清空请求记录，断言一次手工查询只请求一次 `/api/me/events/E-ARCHIVED/certificates`。
- 返回赛事中心会清除历史 `eventId`，且不会重新显示活动报名操作，直到用户再次从赛事中心选择活动赛事。

验证：

```powershell
npm.cmd test -w apps/admin -- src/__tests__/App.test.js src/pages/__tests__/OrdinaryEventWorkflow.test.js
# 26 passed

npm.cmd test -w apps/admin
# 29 files, 294 passed

npm.cmd run build -w apps/admin
# vite build passed
```
