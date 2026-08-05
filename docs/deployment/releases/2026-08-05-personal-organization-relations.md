# 2026-08-05 个人用户组织关系刷新发布记录

## 发布身份

- 运行时提交：`c3fe5ba0a971cdcda47152995a21578914304991`
- 直接前版：`58636be129e2cac46b9c4aa09ee7a467078c104f`
- 发布归档由运行时提交的 `git archive` 直接生成，共 417 个条目、7,403,520 字节。
- 归档 SHA-256：`dcf980f6391afc2696e1ce1b7eab48197547c594aa76b8b569356e07740c1ff0`

## 修复范围

- 个人用户“我的组织”页面在浏览器重新获得焦点时自动刷新关系。
- 增加手动刷新入口。
- 待审核申请和待确认邀请优先显示在组织搜索区域之前。
- 未修改成员关系数据库结构、授权边界或单组织约束。

## 备份与回滚

- 统一时间戳：`20260805T004847Z`
- 数据库：`backups/aerogp-20260805T004848Z.dump`，已通过 `pg_restore --list`。
- 上传卷：`backups/uploads/aerogp-uploads-20260805T004848Z-aPeIIh.tar.gz`，已通过安全归档校验。
- 旧源码：`backups/source-before-personal-organization-relations-20260805T004847Z.tgz`。
- API 回滚标签：`aerogp-api:rollback-20260805T004847Z`
- Web 回滚标签：`aerogp-web:rollback-20260805T004847Z`

部署未执行 `docker compose down -v`，PostgreSQL 与 uploads 命名卷均保持原样。

## 验证结果

- 成员关系 API 集成测试：10/10 通过。
- 管理端完整回归：42 个文件、444/444 通过。
- 个人组织关系回归：8/8 通过，并完成失败到通过的 TDD 验证。
- Web/Admin 生产构建通过。
- 版本一致性、登录、跨组织隔离、报名、证书历史、图片和视频上传 smoke 全部通过，测试数据清理成功。
- 线上静态资源包含 `refresh-organization-relations`，真实待接受邀请保持为 `pending / organization_invite`。

## 运行状态与磁盘

- API 镜像：`7e6cd8e597a9`
- Web 镜像：`5ba50bf13c33`
- PostgreSQL、API、Web、Backup 四个服务均为 `running/healthy`。
- 公网 `/healthz` 与 `/admin/` 返回 200，线上版本为运行时提交。
- 清理未使用的 Docker 构建缓存后，磁盘从 90% 降至 58%，40G 总量、22G 已用、16G 可用。
- 清理未删除业务数据、命名卷、当前镜像或任何回滚镜像标签。
