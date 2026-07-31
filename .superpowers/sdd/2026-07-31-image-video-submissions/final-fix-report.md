# 作品图片与视频报名最终修复报告

日期：2026-08-01

## 已修复项

- 为 `registration_submission_assets.warnings` 新增幂等的 `010-submission-asset-warnings.sql` 迁移、schema 默认值、JSON/PG 映射与字符串数组净化；既有数据库升级、写入和重新读取均保持警告信息。
- 报名创建后，个人、组织和管理员渠道均拒绝修改 `projectId`，统一返回 `409 REGISTRATION_PROJECT_IMMUTABLE`；两处编辑界面同步禁用赛项并给出取消后重新报名的说明。
- 作品上传会话创建、成功上传、替换、会话内删除、到期清理，以及私有预览/下载均记录安全审计。摘要包含操作者、赛事、报名、上传批次、素材标识与类型等必要关联信息，不保存文件路径、存储名、Cookie 或令牌。授权失败不会写入成功审计；私有读取的审计持久化失败时拒绝读取；视频仅记录无 Range 或首个 `bytes=0-...` 请求。
- 存储告警/临界阈值改为读取 `UPLOAD_WARNING_PERCENT` 和 `UPLOAD_CRITICAL_PERCENT`，仅接受 0–100 的有限十进制值且告警值必须小于临界值；无效、空值和反向配置安全回退为 80/90。
- 管理端审核抽屉声明模态语义、打开时聚焦关闭按钮、关闭后恢复到触发按钮；素材重新可用时会清除过期的“文件缺失”标记。

## 验证证据

- `npm test -w apps/api -- --test-concurrency=1`：411/411 通过（298.8 秒）。
- `npm test -w apps/admin`：383/383 通过。
- `npm run build`：通过。仅保留既有的 Vite 代码分包体积提示。
- `node --test apps/api/test/deployment-paths.test.js apps/api/test/public-site-deployment.test.js`：23/23 通过。
- `wsl.exe -d Ubuntu -- sh -n deploy/remote-smoke-test.sh`：通过。
- `git diff --check`：通过。

## 未解决项

无。
