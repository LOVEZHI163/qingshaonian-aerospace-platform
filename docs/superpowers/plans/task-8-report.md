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

- 归档赛事不会进入赛事中心。普通用户历史已发布证书仍可经带 `eventId` 的赛事上下文访问；若需要在无既有赛事链接时浏览全部历史证书，需要后续提供历史赛事选择入口，不能重新引入隐式证书列表接口。
- 本任务未新增普通用户报名编辑界面；已有服务端 `PATCH /api/me/events/:eventId/registrations/:registrationId` 继续使用显式赛事上下文。
