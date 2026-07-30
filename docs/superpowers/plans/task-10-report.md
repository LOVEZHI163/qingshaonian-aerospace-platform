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

## 全量管理端测试遗留

全量命令 `npm.cmd test -w apps/admin` 的结果为 **279 passed、26 failed**。这里的“26”是失败用例数，分布在下列 **8 个测试文件**；它们仍在断言本任务明确移除的旧 API 或旧的页面内赛事选择器，需在后续测试迁移中按新的全局 `eventId` 上下文更新。

| 测试文件 | 失败数 | 原因 |
| --- | ---: | --- |
| `apps/admin/src/pages/__tests__/CertificateManagementPage.final-fixes.test.js` | 4 | 未向页面传入 `eventId`，并断言旧证书列表路径或页面自行选择当前赛事。 |
| `apps/admin/src/pages/__tests__/EventManagementPage.test.js` | 3 | 仍模拟无 `eventId` 的全量报名分页路径；现在报名分页必须使用选中赛事的 `/api/admin/events/:eventId/registrations`。 |
| `apps/admin/src/components/__tests__/ManualCertificateEntryPanel.test.js` | 2 | 仍断言旧的 `/api/admin/registrations/:id/result`，应改为带赛事路径的成绩写入。 |
| `apps/admin/src/pages/__tests__/AppNavigation.test.js` | 3 | 仍查找旧报名/证书 URL 与“点击当前导航会清空页内赛事筛选”的行为；统一顶栏上下文不应清空已选赛事。 |
| `apps/admin/src/__tests__/App.test.js` | 2 | 旧断言期望管理员进入证书页即出现导入区，以及从报名页内赛事筛选器切换历史赛事；现在均必须经顶部上下文选择。 |
| `apps/admin/src/components/__tests__/CertificateSlotEditor.final-fixes.test.js` | 3 | fixture 的报名记录缺少 `eventId`，且仍断言无赛事的证书上传、更新和删除 URL。 |
| `apps/admin/src/components/__tests__/CertificateImportPanel.final-fixes.test.js` | 2 | 仍断言旧的导入预检、恢复和取消路径，应改为 `/api/admin/events/:eventId/certificate-imports/...`。 |
| `apps/admin/src/lib/__tests__/admin-registrations.test.js` | 7 | 分页辅助测试未提供必填 `eventId`，且期望旧的全局报名 URL。 |

这些失败均为测试夹具/断言迁移工作，不代表已提交的生产代码仍会调用旧 API；交付前的聚焦上下文套件和 Vite 构建已通过。
