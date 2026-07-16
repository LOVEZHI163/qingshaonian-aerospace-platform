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
printf 'POSTGRES_DB=aerogp\nPOSTGRES_USER=aerogp\nPOSTGRES_PASSWORD=%s\n' "$DB_PASSWORD" > .env
unset DB_PASSWORD
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

更新应用：

```bash
cd /opt/aerogp
docker compose build
docker compose up -d
docker compose ps
```

手工生成一次备份并验证：

```bash
cd /opt/aerogp
docker compose run --rm backup /bin/sh /scripts/backup-postgres.sh once
latest="$(find backups -maxdepth 1 -type f -name 'aerogp-*.dump' | sort | tail -n 1)"
test -n "$latest" && test -s "$latest"
docker compose run --rm backup pg_restore --list "/backups/$(basename "$latest")"
```

常驻 `backup` 服务每天自动执行一次 `pg_dump`，并删除 7 天前的 `.dump` 文件。

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

## 域名上线前

正式使用 `aerogp.cn` 前需要：完成 ICP 备案、添加 DNS 解析、配置 HTTPS、更换应用测试账号及明文业务密码，并进行正式安全审查。
