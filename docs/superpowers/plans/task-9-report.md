# Task 9：组织多赛事工作台交付报告

## Phase 2 Task 9：作品上传网关、过期清理与部署冒烟（2026-07-31）

### 状态

已完成本地实现和验证，未执行任何线上部署。

### 交付

- Nginx 在通用 `/api/` 前新增精确的 `/api/upload-sessions/` 位置：仅该位置使用 `client_max_body_size 205m`、`proxy_request_buffering off` 和 300 秒读超时；通用接口仍为 30MB/60 秒。
- Compose 为 API 固定提供临时会话 24 小时 TTL、80% 磁盘预警、90% 视频拒绝阈值。
- `cleanupExpiredSubmissionSessions()` 在存储互斥锁内执行：仅将已过期的 `active` 会话变为 `expired`；状态和资产元数据先持久化，再删除受控目录中的未绑定文件。已绑定、未过期或已提交会话不受影响；物理删除失败会安全写入 `file_cleanup_journal`。
- 生产 API 启动时执行一次清理，并启动 `unref()` 的定时器；关闭时停止定时器，测试环境不启动该计时器。
- 删除非当前归档赛事时同时清理其作品材料与上传会话，避免隔离 smoke 夹具遗留数据库记录或物理文件。
- 远程 smoke 生成小 PNG 与由 API 容器 ffmpeg 生成的短 MP4，使用复制的隔离赛事完成真实会话、双文件上传、报名绑定、管理员材料汇总及匿名私有读取 401 验证；正常或中断路径均尝试恢复原当前赛事并清理临时资源，且不输出密码、Cookie、响应正文或服务器路径。

### 红绿记录

- 先新增过期清理测试，因 `cleanupExpiredSubmissionSessions` 尚不存在而失败；实现后覆盖 active/expired、current、committed、已绑定材料和删除失败日志。
- 先新增网关/Compose/生产启动契约测试，分别在位置、环境变量和启动接线缺失时失败；实现后通过。
- 先新增定时器测试，验证启动立即执行一次、计时器 `unref()`、并可停止。
- 为 smoke 资源清理先新增归档赛事删除回归，初始失败于遗留作品文件；实现受控作品删除后通过。
- 为避免脚本内固定临时密码，先新增 smoke 安全契约并确认失败；改为基于运行时 token 派生的短寿命密码后通过。

### 验证摘要

- `node --test apps/api/test/submission-assets.test.js`：14 通过。
- `node --test apps/api/test/public-site-deployment.test.js`：10 通过。
- `node --test apps/api/test/resource-cleanup.test.js`：5 通过。
- `wsl.exe -d Ubuntu -- sh -n deploy/remote-smoke-test.sh`：通过。

### 范围账本

- Migration 009 已包含将历史组织会话回填为 `organization` 的 SQL，本轮未重复修改。
- 审核抽屉的 missing marker reset/focus 不属于本任务的网关、清理和部署脚本范围，未扩展修改。

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

## Review Fix Round 2

- 编辑器监听 `registration` 属性变更，并将运动员资料深拷贝后重置全部表单字段。
- 回归用例覆盖从报名 A 切换到报名 B：界面立即显示 B，提交只向 B 的 event-scoped PATCH 端点发送 B 的新字段，不会保留 A 的编辑内容。

验证：前端聚焦 4 files、33 passed；admin Vite build passed。
