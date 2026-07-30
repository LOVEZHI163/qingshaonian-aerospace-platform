# Task 10：管理员统一赛事上下文交付报告

## 交付

- 提交：`273071f feat: unify administrator event context`
- 管理端将管理员赛事上下文收敛为 `App.vue` 中唯一的 `adminEventId`，由顶部 `EventContextSwitcher` 统一切换，并写入 `?view=...&eventId=...`。刷新页面或复制链接后保留同一赛事。
- 平台、赛事、官网内容、组织和用户管理仍为全局功能；仪表盘、报名管理、证书管理及导入均要求先选择赛事。
- 未选择赛事时，仪表盘、报名和证书页仅显示选择提示，不发送赛事业务数据请求。
- 报名、成绩、证书列表、批量发布、手动证书、Excel 导入、导出和模板下载统一迁移到 `/api/admin/events/:eventId/...`。管理端生产代码不再保留旧的 `/api/admin/registrations`、`/api/admin/certificates` 或 `/api/admin/certificate-imports` 请求。
- 赛事切换通过事件 ID 作为业务页 key 重建局部页面状态，清除证书选择、预览和导入批次；归档赛事在证书页仅保留只读列表，隐藏手工录入、批量导入和批量状态变更入口。
- 组织管理保持全局加载，直接展示后端返回的 `eventParticipations`，包含各已参与赛事的报名、成绩和证书数量，不再用无赛事上下文的报名列表补算。

## 红绿记录

1. 新增 `AdminEventContext.test.js`，先验证未选择赛事时不应请求仪表盘、报名或证书业务数据，并在选择 `E2` 后要求报名和证书共用该 ID 且 URL 保留 `eventId=E2`。
2. 初次执行为红：旧仪表盘在没有赛事 ID 时仍调用 `/api/admin/dashboard`。
3. 实现顶栏统一上下文、页面空状态和 event-scoped 请求后，该回归用例转绿。

## 聚焦验证

```powershell
npm.cmd test -w apps/admin -- src/pages/__tests__/AdminEventContext.test.js src/pages/__tests__/RegistrationManagementPage.test.js src/pages/__tests__/CertificateManagementPage.test.js src/pages/__tests__/OrganizationManagementPage.test.js src/pages/__tests__/DashboardPage.test.js src/__tests__/App.test.js
# 6 files, 55 passed

npm.cmd run build -w apps/admin
# vite build passed

git diff --check
# clean
```

## Review Fix Round 1

- `ManualCertificateEntryPanel` 移除内部 `eventId` 状态、页内赛事下拉框和切换逻辑；现在仅接收父级 `eventId`，所有报名、证书和成绩请求均使用该 prop。父级赛事切换以页面 key 重建组件，从而清理本地搜索、预览和批次状态。
- `DashboardPage` 删除遗留的二级赛事选择器与未定义的 `selectedEventId`；没有 `eventId` 时只显示选择提示，不请求仪表盘也不渲染统计面板。
- `RegistrationManagementPage` 新增 `eventArchived` 输入，并结合赛事元数据识别归档状态。归档赛事保持报名列表和导出只读可用，隐藏审核、驳回、编辑、成绩和证书写操作；对应函数也在前端短路。
- 迁移旧测试夹具：报名分页、证书导入、证书槽位、手动录入、证书分页、赛事设置及管理员深链测试均改为显式 `eventId` 和 `/api/admin/events/:eventId/...` 路径；删除了认可页内赛事选择器或重复点击导航后清空赛事上下文的断言。

## Review Fix Round 1 验证

```powershell
npm.cmd test -w apps/admin
# 33 files, 305 passed, 0 failed

npm.cmd run build -w apps/admin
# vite build passed

git diff --check
# clean
```
