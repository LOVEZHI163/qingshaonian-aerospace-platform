# Task 6 实施报告：管理员显式赛事上下文

## 状态

已完成并提交实现。

## 实现内容

- 新增并复用 `requireEventId(db, value)`：缺少赛事返回 `422 EVENT_ID_REQUIRED`，不存在的赛事返回 `404 EVENT_NOT_AVAILABLE`。
- 管理员仪表盘不再回退到 `isCurrent` 或最新赛事，必须通过 `?eventId=` 显式选择赛事。
- 管理员报名列表、导出和证书模板复用严格解析器；证书列表/写入，以及证书 Excel 导入读写也复用同一错误契约。现有 `/api/admin/events/:eventId/...` 路由继续作为唯一业务入口，未恢复旧别名。
- 管理员报名编辑、审核、成绩写入和证书写入继续以 URL `eventId` 查找记录；URL 与报名/证书赛事不匹配为 `404`，归档赛事写入继续返回 `EVENT_ARCHIVED`。
- 新增管理员组织详情 `GET /api/admin/organizations/:id`；组织列表和详情均返回 `eventParticipations`，每项含报名、成绩和证书计数。

## TDD 与测试

红测 1：`admin-event-context.test.js` 首次因 `requireEventId` 未导出而失败。

红测 2：新增赛事范围读取的统一错误码断言，原报名列表未返回 `EVENT_NOT_AVAILABLE` 而失败。

绿测（最终）：

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/admin-event-context.test.js test/registration-management.test.js test/registration-export.test.js test/certificate-management.test.js test/audit-dashboard.test.js
```

结果：36/36 通过。

另已运行 `git diff --check`，无空白错误。全 API 套件因串行运行超过 120 秒且无中间输出，按协调要求终止；未将其作为通过证据。

## Task 10 前端迁移清单

本任务未修改前端。Task 10 需要将以下旧管理端请求统一迁移到 `/api/admin/events/:eventId/...`，并由 URL 中唯一的管理员赛事选择驱动：

- `apps/admin/src/pages/DashboardPage.vue`：`/api/admin/dashboard?eventId=` 必填。
- `apps/admin/src/pages/RegistrationManagementPage.vue`、`apps/admin/src/lib/admin-registrations.js`：报名列表、导出、编辑、成绩、状态和模板。
- `apps/admin/src/pages/CertificateManagementPage.vue`、`apps/admin/src/components/CertificateSlotEditor.vue`、`apps/admin/src/components/ManualCertificateEntryPanel.vue`：证书列表、上传、编辑、删除、发布/撤回和成绩。
- `apps/admin/src/components/CertificateImportPanel.vue`（如该组件继续使用）：导入 preview、列表、commit、取消、预览与错误报告。
- `apps/admin/src/pages/OrganizationManagementPage.vue`：保留全局组织列表，并展示 API 返回的 `eventParticipations` 统计；不应再以隐式报名列表推算这些数据。

## 自审

- 管理员业务路由保持显式赛事路径；旧 `/api/admin/registrations...`、`/api/admin/certificates...`、导入旧路径没有恢复。
- 归档赛事的管理员业务写入由现有 `requireWritableEvent` 拒绝；历史读取仍可按明确赛事访问。
- 组织资质审核、状态和文件清理是全局组织业务，不附加虚假的 `eventId`；赛事参与和业务统计则由 `eventParticipations` 明确呈现。

## Review 1 修复

- 证书 Excel 导入 preview 若请求体 `eventId` 与 URL 赛事不一致，现通过共享 `businessError` 返回 `422 EVENT_ID_MISMATCH`，不再抛出缺少错误码的 `CertificateImportError`。
- 已先新增 preview body mismatch 的 status/code 精确断言，红测确认旧响应缺少 code；修复后运行：

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/admin-event-context.test.js test/certificate-import-event-context.test.js
```

结果：6/6 通过。
