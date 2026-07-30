# Task 12：安全测试业务数据清理与管理员引导交付报告

## 状态

- 功能提交：`c09377a feat: add safe test data cleanup`
- 本报告为独立文档提交，不包含业务代码变更。

## 交付内容

- 新增测试业务数据清理服务及 CLI。默认仅输出预览；只有精确参数 `--confirm=DELETE-TEST-BUSINESS-DATA` 才会执行删除。
- 清理范围包含测试用户、会话、组织、组织成员/赛事参与关系、报名、成绩、证书、证书导入批次和错误、组织证件、测试审计与认证状态；赛事、赛项、组别、官网设置、赛事公开配置、已发布官网内容和 `site-media` 均保留。
- 数据库清理在单一事务中完成，并兼容迁移 `007` 前不存在 `organization_event_participations` 表的生产数据库。
- 证书和组织证件文件只在事务提交后处理；路径必须解析在 `UPLOAD_ROOT` 内，且明确排除 `site-media`。物理文件删除失败不会回滚已提交的数据，而会写入 `file_cleanup_journal`。
- 新增一次性管理员引导 CLI：姓名、手机号来自参数，密码只通过 `--password-stdin` 从标准输入读取，使用现有密码策略和 bcrypt 哈希，不写入命令行、日志或输出；已存在管理员时拒绝创建，并在哈希后清空内存中的调用方密码引用。
- 升级预检验证两个 CLI 文件与 `007-multi-event-accounts.sql`，部署文档补充备份后预览、显式确认清理和标准输入管理员创建命令。

## 安全边界

- 本任务只新增代码、测试和部署说明；**未连接、未读取、未修改、未执行任何线上数据库或上传目录清理**。
- 未运行确认清理命令，也未启动 Docker 容器。Compose 仅使用一次性占位环境变量完成静态配置校验。
- 文档明确要求先完成数据库和上传文件备份、将应用置于维护状态，再执行预览；确认清理只能在人工核对预览后运行。
- 生产空数据库不会重新写入演示账户、组织或报名数据（由 Task 1 的 `seedOnEmpty: false` 行为保证）；清理后管理员须显式 bootstrap。

## 测试与验证

```powershell
npm.cmd test -w apps/api -- --test-concurrency=1 test/test-business-cleanup.test.js test/bootstrap-admin.test.js test/deployment-paths.test.js
# 14 passed, 0 failed

powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1
# Deployment configuration checks passed.

# 仅静态解析；使用一次性占位值，不启动服务。
$env:POSTGRES_PASSWORD='configuration-only-password'
$env:SESSION_SECRET='0123456789abcdef0123456789abcdef'
docker compose config --quiet

git diff --check
# clean
```

红绿记录：先新增清理服务、管理员引导和 CLI 确认测试，分别确认因目标模块不存在而失败；实现后通过。另新增密码引用清空测试，先确认失败，再将清空动作提前至哈希完成后，随后通过。
