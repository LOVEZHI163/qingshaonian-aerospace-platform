# Task 7 实施报告：共享赛事中心与 URL 上下文

## 状态

已完成并提交实现。

- 分支：`codex/multi-event-accounts`
- 基线：`e11a6a7d9ba0804448a7203129227e0968fa974b`
- 实现提交：`50f1f61c8c07ac7165059788dcfe03abfc7ba381`（`feat: add account event center`）

## TDD 与验证

红测：先新增 `EventContextSwitcher`、`EventCenterPage` 与 App 默认入口用例，并执行：

```powershell
npm.cmd test -w apps/admin -- --run src/components/__tests__/EventContextSwitcher.test.js src/pages/__tests__/EventCenterPage.test.js src/__tests__/App.test.js
```

实现前，两个新 Vue 组件无法解析，且普通/组织账户仍进入旧业务页；新增会话赛事上下文用例则因 `loadAccountEvents` 尚不存在而失败，均为预期红测。

绿测（最终）：

```powershell
npm.cmd test -w apps/admin
npm.cmd run build
git diff --check
```

结果：管理员前端 28 个测试文件、283/283 用例通过；Web 与 Admin 生产构建通过；差异检查无空白错误。构建输出有既有 React 动态/静态导入分块提示，不影响构建成功。

## 改动

- 新增 `EventContextSwitcher.vue`：原生带标签的 `<select>`，接收 `events`、`modelValue`、`includeArchived`，仅对可见的有效赛事 ID 发出 `update:modelValue`；组件不包含账户类型判断，供普通用户、组织和管理员后续复用。
- 新增 `EventCenterPage.vue`：调用 `GET /api/me/events`，支持 0、1–3 场并行赛事；展示报名状态（未开始、报名中、已截止）、普通用户报名数，以及组织的可加入、已加入、资质不可用状态。普通用户打开赛事时发出 `{ eventId, mode: "registration" }`。
- `session.js` 新增账户可见赛事行缓存与 `loadAccountEvents()`；登出时同步清空，供 URL 恢复时验证账户可访问的赛事。
- `App.vue`：普通用户和组织负责人默认进入赛事中心；解析 `eventId` 或 `eventSlug`，在账户赛事列表中授权并规范化为 `eventId` 后才恢复赛事业务深链；无权限或失效链接回到赛事中心。非管理员 URL 继续写入 `view` 和选中的 `eventId`，并移除已规范化的 `eventSlug`。
- 增加赛事中心及选择器响应式样式，并将既有导航回归调整为赛事中心作为非管理员的入口。

## 自审

- 赛事选择器没有写死 `ordinary`、`organization` 或 `admin` 分支；账户差异仅由赛事中心卡片消费 API 返回的摘要体现。
- URL 深链只有在 `GET /api/me/events` 返回匹配 ID 或 slug 后才进入赛事业务页，刷新和复制链接不会丢失已选赛事；无匹配时不会请求报名上下文。
- 实现只提供 Task 8–10 所需的共享接口和状态边界，没有迁移普通用户报名/记录/证书端点，没有实现组织加入或赛事工作台，也没有接管管理员业务页的赛事状态。
- 空赛事、加载失败、组织资质不可用和归档赛事不在列表中的情况均保留明确 UI 状态。

## 后续关注点

- Task 8 需要把普通用户报名、当前报名和证书页面切换到显式 `eventId` API，并在无选中赛事时隐藏业务入口。
- Task 9 需要消费组织赛事中心的 `participationState`，实现加入赛事和 `organizationWorkspace`。
- Task 10 需要在管理员赛事型页面挂载 `EventContextSwitcher`，并把唯一的管理员 `eventId` 持久化到 URL。
