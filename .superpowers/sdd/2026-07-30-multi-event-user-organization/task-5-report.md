# Task 5 实施报告：从报名归属推导证书访问

## 状态

已完成并提交实现。

- 实现提交：`a0a54cf0fee7a2f103685c453d3c94c1f18d461d`
- 提交说明：`feat: derive certificate access from registrations`

## 实现内容

- 证书不再保存或输出 `userId`、`organizationId`；JSON 兼容归一化会移除遗留字段，手工上传、Excel 导入和用户删除路径均不再写入或消费它们。
- 新增 `canReadCertificate(db, user, certificate)`：普通用户只读自己 `personalUserId` 报名的已发布证书；组织账户只按 `ownerUserId` 推导组织，并要求该组织已参加报名赛事且报名的 `organizationId` 相同。未发布证书仍仅管理员可读。
- 读取接口改为显式赛事上下文：
  - `GET /api/me/events/:eventId/certificates`
  - `GET /api/organization/events/:eventId/certificates`
- 管理端证书列表、上传、修改、删除、批量发布/撤回均改为 `/api/admin/events/:eventId/...`，并校验证书或报名属于 URL 赛事；归档赛事会通过 `requireWritableEvent` 拒绝写操作。
- 恢复管理员录入成绩时对同一报名证书的奖项、名次和分数同步，响应继续过滤私有文件路径。

## 测试

通过：

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/certificates.test.js test/certificate-management.test.js test/certificate-imports.test.js test/certificate-workbook.test.js test/organization-certificate-history.test.js test/authorization.test.js
```

结果：73/73 通过。

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/audit-dashboard.test.js
```

结果：5/5 通过。

另已运行 `git diff --check`，无空白错误。

## 自审

- 组织证书读取没有使用 membership 的 `owner`/`manager` 角色；只接受组织负责人 `ownerUserId`。
- 组织历史读取允许归档赛事，但仍验证负责人、参加关系、URL 赛事和报名赛事一致。
- 证书文件预览/下载统一经过 `canReadCertificate`；清理过的文件继续返回不可下载。
- 批量状态修改会逐张校验证书所属赛事，避免跨赛事混入。

## 后续关注点

- 旧管理端前端仍调用旧证书接口，留给 Tasks 8–10 迁移：`CertificateManagementPage.vue` 的列表/手工录入调用，以及 `CertificateImportPanel.vue` 的批量导入调用。该任务未提前修改 UI。
- 证书 Excel 导入路由当前仍保留既有路径和 body 中的 `eventId`；Task 6 的管理员 API 赛事上下文改造应统一迁移该组导入、预览、提交与错误报告路径。
