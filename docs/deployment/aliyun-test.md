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

### Multi-event test-data cleanup and administrator bootstrap

After the database and uploads backups have been verified and the application is in maintenance mode, first inspect the cleanup preview. The preview is read-only. Only the exact confirmation token performs the cleanup; it preserves events, projects, groups, site settings, public profiles, content, and site media.

```sh
cd /opt/aerogp
docker compose build api
docker compose run --rm --no-deps api \
  node apps/api/src/cli/cleanup-test-business-data.js
docker compose run --rm --no-deps api \
  node apps/api/src/cli/cleanup-test-business-data.js \
  --confirm=DELETE-TEST-BUSINESS-DATA
```

The cleanup command deletes only test business records and their certificate/organization-document uploads. It never removes `site-media`; failed file removals are recorded in the cleanup journal after the database transaction commits. Do not run the confirmation command until the backup and maintenance checks are complete.

Production databases do not seed demonstration accounts. Create the one administrator only after cleanup, and provide its password through standard input so it is not part of command history, arguments, logs, or Git:

```sh
cd /opt/aerogp
umask 077
read -r -s -p 'Administrator password: ' admin_password
printf '\n'
printf '%s\n' "$admin_password" | docker compose run --rm --no-deps -T api \
  node apps/api/src/cli/bootstrap-admin.js \
  --name='赛事管理员' --phone=13900000000 --password-stdin
unset admin_password
```

The bootstrap command refuses to run if an administrator already exists and never echoes the password.

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

### 官网改版发布门禁

本次官网构建固定使用公开 canonical 地址 `https://aerogp.cn`，即使域名尚未备案解析，服务器内冒烟仍使用 `BASE_URL=http://127.0.0.1`。发布前在本地执行：

```bash
npm test -w apps/api -- --run
npm test -w apps/admin -- --run
npm test -w apps/web -- --run
npm run build
docker compose config --quiet
```

`VITE_PUBLIC_SITE_URL` 只包含公开域名，不得借此向 Web 镜像注入密码、AccessKey 或会话密钥。品牌 SVG 位于 `apps/web/public/brand/`，管理端上传的官网媒体仍通过 `/api/public/media/:id` 由 API 检查发布状态，Nginx 不直接映射 `/data/uploads`。

升级前上传归档必须覆盖整个 `uploads_data` 命名卷。若卷内存在 `site-media`，备份脚本和预检都会确认归档中存在该目录；不要只备份旧证书目录。预检还会验证数据库 dump、归档安全、磁盘余量、四个服务健康状态以及只有 Web 80 端口对宿主机发布。

远程冒烟按顺序检查健康端点、公共首页、管理端、首页 JSON、动态发现的赛事详情、内容列表与动态详情、sitemap、两份品牌 SVG；若当前没有公开赛事或内容，会输出明确的安全跳过记录。管理员登录后，脚本还会验证赛事中心接口，并从管理端赛事列表动态选择一场已发布且未归档的赛事，检查其显式赛事范围的报名列表接口；旧的隐式报名列表路由必须被拒绝。随后验证已认证的官网设置/内容接口为 200、匿名官网设置接口为 401。脚本不会输出密码、cookie 或完整响应。

发布记录至少保存以下信息：

- 发布 commit SHA 与执行时间；
- 最新数据库 `.dump` 和上传 `.tar.gz` 的完整文件名及校验结果；
- `docker compose ps` 的四服务健康摘要与端口边界；
- `remote-smoke-test.sh` 的状态码/跳过摘要；
- 360、768、1440、1920px 页面验收截图及发现的问题。

推荐发布命令（在 `/opt/aerogp`，确认预检通过之后）：

```bash
docker compose build --pull
docker compose up -d
docker compose ps
BASE_URL=http://127.0.0.1 /bin/sh deploy/remote-smoke-test.sh
```

其中 `ADMIN_TEST_PASSWORD` 必须按前文通过静默输入导出，不得写入命令历史、文档或 Git。

## 恢复与回滚

恢复会覆盖当前数据库，必须先额外备份，并明确确认：

```bash
cd /opt/aerogp
CONFIRM_RESTORE=yes docker compose run --rm \
  -e CONFIRM_RESTORE=yes \
  backup /bin/sh /scripts/restore-postgres.sh /backups/备份文件.dump
```

应用回滚只切换到已经验证过的 Git commit。先把上一版本完整 SHA 保存到 `PREVIOUS_RELEASE`，再执行健康等待和 smoke；只有所有检查成功后才更新 `.release`：

```bash
PREVIOUS_RELEASE='<上一版本完整 SHA>'
docker compose up -d --build --wait --wait-timeout 240
curl -fsS http://127.0.0.1/healthz
curl -fsS http://127.0.0.1/api/public/home >/dev/null
curl -fsS http://127.0.0.1/admin/ >/dev/null
BASE_URL=http://127.0.0.1 /bin/sh deploy/remote-smoke-test.sh
printf '%s\n' "$PREVIOUS_RELEASE" > .release.next
mv .release.next .release
```

不要删除 `aerogp_postgres_data` 或 `aerogp_uploads_data` volume。若数据库结构已经变化，必须先验证旧版应用是否兼容当前数据库。

官网改版回滚时，先记录失败版本的容器日志和 smoke 摘要，再切回发布记录中的上一 commit 并重建 API/Web。默认保留当前 PostgreSQL 与上传卷；只有确认数据库迁移不兼容或上传内容损坏时，才按已校验的具体备份文件执行恢复。禁止使用 `docker compose down -v`、删除命名卷或对运行中的上传卷直接覆盖解压。

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

### 赛事设置导航增量部署

#### 本地发布门禁实际记录

- `git rev-parse --short HEAD`：退出码 0，标准输出 `a78044c`；以下四个前端文件均来自该版本。
- `npm.cmd test -w apps/admin`：受限文件系统内首次启动退出码 1，关键输出为 `Cannot read directory ... Access is denied`；获准在受限环境外以同一命令重跑，退出码 0，实际汇总为 `Test Files 18 passed (18)`、`Tests 99 passed (99)`。
- `npm.cmd run build`：退出码 0；Web 输出 `34 modules transformed`、`built in 645ms`，Admin 输出 `36 modules transformed`、`built in 1.09s`。
- `git diff --check`：退出码 0，无标准输出。

#### 升级前备份和预检实际记录

1. 数据库备份：

   ```powershell
   ssh aerogp 'cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-postgres.sh once'
   ```

   退出码 0，关键标准输出：`Created /backups/aerogp-20260718T094845Z.dump`。

2. 上传文件备份：

   ```powershell
   ssh aerogp 'cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-uploads.sh once'
   ```

   退出码 0，关键标准输出为 `Uploads backup verified: .aerogp-upload-archive-jdGoOm` 和 `/backups/uploads/aerogp-uploads-20260718T094858Z-mNBGap.tar.gz`。

3. 升级预检：

   ```powershell
   ssh aerogp 'cd /opt/aerogp && /bin/sh deploy/preflight-admin-upgrade.sh'
   ```

   退出码 0，标准输出包含 `Upgrade preflight passed.`；看到该输出后才继续上传。

4. 部署后按 brief 读取备份文件名：

   ```powershell
   ssh aerogp 'cd /opt/aerogp && ls -1t backups/aerogp-*.dump | head -n 1 && ls -1t backups/uploads/aerogp-uploads-*.tar.gz | head -n 1'
   ```

   退出码 0，实际标准输出：

   ```text
   backups/aerogp-20260718T094845Z.dump
   backups/uploads/aerogp-uploads-20260718T094858Z-mNBGap.tar.gz
   ```

   审查修订时只读执行 `ls -l` 再确认两文件存在，大小分别为 39,746 字节和 1,772,073 字节。

#### 四文件上传和 Web 重建实际记录

- 创建临时目录命令退出码 0，无标准输出：

  ```powershell
  ssh aerogp 'install -d -m 700 /tmp/aerogp-event-settings/apps/admin/src/components /tmp/aerogp-event-settings/apps/admin/src/pages /tmp/aerogp-event-settings/apps/admin/src/styles'
  ```

- 四次上传均退出码 0，均无标准输出：

  ```powershell
  scp apps/admin/src/App.vue aerogp:/tmp/aerogp-event-settings/apps/admin/src/App.vue
  scp apps/admin/src/components/AdminShell.vue aerogp:/tmp/aerogp-event-settings/apps/admin/src/components/AdminShell.vue
  scp apps/admin/src/pages/EventManagementPage.vue aerogp:/tmp/aerogp-event-settings/apps/admin/src/pages/EventManagementPage.vue
  scp apps/admin/src/styles/admin.css aerogp:/tmp/aerogp-event-settings/apps/admin/src/styles/admin.css
  ```

- 安装四文件并重建 Web 的实际命令：

  ```powershell
  ssh aerogp 'cd /opt/aerogp && install -m 644 /tmp/aerogp-event-settings/apps/admin/src/App.vue apps/admin/src/App.vue && install -m 644 /tmp/aerogp-event-settings/apps/admin/src/components/AdminShell.vue apps/admin/src/components/AdminShell.vue && install -m 644 /tmp/aerogp-event-settings/apps/admin/src/pages/EventManagementPage.vue apps/admin/src/pages/EventManagementPage.vue && install -m 644 /tmp/aerogp-event-settings/apps/admin/src/styles/admin.css apps/admin/src/styles/admin.css && docker compose build web && docker compose up -d --no-deps web'
  ```

  退出码 0；构建关键输出为 Web `34 modules transformed`、Admin `36 modules transformed`、`Image aerogp-web Built`；启动关键输出为 `Container aerogp-web-1 Recreate`、`Recreated`、`Starting`、`Started`。这条实际执行命令只把 `web` 作为 build/up 目标，且 up 使用 `--no-deps`；命令中没有数据卷删除操作。

- 重建前只读取得的容器身份：

  ```text
  /aerogp-postgres-1 7cd1887860c04f4f68d190b130af95ba2ea8ef2906bab547811ff67d6a1b9b1b 2026-07-16T12:07:30.717746772Z
  /aerogp-api-1 c2ee6753ff9d5c21c5d64a066925963e65f8e4fcb86d68fecce00060cb83cea5 2026-07-18T08:52:57.551357111Z
  /aerogp-web-1 a8dd1e50a5b4019ad6690dc4aa6005cf81aeba75943dac43d543efe14bef395e 2026-07-18T08:52:58.515392109Z
  ```

- 重建后只读取得的容器身份：

  ```text
  /aerogp-postgres-1 7cd1887860c04f4f68d190b130af95ba2ea8ef2906bab547811ff67d6a1b9b1b 2026-07-16T12:07:30.717746772Z
  /aerogp-api-1 c2ee6753ff9d5c21c5d64a066925963e65f8e4fcb86d68fecce00060cb83cea5 2026-07-18T08:52:57.551357111Z
  /aerogp-web-1 1f56c2a0e00b717860eb92e69ba3c47da2f17dcd5bc80e847f74da4f873b4510 2026-07-18T09:50:48.176456883Z
  ```

  在该部署观察窗口内，PostgreSQL 和 API 的容器 ID/创建时间前后相同，Web 的容器 ID/创建时间发生变化；这支撑“记录中的命令只重建了 Web”，不延伸为对记录外服务器操作的全局审计结论。

#### 部署后及审查修订时的只读状态

- 部署后 brief 健康检查命令退出码 0；当时 `docker compose ps` 显示 `postgres`、`api`、`web`、`backup` 均为 `healthy`，管理端状态码为 `200`，`ss -lnt` 未显示宿主机监听 4300 或 5432。
- 审查修订时再次只读执行 `ssh aerogp 'cd /opt/aerogp && docker compose ps'`，退出码 0，实际输出：

  ```text
  NAME                IMAGE                                                COMMAND                  SERVICE    CREATED             STATUS                       PORTS
  aerogp-api-1        aerogp-api                                           "docker-entrypoint.s…"   api        About an hour ago   Up About an hour (healthy)   4300/tcp
  aerogp-backup-1     m.daocloud.io/docker.io/library/postgres:16-alpine   "docker-entrypoint.s…"   backup     About an hour ago   Up About an hour (healthy)   5432/tcp
  aerogp-postgres-1   m.daocloud.io/docker.io/library/postgres:16-alpine   "docker-entrypoint.s…"   postgres   46 hours ago        Up 46 hours (healthy)        5432/tcp
  aerogp-web-1        aerogp-web                                           "/docker-entrypoint.…"   web        9 minutes ago       Up 9 minutes (healthy)       0.0.0.0:80->80/tcp, [::]:80->80/tcp
  ```

- 审查修订时再次只读执行 `ssh aerogp 'curl -fsS -o /dev/null -w "%{http_code}" http://127.0.0.1/admin/'`，退出码 0，标准输出 `200`。
- 审查修订时再次只读执行 `ssh aerogp 'ss -lnt'`，退出码 0，实际输出：

  ```text
  State  Recv-Q Send-Q Local Address:Port Peer Address:PortProcess
  LISTEN 0      4096         0.0.0.0:80        0.0.0.0:*
  LISTEN 0      128          0.0.0.0:22        0.0.0.0:*
  LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*
  LISTEN 0      4096            [::]:80           [::]:*
  LISTEN 0      128             [::]:22           [::]:*
  ```

  以上当前输出显示对外地址监听 22 和 80；53 仅绑定本地 DNS stub `127.0.0.53`。

#### 浏览器五项验收实际结果

1. 通过：管理员侧栏只有“赛事设置”，没有第二个“赛项与组别”入口。
2. 通过：进入“赛事设置”后默认选中并显示“赛事信息”。
3. 通过：点击内部“赛项与组别”后，首屏显示“管理赛事”选择器和 11 个赛项列表。
4. 通过：切回“赛事信息”后仍选中“2026年温州市青少年航空航天创新比赛”；页面列表选中项、表单赛事名和赛项页选择器一致。
5. 原功能逐项结果：
   - 报名模式：通过；真实页面显示“自动”“临时开放”“临时关闭”三个按钮。
   - 赛事操作：通过；真实页面显示“保存赛事”“复制”“归档”。
   - 赛项字段：通过；真实页面显示“赛项名称”“类别”“类型”“显示顺序”。
   - 组别：通过；真实页面显示“小学低段”“小学高段”“中学组”“职高/高中组”。
   - 指导老师：通过；真实页面显示“必须填写指导老师”。
   - 停用/删除保护：通过；11 个赛项中有报名项显示“停用”，无报名项显示“删除”，两种分支均可见；未点击这些数据修改操作。
   - 资源清理：**线上数据条件未满足，未直接验收**。线上只有一届当前赛事，没有满足“已归档且非当前”条件的赛事；为避免修改赛事数据，未新增、复制、归档或删除赛事。补充证据仅为：已部署生产 bundle 包含“历史赛事资源”“清理附件”“彻底删除赛事”三个字符串，管理端全量测试中的 `ResourceCleanupPanel` 组件测试通过；这些补充证据不等价替代真实页面验收。
   - 页面与控制台错误：通过；页面错误消息 0 条，浏览器控制台 error 0 条。

### 证书管理三模块增量部署

- 实现版本：`2d3b262c199bdaa9b975e44b0890dc7a7038bc0a`（`fix: harden manual certificate editing`）。本次只增量安装 6 个生产文件：`apps/api/src/services/registrations.js`、`apps/api/src/routes/certificates.js`、`apps/admin/src/components/ManualCertificateEntryPanel.vue`、`apps/admin/src/components/CertificateSlotEditor.vue`、`apps/admin/src/pages/CertificateManagementPage.vue`、`apps/admin/src/styles/admin.css`；临时目录文件清单恰为这 6 个文件，且远端 SHA-256 与本地逐一一致。
- 本地发布门禁：API 证书手动管理聚焦测试 9/9 通过；管理端 4 个证书管理测试文件 43/43 通过；管理端生产构建成功（37 个模块）；`deploy/verify-config.ps1` 通过；`git diff --check` 无输出。Task 5 审查修复中亲自从仓库根目录运行 `npm.cmd test -w apps/admin`，exit 0，19 个测试文件、118/118 通过；运行 `npm.cmd test -w apps/api -- --test-concurrency=1` 时 npm 参数兼容并实际执行 `node --test --test-concurrency=1`，首轮业务断言完成后有 2 项仅因 Windows 清理临时 `db.json` 的 `EBUSY` 记为失败（182/184），用完全相同的包脚本串行命令完整重跑，exit 0，184/184 通过、0 失败。
- 部署前数据库备份：`/backups/aerogp-20260718T140444Z.dump`，备份脚本退出码 0；只读复核大小 40,004 字节。
- 部署前上传文件备份：`/backups/uploads/aerogp-uploads-20260718T140459Z-akPNNc.tar.gz`，脚本输出 `Uploads backup verified` 且退出码 0；只读复核大小 1,772,092 字节。
- 预检：`deploy/preflight-admin-upgrade.sh` 退出码 0，输出 `Upgrade preflight passed.`；确认三道门禁后才建立 `/tmp/aerogp-certificate-sections` 并上传文件。
- 构建与启动：`docker compose build api web` 退出码 0，`aerogp-api` 与 `aerogp-web` 均 Built；`docker compose up -d --no-deps api web` 退出码 0，只重建 API/Web，未删除或重建 PostgreSQL、上传卷、备份或 `.env`。
- 部署后状态：`postgres`、`api`、`web`、`backup` 均为 `healthy`。API 日志显示服务监听 4300，仅有既有 `pg` deprecation warning；Web 日志显示 nginx 正常启动，无应用错误。
- 认证冒烟：brief 原命令未注入 `ADMIN_TEST_PASSWORD`，因此第一次在任何业务断言前退出 1；随后通过 SSH 标准输入安全注入现有测试密码重跑，`home`、`admin`、`event-api`、`login`、`authenticated-admin-events` 均为 200，`unauthenticated-admin-events` 为预期 401。密码未出现在命令参数、输出或文档中。
- HTTP：本机请求 `http://47.99.181.222/admin/` 返回 200。
- 浏览器验收：刷新加载新 bundle 后，默认显示证书列表；“证书列表 / 手动录入 / 批量导入”三页签切换正确；按“周星言”查询得到带赛事、学校、组别、赛项和报名号的已通过报名；选中后成绩三个字段与两个证书位置均显示可编辑控件；从列表切到手动录入再切回后，状态 `未发布` 与姓名筛选 `周星言` 均保持。
- 线上 approved 样本只读核对：按与生产服务一致的 `trim → 去全部空白 → lower` 规则标准化姓名后，approved 报名总数 1、标准化姓名数 1、拥有多个不同赛项的同名组数 0。因此没有可用于同名多赛项真实页面验收的样本；未创建或修改报名数据，该分支继续标记为未直接验收，等待用户是否授权临时造数。
- 真实 Excel 预检查与取消：使用当前管理员认证下载线上模板（HTTP 200，7,288 字节），按 `spreadsheets:Spreadsheets` 技能在 `C:\tmp` 用加载器提供的 `@oai/artifact-tool` import/inspect/render 原模板，最小生成只含一个证书标题和一张普通 PNG 的临时工作簿；关键范围、drawing 和公式错误扫描通过，临时文件未加入仓库。artifact-tool 初次导出的 OOXML 使用 `x:` SpreadsheetML 主命名空间前缀，线上 ExcelJS 在建立批次前返回 500；只规范化 4 个 XML 条目的命名空间前缀、不改变单元格/样式/图片后，部署中的生产解析器本地验证为 1 个候选、0 错误、slot 1 `image/png`。唯一一次修正后线上预检查返回 201：批次 `CIB1784385356768174`、有效 1、错误 0、替换 1；图片预览返回 200、`image/png`、1,786,046 字节；recoverable 列表在取消前包含该批次，DELETE 返回 204，取消后列表返回 `rows: []`，数据库审计行状态为 `cancelled`。正式证书在流程前后均为 1 张 `draft`，没有提交导入或改变正式证书。
- 页面错误：真实页面应用 error 0；仅有与站点无关的 Chrome 扩展 warning。

本记录对应测试环境。正式域名上线前仍需完成备案、HTTPS 和测试账号更换。

### 公开官网重设计完整部署（2026-07-19）

- 发布提交：`348052c`（`fix: avoid caching unpublished media errors`），分支 `codex/public-website-redesign`。服务器 `/opt/aerogp` 不是 Git 仓库，因此使用该提交的纯 Git 归档发布；归档 SHA-256 为 `490E0F7C205F245779A11A45D45A9F34C7D06F690DF381B81E0E6C60590C522E`，服务器 `.release` 记录 `348052c`。
- 部署前数据库备份：`backups/aerogp-20260719T113429Z.dump`，已由备份脚本创建并通过 `pg_restore --list` 预检。
- 部署前上传备份：`backups/uploads/aerogp-uploads-20260719T113448Z-PeoAnH.tar.gz`，备份脚本输出 `Uploads backup verified`；新预检同时验证存在时必须包含 `site-media`。
- 旧源码备份：`backups/source-before-public-redesign-20260719T1135Z.tgz`，另保留可直接恢复的 `backups/source-tree-before-public-redesign-20260719T1135Z/`。两次升级预检均输出 `Upgrade preflight passed.`，切换前未删除 `.env`、数据库卷或上传卷。
- 回滚镜像：从旧源码树无密钥重建 `aerogp-api:rollback-20260719T1135Z` 与 `aerogp-web:rollback-20260719T1135Z`。新镜像为 API `475d68a8ccdc`（124 MB）、Web `0c06c3140dd3`（22.9 MB）。
- 构建与切换：`docker compose build --pull` 成功；公开 Web 构建产物包含 `https://aerogp.cn` canonical，最大公共 JS chunk 141.63 kB。`docker compose up -d --wait --wait-timeout 240` 成功，PostgreSQL、API、Web、Backup 全部 healthy。
- 远程 smoke：`healthz`、首页、管理端、`/api/public/home`、内容列表、sitemap、品牌 mark/wordmark、管理员登录、官网设置和官网内容接口均为 200；匿名官网设置接口为 401。线上当时没有公开赛事和公开内容，详情检查按脚本设计安全跳过，未构造或修改业务数据。测试密码仅由标准输入临时注入，没有写入命令参数、日志、文档或 Git。
- 公网浏览器验收：`http://47.99.181.222/` 首页蓝白 A2 视觉、用户指定 SVG、零赛事安全态、赛事服务、公告/动态/作品/历史区块均正常；公告、动态/作品、历届赛事路由正常。360、768、1440、1920px 均无整页横向溢出，Logo 比例不变，移动菜单焦点进入及 Escape 关闭后焦点归还正常。各页 canonical 正确指向 `https://aerogp.cn`。管理端登录页与普通用户登录目标正常加载。
- 网络与缓存：宿主机只监听 SSH 22 和 HTTP 80；API 4300 与 PostgreSQL 5432 未发布。HTML 返回 `Cache-Control: no-store`；品牌 SVG 缓存 1 天；未发布媒体 404 保留安全响应头且不含 public immutable 缓存。
- 日志：Nginx 与 API 正常启动，无应用启动错误。API 有一条既有 `pg` 弃用警告（`client.query()` 并发调用将在 pg 9 移除），不影响本次健康检查与 smoke，列为后续技术债。
- 非破坏回滚：先保留故障日志；将旧源码树恢复到 `/opt/aerogp`，或把 Compose 的 API/Web 镜像切到上述 rollback 标签后执行 `docker compose up -d --wait`。默认保留现有 PostgreSQL 和上传卷，严禁 `docker compose down -v`；只有确认数据损坏或结构不兼容后才使用本节列出的已验证备份恢复。

### 公开官网最终审查修订与重新发布（2026-07-19）

- 实际部署源码：`88a2f8f`（`fix: reset admin certificate deep links`），服务器 `/opt/aerogp/.release` 已更新为 `88a2f8f`。本次源码归档 SHA-256 为 `D95E3AC8C202BD324D1BEA6822BC1C81D1790F498AFD9B585E6385F634DB0B08`，服务器接收后复核一致。
- 本次发布包含最终审查修订：零公开赛事时 `/api/public/home` 健康返回、定时内容自动发布、公开后内容与赛事 slug 永久锁定、历届赛事分页与当前赛事排除、报名/证书深链赛事上下文、站内锚点滚动与移动导航焦点、管理员重复点击导航时重置深链筛选。
- 部署前数据库备份：`backups/aerogp-20260719T125708Z.dump`；上传卷备份：`backups/uploads/aerogp-uploads-20260719T125722Z-FpEcdo.tar.gz`，上传备份脚本完成自校验。旧源码归档：`backups/source-before-final-review-fixes-20260719T1300Z.tgz`；可直接恢复源码树：`backups/source-tree-before-final-review-fixes-20260719T1300Z/`。
- 回滚镜像：`aerogp-api:rollback-20260719T1300Z` 与 `aerogp-web:rollback-20260719T1300Z`。新 API 镜像为 `sha256:1366d64df16ecb8b27997d1f4401492b96bfc4e0105cbd97e01556320584afab`，新 Web 镜像为 `sha256:c50a8a7c6943ace161eb59ce95157bab98ee214075e8a1417244d34433c5febb`。
- 旧源码和新源码的升级预检均输出 `Upgrade preflight passed.`。`docker compose build --pull` 成功；`docker compose up -d --wait --wait-timeout 240` 成功，PostgreSQL、API、Web、Backup 四服务全部 healthy。宿主机仅对外监听 22 和 80，API 4300 与 PostgreSQL 5432 未发布。
- 无凭据远程 smoke 通过：`healthz`、首页、管理端、`/api/public/home`、分页历届赛事、公开内容列表、sitemap、品牌 SVG、报名与证书深链 HTML 均可访问；匿名管理员 API 返回预期 401。最终重新发布未读取或探测服务器凭据，因此没有再次执行认证 smoke；认证逻辑由本地全量/聚焦测试及上一轮线上认证 smoke 覆盖，这一限制不影响本次公开站点验收结论。
- 本地发布门禁：Admin 23 个文件、185/185 通过；Web 5 个文件、103/103 通过；根生产构建通过。API 最终独立审查运行 259/260，唯一失败是 Windows 删除临时认证文件时的 `EBUSY`，相关业务聚焦重跑全部通过；`site-media` 16/16 通过。三组独立审查均为 Approved，无 Critical、Important 或 Minor 问题。
- 公网浏览器只读验收：360、768、1440、1920px 首页均无整页横向溢出；Logo SVG 比例保持正确；移动导航打开后焦点进入首个导航项，按 Esc 关闭后焦点回到菜单按钮；历届赛事在无公开数据时正确显示空状态；管理端应用可加载，移动端无横向溢出；浏览器控制台 error 为 0。验收结束后已恢复默认浏览器视口，并保留 `http://47.99.181.222/` 首页供查看。
- HTTP 与日志：HTML 使用 `no-store`；品牌 SVG 使用一天公共缓存；未发布媒体 404 保留 CSP 与 `nosniff` 且不进入 immutable 公共缓存。Nginx/API 正常启动，无应用启动错误；仅保留既有 `pg` 弃用警告作为后续技术债。
- 非破坏回滚：优先恢复本节列出的旧源码树或切换本节 rollback 镜像，然后运行 `docker compose up -d --wait`；默认保留 PostgreSQL 与上传命名卷，禁止执行 `docker compose down -v`。只有确认数据损坏或结构不兼容时，才使用本节已验证的数据库/上传备份恢复。

## 域名上线前

正式使用 `aerogp.cn` 前需要：完成 ICP 备案、添加 DNS 解析、配置 HTTPS、更换应用测试账号及明文业务密码，并进行正式安全审查。

### 多赛事账户与组织体系完整部署（2026-07-30）

- 发布源版本：`b7520aab197b94dfa0d4ba043437311956ff1975`（`chore: verify multi-event account deployment`）。部署包由该提交的 Git archive 生成；Windows 对历史中不兼容的文件名无法直接归档，改由 WSL 对同一提交生成归档并在服务器解包，服务器 `/opt/aerogp/.release` 已复核为上述完整 SHA。
- 部署前完成并验证数据库备份 `/backups/aerogp-20260730T054309Z.dump`、上传卷备份 `/backups/uploads/aerogp-uploads-20260730T054316Z-eeAEFH.tar.gz`，并保存旧源码归档 `backups/source-before-multi-event-20260730T054329Z.tgz`。升级前与候选源码预检均输出 `Upgrade preflight passed.`。
- 保留可回滚镜像 `aerogp-api:rollback-20260730T054329Z`、`aerogp-web:rollback-20260730T054329Z`，以及受限权限的 `backups/multi-event-rollback-stamp`。全程未使用 `docker compose down -v`；如需回滚，先保留故障证据，再恢复旧源码或切换上述 API/Web 镜像并执行 `docker compose up -d --wait`，默认保留 PostgreSQL 与上传卷。
- 经用户确认线上仅有测试数据后，先运行清理预览，再以精确确认串执行清理：保留赛事 4、赛项 12、项目组 48、站点设置 1、公开赛事资料 2、内容 3、媒体 12；删除测试业务数据（注册、组织、成员、证书、导入批次、结果、审计及会话等）和 1 个对应上传文件。执行后没有上传文件删除失败。
- 通过 stdin 创建一个新的有效赛事管理员。凭据仅写入服务器 `/root/aerogp-admin-credentials.txt`，文件为 3 行且权限 `0600`；密码不在命令参数、文档、Git 或部署输出中。终态业务计数：用户 1、组织 0、成员 0、赛事参与 0、报名 0、成绩 0、证书 0、导入批次 0、审计日志 0；保留赛事 4、赛项 12、内容 3。
- `docker compose build --pull` 与 `docker compose up -d --wait --wait-timeout 240` 成功；API、PostgreSQL、Web、Backup 均为 `healthy`，仅 Web 公开 `80`，API `4300` 和 PostgreSQL `5432` 未公开。构建中的依赖审计提示未阻断构建；清理脚本仅有既有 `pg` 弃用警告，未影响结果。
- 最终远程 smoke 全部通过：健康检查、官网首页、公开赛事/内容详情、sitemap、品牌资源、管理员登录、管理员赛事列表、账户赛事列表、按赛事的管理员报名接口和已认证设置/内容接口均为 `200`；遗留 `/api/admin/registrations` 为预期 `404`，未认证设置接口为预期 `401`。
- 真实 Chrome 验收：桌面 1920px 官网 `scrollWidth=1905`、控制台 error 为 0；360px 官网 `scrollWidth=345`、无横向溢出、error 为 0。移动导航可打开，唯一“用户登录”入口可进入 `/admin/`；后台登录页在 360px 下 `scrollWidth=360`、无横向溢出、error 为 0。验收结束后已恢复视口并关闭验收标签页。

#### 多赛事角色补充验收与生产恢复（2026-07-30）

- 使用仅在浏览器运行时内生成的临时凭据创建普通用户和组织负责人；组织资质为有效 PNG，并通过真实管理员审核接口审核通过。凭据没有回显或写入文档。
- 普通用户在真实 Chrome 登录后看见 2 个可报名赛事。向第一个赛事创建临时报名后，赛事中心卡片与按赛事接口均显示第一个赛事 1 条、第二个赛事 0 条，确认多赛事切换不会串报名数据。
- 已审核组织负责人在真实 Chrome 中看到 2 个可加入赛事。每次点击“加入赛事”均直接进入相应赛事工作台；先加入第一个后返回中心，再加入第二个，两个工作台的报名、待审核、证书均为 0，未混入个人报名。组织导航及工作台中没有下级管理员角色或控制项。
- 归档历史证书已完成真实浏览器下载验收。为不触碰原有赛事的 current 状态，使用唯一 ID 的数据库 fixture 建立临时已发布、非当前赛事及关联赛项/公开资料；临时普通用户经产品 API 注册、登录和报名，管理员经产品 API 审核（200）、上传 PNG 证书（201）、发布（200）和归档（200）。真实 Chrome 在历史证书页查询到 1 条记录并实际触发下载；授权文件为 HTTP 200、`image/png`、70 字节，归档页面无发布、上传、删除或编辑控件。
- fixture 的产品删除接口返回 500，未将其记为删除成功。为完整回滚该直接创建的 fixture，按唯一赛事 ID 使用子表到赛事的数据库事务删除关联证书、报名、赛项、公开资料和赛事；提交后 fixture 事件/报名/证书均为 0，受限证书目录文件数为 0。该数据库操作没有删除或修改原有赛事/内容。
- 先前“共 32 项”的自动化汇总已更正，不再作为下载验收依据；独立复跑的相关自动化为 `App.test.js` 22 项和访问控制 API 1 项，真实下载结论以上述 Chrome 证据为准。
- 此轮后再次执行清理预览与精确确认串，随后从 `/root/aerogp-admin-credentials.txt` 的受限文件经 stdin 恢复唯一管理员。最终认证 smoke 全通过；终态计数为 `1|0|0|0|0|0|0|0|0|4|12|3`，四个 Compose 服务均为 `healthy`。凭据内容未回显、未写入日志或文档，仅经 stdin 传递。

#### 归档赛事公开资料删除修复部署（2026-07-30）

- 修复源版本：`83740470cafad0b2c5e7b1f3dc6ba2043f97020e`。彻底删除带公开赛事资料的归档赛事时，第一次持久化可由外键级联删除资料，但物理文件清理后的第二次持久化会写回内存中残留的资料，导致 PostgreSQL 外键失败和 HTTP 500。修复在删除赛事前同步删除内存 `eventPublicProfiles` 行。
- TDD 证据：先在 `resource-cleanup.test.js` 给非当前归档赛事加入公开资料并断言 DELETE 后资料不存在；修复前该断言实际失败。最小修复后资源清理聚焦测试 5/5 通过，API 全量 316/316 通过。
- 部署前完成且验证数据库备份 `backups/aerogp-20260730T063435Z.dump`（`pg_restore --list` 成功）、上传卷备份 `backups/uploads/aerogp-uploads-20260730T063435Z.tar.gz`（`tar -tzf` 成功）、旧源码 `backups/source-before-delete-profile-fix-20260730T063435Z.tgz` 与同时间戳 API/Web 回滚标签。预检通过后仅重建 API；服务器 `.release` 为上述完整 SHA。
- 线上产品回归：以唯一 ID 建立非当前归档临时赛事，附加公开资料、赛项、报名和实际 PNG 文件。产品 DELETE 返回 HTTP 200，响应为删除 1 个文件且无失败；数据库复核赛事、公开资料、赛项、报名、证书均为 0，PNG 文件不存在。随后按预览/确认清理测试业务数据并经 stdin 恢复唯一管理员。
- 最终认证 smoke 全通过；终态计数 `1|0|0|0|0|0|0|0|0|4|12|3`，API、PostgreSQL、Web、Backup 均为 `healthy`。没有使用 `docker compose down -v`，凭据未回显、未写入日志或文档，仅经 stdin 传递。

### 内容编辑器与正文媒体完整部署（2026-07-31）

- 发布版本：`94d3ff8a1059fd66eaa63592bd842054e75ee635`。部署包严格由该提交的 `git archive HEAD` 生成；归档包含 363 个条目、大小 6,594,560 字节，SHA-256 为 `aadd2cf0c2fb36c73fdcb66d131779e1c2c33ab4545d2592c4c6eea5e335d5bd`。候选源码和切换后的升级预检均输出 `Upgrade preflight passed.`。
- 本地发布门禁：`git diff --check` 通过；API 使用 `--test-concurrency=1` 串行跑完 325/325；Admin 337/337；Web 134/134；根生产构建和 `deploy/verify-config.ps1` 均通过。构建只有已知的 Vite 动态/静态导入及 Admin chunk 大小提示。
- 统一备份时间戳：`20260730T171651Z`。数据库 `backups/aerogp-20260730T171651Z.dump`（58,241 字节）通过 `pg_restore --list`；上传卷 `backups/uploads/aerogp-uploads-20260730T171651Z.tar.gz`（16,719,656 字节）通过安全归档校验；旧源码 `backups/source-before-content-editor-20260730T171651Z.tgz`（3,801,708 字节）通过 `tar -tzf`。
- 旧 API/Web 镜像分别保留为 `aerogp-api:rollback-20260730T171651Z`、`aerogp-web:rollback-20260730T171651Z`；`backups/content-editor-rollback-20260730T171651Z.txt` 记录前一 release、备份名与回滚标签，权限为 `0600`。部署过程中未删除 PostgreSQL 或 uploads 命名卷，也未执行 `docker compose down -v`。
- API/Web 在同一窗口完成构建与重建；Backup 随后重建以挂载新部署树。最终 PostgreSQL、API、Web、Backup 均为 `running healthy`，API 4300 与 PostgreSQL 5432 未发布，只有 Web 映射宿主机 80。`/opt/aerogp/.release` 为上述完整 SHA。
- Codex 内置浏览器真实验收通过：工具栏的段落、H2、H3、粗体、斜体、无序/有序列表、引用、链接、撤销、重做、清除格式和图片均可用；临时新闻 `media-editor-qa-20260730` 完成两张图片的 UI 上传、插入、媒体库选择、替换、移除、保存和 reload 持久化。首次链路使用的两个文件名虽以 `.png` 结尾，真实字节均为 JPEG；该轮不能作为“真实 PNG 字节”证据，真实 PNG 复验由后续发布验收补记。
- 904px 与 360px 编辑器均无整页横向溢出；904px sticky 操作栏在滚动到底后与最后图片相隔 279px，360px 操作栏切为 static 且自身可横向滚动，正文与操作栏均可达、互不遮挡。
- 临时新闻经 UI 发布检查后发布成功。公开页桌面 1280px 和移动 360px 均无横向溢出、控制台 warn/error 均为 0；正文图片完整加载并在移动端收缩至约 321px。公开媒体 `M1785434383490866` 返回 HTTP 200、`image/jpeg` 和安全/缓存响应头；虽然测试文件扩展名为 `.png`，服务端按真实内容探测为 JPEG。
- 正文引用媒体 `M1785434383490866` 时，删除 API 返回预期 409。验收结束后经 UI 下线并删除临时文章，再删除两张已无引用媒体，均返回 204。最终计数恢复为用户 2、赛事 6、内容 3、媒体 12、cleanup journal 0、active 管理员 1，没有遗留临时业务数据或媒体文件。
- 最终 HTTP：`/`、`/admin/`、`/api/public/home`、`/healthz` 均为 200；管理员登录和 `/api/auth/me` 均为 200。受保护媒体预览的精确路由是 `GET /api/admin/site-media/:id/preview?variant=original|mobile|desktop`。本地集成测试 `private preview media requires an administrator session` 使用同一媒体验证管理员会话 200、匿名 401，并验证私有缓存响应头；浏览器验收确认编辑器中的认证预览可加载，但本轮没有把线上同一媒体的独立匿名/认证 HTTP 状态作为已执行证据。线上复核命令见下文。

受保护预览线上复核命令（本轮未单独执行；`COOKIE_JAR` 应由静默登录流程生成，不得把密码写入命令历史）：

```bash
MEDIA_ID='<待复核媒体 ID>'
test "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1/api/admin/site-media/${MEDIA_ID}/preview")" = 401
test "$(curl -sS -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "http://127.0.0.1/api/admin/site-media/${MEDIA_ID}/preview")" = 200
```

代码优先回滚（默认保留当前数据库和 uploads 卷）：

```bash
cd /opt/aerogp
docker image tag aerogp-api:rollback-20260730T192258Z aerogp-api:latest
docker image tag aerogp-web:rollback-20260730T192258Z aerogp-web:latest
docker compose up -d --no-build --force-recreate --wait --wait-timeout 240 api web
docker compose ps
curl -fsS http://127.0.0.1/healthz
curl -fsS http://127.0.0.1/api/public/home >/dev/null
curl -fsS http://127.0.0.1/admin/ >/dev/null
BASE_URL=http://127.0.0.1 /bin/sh deploy/remote-smoke-test.sh
printf '%s\n' '94d3ff8a1059fd66eaa63592bd842054e75ee635' > .release.next
mv .release.next .release
```

最后两行只能在 `docker compose` 健康等待、三个显式 HTTP 检查和完整 smoke 全部成功后执行；任一检查失败时保留当前 `.release`，继续收集故障证据。

如需从直接前版源码重建，先额外备份并保留故障日志，再把 `backups/source-before-final-fix-20260730T192258Z.tgz` 解压到 `/opt/aerogp/backups` 下的空目录，保留当前 `.env` 与 `backups` 后替换源码，运行预检并重建 API/Web。只有确认数据库迁移不兼容或数据损坏时才使用已验证 dump：

```bash
cd /opt/aerogp
CONFIRM_RESTORE=yes docker compose run --rm \
  -e CONFIRM_RESTORE=yes \
  backup /bin/sh /scripts/restore-postgres.sh \
  /backups/aerogp-20260730T192258Z.dump
```

上传卷恢复仍按本手册“恢复与回滚”章节执行：先停止 API、额外备份当前卷、重新验证归档，在空目录检查清单后再复制；禁止直接覆盖运行中的卷。

#### 内容编辑器最终审查修复与真实 PNG 复验（2026-07-31）

- 最终发布版本：`530b8087eb11ed1420310983757c0ad887ca6db8`。该版本补齐归档赛事更新/赛项更新/删除的服务端 409 写保护和管理端只读状态，统一 `content-attachment` PDF 上传契约，拒绝未知媒体用途，并修正种子归属、临时密码 428 回归测试及回滚文档。
- 最终门禁：API 329/329、Admin 338/338、Web 134/134；根生产构建、`deploy/verify-config.ps1`、`git diff --check 6e6d9ae68223748ca3b20c84c5b28cba9e05d26b..HEAD` 和敏感信息扫描全部通过。
- 发布前统一备份 stamp 为 `20260730T192258Z`；已验证 `backups/aerogp-20260730T192258Z.dump`、`backups/uploads/aerogp-uploads-20260730T192258Z.tar.gz`、`backups/source-before-final-fix-20260730T192258Z.tgz`、`backups/final-fix-rollback-20260730T192258Z.txt` 及 API/Web `rollback-20260730T192258Z` 镜像。marker 记录直接前版为 `94d3ff8a1059fd66eaa63592bd842054e75ee635`。`/opt/aerogp/.release` 为最终 `530b8087eb11ed1420310983757c0ad887ca6db8`，PostgreSQL、API、Web、Backup 四服务均 `running/healthy`，仅 Web 映射宿主机 80。
- 线上契约：未知媒体用途 422；真实 PDF 以 `content-attachment` 上传 201、删除 204；最终媒体仍为 12、cleanup journal 为 0。线上现有归档赛事数为 0，因此没有为了写保护验证创建或改变生产赛事数据。
- 真实 PNG 浏览器验收：临时内容 `POST1785440192275778` / `true-png-qa-20260731` 使用媒体 `M1785440129151338`，完成 UI 上传、插入、替代文本/题注、保存、reload、发布检查及公开发布。公开图片完整加载，natural size 375×812，公开响应为 HTTP 200、`image/png`；公开页 `clientWidth=scrollWidth=1265` 且控制台无 warn/error。
- 受保护预览线上对照为匿名 401、管理员会话 200。随后经 UI 下线并删除临时内容，再删除媒体返回 204；媒体公开地址为 404，内容页显示“内容不存在”。终态恢复为用户 2、赛事 6、内容 3、媒体 12、cleanup journal 0、active 管理员 1。
