# AeroGP 阿里云测试环境运维手册

## 当前环境

- ECS：Ubuntu 22.04，公网 IP `47.99.181.222`
- 本机 SSH 别名：`aerogp`
- 服务器目录：`/opt/aerogp`
- 测试入口：`http://47.99.181.222`
- 域名 `aerogp.cn` 暂不解析；完成备案后再接入域名和 HTTPS

本环境仅供开发者与业主验收，访问 IP 会直接显示主页。只允许使用虚构测试数据，不上传真实身份证件、手机号或正式证书。

## 首次准备服务器

### 创建 2 GB swap

先确认服务器上没有既有 `/swapfile`：

```bash
test ! -e /swapfile
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
swapon --show
free -h
```

### 安装 Docker 与必要工具

```bash
apt-get update
apt-get install -y ca-certificates curl gnupg openssl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker version
docker compose version
```

项目中的三个基础镜像显式使用 DaoCloud 公共镜像服务，以避免中国大陆 ECS 拉取 Docker Hub 超时。该设置只作用于本项目，不会修改 Docker 的全局镜像源；正式环境也可以改成阿里云账号专属的 ACR 镜像。

### 创建部署目录和数据库密钥

```bash
install -d -m 700 /opt/aerogp /opt/aerogp/backups
cd /opt/aerogp
umask 077
DB_PASSWORD="$(openssl rand -hex 32)"
SESSION_SECRET="$(openssl rand -hex 32)"
printf 'POSTGRES_DB=aerogp\nPOSTGRES_USER=aerogp\nPOSTGRES_PASSWORD=%s\nSESSION_SECRET=%s\n' \
  "$DB_PASSWORD" "$SESSION_SECRET" > .env
unset DB_PASSWORD SESSION_SECRET
chmod 600 .env
```

数据库密码只保存在 root-only 的 `.env` 中，不写入镜像或仓库。

## 启动和检查

源码上传到 `/opt/aerogp` 后：

```bash
cd /opt/aerogp
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 postgres api web backup
```

健康检查：

```bash
curl -i http://127.0.0.1/healthz
curl -I http://127.0.0.1/
curl http://127.0.0.1/api/public/event
ss -lntp
```

预期：`/healthz`、首页和公开 API 都无需外层认证并返回 200；宿主机没有监听 4300 或 5432。

## 安全组

阿里云安全组入方向只保留：

- TCP 22：SSH
- TCP 80：测试网站
- ICMP：可选，用于诊断

删除无用途的 TCP 3389。PostgreSQL 5432 和 API 4300 不添加安全组规则。

## 日常操作

查看状态与日志：

```bash
cd /opt/aerogp
docker compose ps
docker compose logs --tail=200 api web
```

更新应用前必须先备份数据库和上传文件，并运行升级预检。预检只读取现状，不会启动或替换容器：

```bash
cd /opt/aerogp
docker compose run --rm backup /bin/sh /scripts/backup-postgres.sh once
docker compose run --rm backup /bin/sh /scripts/backup-uploads.sh once
/bin/sh deploy/preflight-admin-upgrade.sh
```

只有看到 `Upgrade preflight passed.` 后才继续切换版本：

```bash
cd /opt/aerogp
docker compose build
docker compose up -d
docker compose ps
```

手工生成并验证数据库与上传文件备份：

```bash
cd /opt/aerogp
docker compose run --rm backup /bin/sh /scripts/backup-postgres.sh once
latest="$(find backups -maxdepth 1 -type f -name 'aerogp-*.dump' | sort | tail -n 1)"
test -n "$latest" && test -s "$latest"
docker compose run --rm backup pg_restore --list "/backups/$(basename "$latest")"

docker compose run --rm backup /bin/sh /scripts/backup-uploads.sh once
latest_uploads="$(find backups/uploads -maxdepth 1 -type f -name 'aerogp-uploads-*.tar.gz' | sort | tail -n 1)"
test -n "$latest_uploads" && test -s "$latest_uploads"
docker compose run --rm backup /bin/sh /scripts/verify-uploads-backup.sh \
  "/backups/uploads/$(basename "$latest_uploads")"
```

常驻 `backup` 服务每天自动执行一次 `pg_dump`，并删除 7 天前的 `.dump` 文件。上传文件在每次升级前手工备份；脚本同样删除 7 天前的上传归档。`backup` 容器以只读方式挂载上传卷，不能修改业务文件。

部署完成后，用 root-only 环境变量传入测试管理员密码执行冒烟测试。命令和脚本都不会打印密码：

```bash
cd /opt/aerogp
umask 077
read -r -s -p '测试管理员密码: ' ADMIN_TEST_PASSWORD
export ADMIN_TEST_PASSWORD
/bin/sh deploy/remote-smoke-test.sh
unset ADMIN_TEST_PASSWORD
```

脚本会检查首页、管理端和公开接口，随后使用 cookie 登录并验证管理接口，同时确认无 cookie 的请求返回 401。正式部署后必须更换默认管理员密码。

## 恢复与回滚

恢复会覆盖当前数据库，必须先额外备份，并明确确认：

```bash
cd /opt/aerogp
CONFIRM_RESTORE=yes docker compose run --rm \
  -e CONFIRM_RESTORE=yes \
  backup /bin/sh /scripts/restore-postgres.sh /backups/备份文件.dump
```

应用回滚只切换到已经验证过的 Git commit，再执行：

```bash
docker compose up -d --build
```

不要删除 `aerogp_postgres_data` 或 `aerogp_uploads_data` volume。若数据库结构已经变化，必须先验证旧版应用是否兼容当前数据库。

恢复上传文件前，先停止 API、额外备份当前上传卷，并再次运行 `verify-uploads-backup.sh`。验证通过后只能把归档解压到空的临时目录，人工核对文件清单后再复制到上传卷；不要直接对正在使用的卷执行覆盖解压。归档校验会拒绝绝对路径和包含 `..` 路径段的文件。

## 2026-07-18 测试环境部署记录

- 服务器：阿里云 ECS `47.99.181.222`，部署目录 `/opt/aerogp`
- 应用版本：`726aedc`（`codex/admin-platform-deep-development`）
- 数据保留：沿用现有 PostgreSQL 与上传文件命名卷，部署过程未删除或重建数据卷
- 部署前数据库备份：`backups/aerogp-20260718T084428Z.dump`，已通过 `pg_restore --list` 校验
- 部署前上传文件备份：`backups/uploads/aerogp-uploads-20260718T084428Z.tar.gz`，已通过归档校验
- 部署前源码备份：`backups/source-before-admin-upgrade-20260718T084428Z.tgz`
- 自动数据库备份：`backups/aerogp-20260718T085309Z.dump`
- 服务状态：`postgres`、`api`、`web`、`backup` 均健康；公网只监听 SSH 22 与 HTTP 80
- 接口验收：首页、管理端、公开赛事接口、管理员登录和已认证管理接口均返回 200；匿名管理接口返回 401
- 页面验收：管理员、普通用户、组织用户三种角色的菜单和页面均正常
- 证书验收：使用 Excel 内嵌 PNG 完成预检查（有效 1、错误 0），导入为未发布证书后由管理员批量发布成功

本记录对应测试环境。正式域名上线前仍需完成备案、HTTPS 和测试账号更换。

## 域名上线前

正式使用 `aerogp.cn` 前需要：完成 ICP 备案、添加 DNS 解析、配置 HTTPS、更换应用测试账号及明文业务密码，并进行正式安全审查。
