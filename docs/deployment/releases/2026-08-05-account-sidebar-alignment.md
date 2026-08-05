# 2026-08-05 账号侧边栏对齐修复发布记录

## 发布身份

- 运行时提交：`9cae61e1fe0973aba78f6e75d42086aebce5e681`
- 直接前版：`c3fe5ba0a971cdcda47152995a21578914304991`
- 发布归档条目数：418，大小：7,403,520 字节。
- 发布归档 SHA-256：`105389cf4e953b0b0864611ab8d3a3abbebb6d6ff6c31b66a2c54b1c5807ecb6`

## 修复范围

- 个人用户“我的组织”补齐与其他侧边栏项目一致的固定图标槽位。
- 组织用户“报名记录”等项目统一使用相同的图标和文字结构。
- 个人用户、组织用户及退出登录入口在收起和悬停展开状态下共用同一对齐规则。
- 未修改账号权限、组织关系、报名数据或数据库结构。

## 备份与回滚

- 统一回滚时间戳：`20260805T020112Z`
- 数据库：`backups/aerogp-20260805T020113Z.dump`，已通过升级预检的 `pg_restore --list` 校验。
- 上传卷：`backups/uploads/aerogp-uploads-20260805T020223Z-opkbpC.tar.gz`，已通过安全归档校验。
- 旧源码：`backups/source-before-sidebar-alignment-20260805T020112Z.tgz`，已通过 `tar -tzf` 校验。
- API 回滚标签：`aerogp-api:rollback-20260805T020112Z`
- Web 回滚标签：`aerogp-web:rollback-20260805T020112Z`

部署未执行 `docker compose down -v`，PostgreSQL 与 uploads 命名卷均保持原样。

## 验证结果

- 新增个人用户与组织用户侧边栏结构回归，并完成失败到通过的 TDD 验证。
- 管理端完整回归：42 个文件、446/446 通过。
- Web/Admin 生产构建通过。
- 线上版本一致性检查通过；登录、组织关系、跨组织隔离、组织报名、证书历史、图片与视频上传 smoke 全部通过，测试数据清理成功。
- 真实组织用户页面的五个侧边栏图标左坐标和宽度完全一致；生产页面可访问。

## 运行状态

- API 镜像：`sha256:1a9f70cacb245a5604606a5e27e5fc5463d8abe39ffa1e1143520a4ed5bf4f75`
- Web 镜像：`sha256:fff674cdd1ca528bd986ee76f92800e6856b2451b00a4b1311bde2681ba3930c`
- PostgreSQL、API、Web、Backup 四个服务均为 `running/healthy`。
- 公网 `/healthz` 与 `/admin/` 返回 200。
- 服务器磁盘：40G 总量、24G 已用、15G 可用，使用率 62%。
