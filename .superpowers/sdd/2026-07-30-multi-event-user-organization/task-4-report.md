# Task 4 报告

- 状态：完成
- 提交：`72d15af84f34e582b90e2ab4fc57ecf99868afe9`（随后将本报告随提交修订）

## 测试

已通过：

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/multi-event-registration-merge.test.js test/registration-management.test.js test/event-scoped-user-data.test.js test/multi-event-access-control.test.js
```

结果：18/18 通过。

## 自审

- 报名统一使用 `createdByUserId`、`personalUserId`、`organizationId`、`createdVia`；新建和合并路径未写入 `registration.userId`。
- 个人端只按 `personalUserId + eventId` 读取、修改和取消；组织端只按负责人所属组织的 `organizationId + eventId` 读取、修改和创建。
- 个人关联组织要求有效成员关系和该组织已加入赛事；组织代报名要求负责人、已审核且启用的组织，以及赛事参与记录。
- 合并通过精确的 `eventId + projectId + athleteKey` 身份定位；先校验两类归属冲突，再原子变更缺失归属，且不改报名状态、成绩或证书关联数据。
- 已移除旧个人/组织报名读写入口，改为显式赛事范围路由；归档赛事会返回 `EVENT_ARCHIVED`。

## 关注点

- 证书所有权推导、证书读写接口和证书冗余字段清理严格留给 Task 5；本任务未实现该部分。
- `authorization.test.js` 中仍有面向已移除旧报名/组织读取路径的断言及证书场景，属于后续消费者迁移与 Task 5 范围，未在本任务扩展处理。
