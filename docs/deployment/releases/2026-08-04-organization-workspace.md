# 2026-08-04 组织工作台与跨赛事记录发布记录

## 发布身份

- 运行时提交：`58636be129e2cac46b9c4aa09ee7a467078c104f`
- 直接前版：`2c643b68c3fd3aeaa26909186e69337acdac650f`
- 发布归档由运行时提交的 `git archive` 直接生成，共 415 个条目、7,393,280 字节。
- 归档 SHA-256：`9d7f6cbeded3d594446477a231932c47000e8cbd36b50064fc063600d3d314a7`
- 本文档是发布后证据提交；线上 `/opt/aerogp/.release` 保持指向上述运行时提交。

## 备份与回滚

- 统一时间戳：`20260804T120010Z`
- 数据库：`backups/aerogp-20260804T120010Z.dump`，已通过 `pg_restore --list`。
- 上传卷：`backups/uploads/aerogp-uploads-20260804T120011Z-NFjGhH.tar.gz`，已通过安全归档校验。
- 旧源码：`backups/source-before-organization-workspace-20260804T120010Z.tgz`，已通过完整性及 `.env` 排除检查。
- API 回滚标签：`aerogp-api:rollback-20260804T120010Z`
- Web 回滚标签：`aerogp-web:rollback-20260804T120010Z`

全程未执行 `docker compose down -v`，未删除或重建 PostgreSQL 和 uploads 命名卷。源码同步时排除服务器 `.env`、`backups` 和旧 `.release`。

## 发布门禁

- API：452/452 通过。
- Admin：441/441 通过。
- Web：134/134 通过。
- 生产构建、`deploy/verify-config.ps1`、Shell 语法和 `git diff --check` 通过。
- 最终代码复审无 Critical、Important 或 Minor 遗留。
- 候选源码在独立 staging 目录核对摘要与条目数，同步后 `rsync` dry-run 无差异。
- 升级预检输出 `Upgrade preflight passed.`。

## 运行结果

- 新 API 镜像：`9e2001b4e55f`
- 新 Web 镜像：`3e667398930c`
- 发布一致性校验和完整认证 smoke 均成功。smoke 不再修改真实的当前赛事或首页精选赛事，清理失败会使整个 smoke 失败。
- PostgreSQL、API、Web、Backup 四个服务均为 `running/healthy`；仅 Web 发布宿主机 80 端口。
- 公网 `/`、`/admin/`、`/api/public/home` 和 `/healthz` 均返回 200。
- 发布后磁盘：40G 总量、33G 已用、5.1G 可用（87%）。下次大型媒体验收前应清理无用构建缓存，但不应删除本次回滚标签。

## 浏览器验收

- 组织侧边栏固定为“赛事工作台、报名记录、组织与成员、证书查询、退出登录”。
- 报名记录为跨赛事页面，表格包含指导老师。
- 组织证书入口为跨赛事页面，刷新或带旧 `eventId` 的深链都不会残留赛事上下文。
- 单赛事工作台无旧横向标签；15 个年级选项完整，学校默认当前组织且可编辑。
- 窄屏无整页横向溢出，浏览器控制台 warn/error 为 0。
