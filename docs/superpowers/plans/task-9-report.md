# Task 9：组织多赛事工作台交付报告

## 交付

- 提交：`fc14590 feat: add organization event workspace`
- 组织账号通过赛事中心加入赛事；重复加入由服务端保持幂等，并直接进入对应工作台。
- 工作台所有报名、记录、导出和证书请求均使用显式 `eventId`：
  - `POST /api/organization/events/:eventId/registrations`
  - `GET /api/organization/events/:eventId/registrations`
  - `GET /api/organization/events/:eventId/export`
  - `GET /api/organization/events/:eventId/certificates`
- 新增工作台摘要接口 `GET /api/organization/events/:eventId/workspace`，仅允许该组织负责人访问已加入赛事；导出同样受该边界保护。
- 归档赛事隐藏组织报名表单，保留成绩、报名记录和已发布证书查看/下载。
- 组织控制台改为仅依据 `organizations.ownerUserId` 确认唯一负责组织，移除经理角色、组织选择器、跨组织旧报名/证书接口和成员邀请入口。

## 红绿记录

1. 先增加组织工作台/表单测试，初次执行因新页面与表单不存在而失败。
2. 增加组织控制台测试，初次执行因旧逻辑依赖 `membershipRole`、未加载唯一负责组织成员而失败。
3. 增加 workspace/export API 测试，初次执行返回 404；实现后通过。

## 验证

```powershell
npm.cmd test -w apps/admin -- src/pages/__tests__/OrganizationEventWorkspacePage.test.js src/pages/__tests__/OrganizationConsolePage.test.js src/pages/__tests__/AppNavigation.test.js
# 3 files, 28 passed

npm.cmd test -w apps/api -- --test-concurrency=1 test/account-events.test.js
# 4 passed

npm.cmd run build -w apps/admin
# vite build passed

git diff --check
# clean
```

普通用户与管理员流程未作业务改动；Task 10 的管理员统一赛事上下文保持后续任务边界。

## Review Fix Round 1

- 组织工作台报名记录新增编辑入口，保存时严格调用 `PATCH /api/organization/events/:eventId/registrations/:registrationId`；归档赛事不渲染编辑入口。
- 组织账号的 `view=organizationWorkspace&eventId=<archived>` 深链不再依赖活动赛事中心列表。页面通过 workspace API 完成授权，成功后保持 URL 并显示历史赛事标题；无权组织自动清空赛事上下文并回到赛事中心。
- 普通账号无法请求组织工作台接口，直接回到赛事中心。

验证：

```powershell
npm.cmd test -w apps/admin -- src/pages/__tests__/OrganizationWorkspaceDeepLink.test.js src/pages/__tests__/OrganizationEventWorkspacePage.test.js src/pages/__tests__/OrganizationConsolePage.test.js src/pages/__tests__/AppNavigation.test.js
# 4 files, 32 passed

npm.cmd run build -w apps/admin
# vite build passed
```
