# Task 4 报告

- 状态：完成
- 提交：`72d15af84f34e582b90e2ab4fc57ecf99868afe9`（随后将本报告随提交修订）

## 测试

已通过：

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/multi-event-registration-merge.test.js test/registration-management.test.js test/event-scoped-user-data.test.js test/multi-event-access-control.test.js
```

结果：18/18 通过。

另已通过 Task4 迁移过的授权读取与会话用例：

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 --test-name-pattern="session identity|temporary-password" test/authorization.test.js
```

结果：2/2 通过。

## 自审

- 报名统一使用 `createdByUserId`、`personalUserId`、`organizationId`、`createdVia`；新建和合并路径未写入 `registration.userId`。
- 个人端只按 `personalUserId + eventId` 读取、修改和取消；组织端只按负责人所属组织的 `organizationId + eventId` 读取、修改和创建。
- 个人关联组织要求有效成员关系和该组织已加入赛事；组织代报名要求负责人、已审核且启用的组织，以及赛事参与记录。
- 合并通过精确的 `eventId + projectId + athleteKey` 身份定位；先校验两类归属冲突，再原子变更缺失归属，且不改报名状态、成绩或证书关联数据。
- 已移除旧个人/组织报名读写入口，改为显式赛事范围路由；归档赛事会返回 `EVENT_ARCHIVED`。

## 关注点

- 证书所有权推导、证书读写接口和证书冗余字段清理严格留给 Task 5；本任务未实现该部分。
- `authorization.test.js` 中 Task4 的个人/组织报名读取、创建和状态变更断言已迁移；仅证书场景仍保留给 Task 5。

## Fix round 1（审查修复）

- 个人端编辑若尝试替换或清空既有 `organizationId`，统一返回 `REGISTRATION_OWNED_BY_OTHER_ORGANIZATION`；不得绕过合并规则。
- 旧 `/api/me/:userId` 不再附带报名聚合，个人报名只能经 `/api/me/events/:eventId/registrations` 查询。
- 个人编辑、个人状态变更和新增的管理员编辑/成绩路由都会校验可写赛事；归档赛事即使 `force_open` 也会返回 `EVENT_ARCHIVED`。
- 管理端列表、导出、编辑和成绩写入改为包含 `eventId` 的路由；旧不带赛事上下文的管理别名已移除。
- 增加并发双提交、跨组织/置空编辑冲突、归档强制开启、资料聚合绕过和旧管理入口阻断测试。
- 重复检查改为包含已取消报名，保持与精确身份唯一键一致。
