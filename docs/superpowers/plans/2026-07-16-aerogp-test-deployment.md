# AeroGP 测试环境部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前三应用项目部署到阿里云 ECS，通过 `http://47.99.181.222` 提供带 Basic Auth 的测试环境，并使用同机 PostgreSQL、持久化上传目录和每日备份。

**Architecture:** 使用一个 Docker Compose 项目运行 `web`、`api`、`postgres`、`backup` 四个服务。Nginx 仅在宿主机暴露 80 端口，提供 `/` 公共站、`/admin/` 管理端并把 `/api/` 反向代理到 Express；API 和 PostgreSQL 只在 Compose 内部网络通信。API 保留 JSON 文件存储作为本地测试回退，生产环境检测到 `DATABASE_URL` 后改用 PostgreSQL。

**Tech Stack:** React/Vite、Vue/Vite、Node.js/Express、PostgreSQL 16、Docker Compose、Nginx Alpine、Node 内置测试、pg、pg-mem。

## Global Constraints

- 本次仅用于开发者和业主验收，入口整体启用 Nginx Basic Auth，禁止录入真实敏感数据。
- 域名 `aerogp.cn` 暂不接入；在备案完成前只使用 ECS 公网 IP。
- 只有 22 和 80 端口对公网开放；4300、5432 不映射到宿主机；删除无用途的 3389 规则。
- 不在 Git 中提交 `.env`、Basic Auth 密码文件、数据库备份或上传文件。
- 服务器数据必须位于 Docker volume 或 `/opt/aerogp` 下的持久化目录。
- 每项修改先写失败测试或验证，再实施最小改动，再运行验证。

---

### Task 1: 建立数据存储契约测试

**Files:**
- Create: `apps/api/test/data-store.test.js`
- Create: `apps/api/src/data/seed.js`
- Modify: `apps/api/src/server.js:15-151`

- [ ] **Step 1: 为统一数据存储接口写失败测试**

  测试必须覆盖：

  - `createDataStore()` 在无 `DATABASE_URL` 时选择文件存储。
  - 文件存储首次读取时创建种子数据。
  - `writeDb()` 后再次 `readDb()` 能读到增删改结果。
  - 种子数据从 `server.js` 移到独立模块后，已有 API 测试数据保持一致。

- [ ] **Step 2: 运行测试并确认因模块尚不存在而失败**

  Run: `npm test -w apps/api -- --test-name-pattern="data store"`

  Expected: FAIL，提示无法导入 `src/data/index.js` 或缺少导出。

- [ ] **Step 3: 抽取种子数据并实现文件存储适配器**

  新建：

  - `apps/api/src/data/file-store.js`：封装当前 `DB_PATH`、`ensureDbShape()`、`readDb()`、`writeDb()`。
  - `apps/api/src/data/index.js`：导出 `createDataStore(env)`；无 `DATABASE_URL` 时返回文件存储。
  - `apps/api/src/data/seed.js`：导出当前 `seedDb`，保持 ID 和测试账号不变。

  `server.js` 只保留业务路由，通过一个 `dataStore` 调用 `readDb()` / `writeDb()`。

- [ ] **Step 4: 运行数据存储和现有 API 测试**

  Run: `npm test -w apps/api`

  Expected: 全部 PASS。

- [ ] **Step 5: 提交文件存储重构**

  ```bash
  git add apps/api/src/data apps/api/src/server.js apps/api/test/data-store.test.js
  git commit -m "refactor: extract API data store"
  ```

### Task 2: 增加 PostgreSQL 持久化

**Files:**
- Create: `apps/api/src/data/schema.sql`
- Create: `apps/api/src/data/postgres-store.js`
- Create: `apps/api/test/postgres-store.test.js`
- Modify: `apps/api/src/data/index.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: 写 PostgreSQL 存储失败测试**

  使用 `pg-mem` 提供内存 PostgreSQL 适配器，测试：

  - 初始化时创建 `users`、`organizations`、`memberships`、`events`、`projects`、`registrations`、`results`、`certificates` 表。
  - 空库自动写入当前种子数据。
  - `readDb()` 返回与现有路由一致的对象结构。
  - `writeDb()` 在一个事务内同步新增、修改和删除。
  - 重复手机号、组织代码、报名 ID、证书 ID 被唯一约束拒绝。
  - 关联字段存在外键，删除用户或报名记录时不会留下孤儿数据。

- [ ] **Step 2: 安装运行时与测试依赖并确认测试失败**

  Run: `npm install -w apps/api pg && npm install -D -w apps/api pg-mem`

  Run: `npm test -w apps/api -- --test-name-pattern="PostgreSQL"`

  Expected: FAIL，提示 PostgreSQL store 尚未实现。

- [ ] **Step 3: 建立数据库结构**

  `schema.sql` 使用应用现有字符串 ID，不依赖扩展。最低约束如下：

  - `users(phone UNIQUE)`。
  - `organizations(code UNIQUE, owner_user_id REFERENCES users)`。
  - `memberships(user_id, organization_id, UNIQUE(user_id, organization_id))`。
  - `events` 与 `projects(event_id REFERENCES events)` 保存当前赛事配置。
  - `registrations(user_id REFERENCES users, organization_id REFERENCES organizations, project_id REFERENCES projects, athlete JSONB)`。
  - `results(registration_id UNIQUE REFERENCES registrations ON DELETE CASCADE)`。
  - `certificates(registration_id REFERENCES registrations ON DELETE CASCADE, user_id REFERENCES users, organization_id REFERENCES organizations)`。
  - 为 `registrations.user_id`、`registrations.organization_id`、`memberships.organization_id`、`certificates.user_id` 建索引。

- [ ] **Step 4: 实现 PostgreSQL 存储适配器**

  `postgres-store.js` 接受可注入的 `Pool`，提供：

  ```js
  await store.initialize();
  const db = await store.readDb();
  await store.writeDb(db);
  await store.close();
  ```

  规则：

  - 初始化先执行 schema，再检查数据是否为空；空库才灌入种子。
  - `readDb()` 将 `results` 合并回现有 registration 对象的 `awardName`、`rank`、`score`、`resultRecordedAt` 字段，保证路由无感。
  - `writeDb()` 使用单事务，先 upsert 父表和子表，再按外键逆序删除内存对象中已不存在的行。
  - 连接错误不得悄悄回退到 JSON；设置 `DATABASE_URL` 后数据库不可用时 API 应启动失败。

- [ ] **Step 5: 让 API 启动前等待数据库初始化**

  把直接 `app.listen()` 改为 `startServer()`：先 `await dataStore.initialize()`，成功后监听端口；收到 `SIGTERM` / `SIGINT` 时关闭 HTTP server 和连接池。

- [ ] **Step 6: 运行全部 API 测试**

  Run: `npm test -w apps/api`

  Expected: 全部 PASS，包括原有用户和证书用例。

- [ ] **Step 7: 提交 PostgreSQL 支持**

  ```bash
  git add apps/api package-lock.json
  git commit -m "feat: persist API data in PostgreSQL"
  ```

### Task 3: 改造前端生产路径

**Files:**
- Create: `apps/api/test/deployment-paths.test.js`
- Modify: `apps/web/src/main.jsx`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/vite.config.js`

- [ ] **Step 1: 写部署路径失败测试**

  测试读取源文件并断言：

  - 两个前端的 API 默认值为同源空字符串，不再包含 `localhost:4300`。
  - 官网所有报名入口指向 `/admin/`，不再包含 `localhost:5174`。
  - 管理端 Vite `base` 为 `/admin/`。

- [ ] **Step 2: 运行测试并确认失败**

  Run: `npm test -w apps/api -- --test-name-pattern="deployment paths"`

  Expected: FAIL，指出硬编码 localhost 或缺少 admin base。

- [ ] **Step 3: 完成同源路径改造**

  - 两端使用 `const API = import.meta.env.VITE_API_URL || ""`。
  - 官网报名链接全部改成 `/admin/`。
  - 管理端 `vite.config.js` 增加 `base: "/admin/"`。

- [ ] **Step 4: 运行测试和构建**

  Run: `npm test -w apps/api`

  Run: `npm run build`

  Expected: 测试全 PASS，两个 Vite 项目成功生成 dist。

- [ ] **Step 5: 提交前端路径改造**

  ```bash
  git add apps/web/src/main.jsx apps/admin/src/App.vue apps/admin/vite.config.js apps/api/test/deployment-paths.test.js
  git commit -m "fix: use same-origin production routes"
  ```

### Task 4: 建立生产镜像与 Nginx 路由

**Files:**
- Create: `.dockerignore`
- Create: `Dockerfile.api`
- Create: `Dockerfile.web`
- Create: `deploy/nginx.conf`
- Create: `deploy/entrypoint-web.sh`

- [ ] **Step 1: 写静态部署配置验证脚本**

  新建 `deploy/verify-config.ps1`，失败条件包括：

  - API Dockerfile 不是非 root 用户运行。
  - Nginx 未同时配置 `/`、`/admin/`、`/api/`。
  - `/api/` 代理时错误地去掉或重复 `/api` 前缀。
  - Nginx 未启用 Basic Auth。
  - 任何 Dockerfile 把 `.env`、上传或数据库文件复制进镜像。

- [ ] **Step 2: 运行脚本并确认失败**

  Run: `powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1`

  Expected: FAIL，指出部署文件不存在。

- [ ] **Step 3: 实现 API 镜像**

  `Dockerfile.api` 使用 Node LTS Alpine，多阶段安装生产依赖，复制 API 源码，以非 root 用户启动 `node apps/api/src/server.js`，并包含 API 健康检查所需工具或使用 Node 自检。

- [ ] **Step 4: 实现 Web 镜像**

  `Dockerfile.web` 在构建阶段安装 workspace 依赖并构建两个前端；运行阶段使用 Nginx Alpine，将：

  - `apps/web/dist` 放到 `/usr/share/nginx/html`。
  - `apps/admin/dist` 放到 `/usr/share/nginx/html/admin`。
  - `deploy/nginx.conf` 放到 Nginx 配置目录。

  `entrypoint-web.sh` 检查 `/etc/nginx/auth/.htpasswd` 存在且非空，不满足时拒绝启动。

- [ ] **Step 5: 配置 Nginx**

  - `location /`：SPA fallback 到 `/index.html`。
  - `location /admin/`：fallback 到 `/admin/index.html`。
  - `location /api/`：`proxy_pass http://api:4300`，保留完整 URI，设置转发头和上传大小限制。
  - `location = /healthz`：仅返回 200，供容器健康检查使用。
  - 除 `/healthz` 外的入口统一启用 Basic Auth。
  - 静态 hash 资源长期缓存，HTML 不做长期缓存。

- [ ] **Step 6: 验证配置并构建镜像**

  Run: `powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1`

  Run: `docker build -f Dockerfile.api -t aerogp-api:test .`

  Run: `docker build -f Dockerfile.web -t aerogp-web:test .`

  Expected: 验证脚本 PASS，两个镜像构建成功。

- [ ] **Step 7: 提交镜像和代理配置**

  ```bash
  git add .dockerignore Dockerfile.api Dockerfile.web deploy
  git commit -m "build: add production containers and Nginx"
  ```

### Task 5: 建立 Compose、备份和运行保护

**Files:**
- Create: `compose.yaml`
- Create: `.env.example`
- Create: `deploy/backup-postgres.sh`
- Create: `deploy/restore-postgres.sh`
- Modify: `.gitignore`
- Modify: `deploy/verify-config.ps1`

- [ ] **Step 1: 扩充失败验证**

  验证脚本断言：

  - 只有 `web` 映射宿主机端口，且为 `80:80`。
  - `api` 和 `postgres` 没有 `ports`。
  - PostgreSQL、上传目录、备份目录均持久化。
  - 所有常驻服务配置健康检查、`restart: unless-stopped` 和日志轮转。
  - 数据库密码来自环境变量，不存在默认生产密码。
  - 备份保留 7 天。

- [ ] **Step 2: 运行验证并确认失败**

  Run: `powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1`

  Expected: FAIL，指出 compose 或备份配置缺失。

- [ ] **Step 3: 编写 Compose 配置**

  服务职责：

  - `postgres`：`postgres:16-alpine`，命名 volume `postgres_data`，内部健康检查。
  - `api`：使用 `Dockerfile.api`，设置 `DATABASE_URL`、`UPLOAD_ROOT=/data/uploads`，挂载 `uploads_data`，等待数据库健康。
  - `web`：使用 `Dockerfile.web`，只映射 `80:80`，只读挂载 `.htpasswd`，等待 API 健康。
  - `backup`：基于 `postgres:16-alpine`，挂载 `/backups`，每天执行 `pg_dump`，删除 7 天前备份。

  每个常驻服务增加：

  ```yaml
  restart: unless-stopped
  logging:
    driver: json-file
    options:
      max-size: "10m"
      max-file: "3"
  ```

- [ ] **Step 4: 编写备份与恢复脚本**

  - 备份文件名包含 UTC 时间戳，使用 PostgreSQL custom 格式。
  - 写入临时文件成功后再原子改名，避免留下伪成功备份。
  - 恢复脚本必须显式传入备份文件，并要求设置 `CONFIRM_RESTORE=yes`。
  - 脚本在失败时返回非零状态。

- [ ] **Step 5: 提供安全环境变量样例**

  `.env.example` 只列变量名和安全说明：`POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD`、`BASIC_AUTH_USER`；不包含可直接用于上线的密码。

- [ ] **Step 6: 验证 Compose 语法与保护项**

  Run: `Copy-Item .env.example .env`

  临时为验证填写随机值后运行：`docker compose config --quiet`

  Run: `powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1`

  Expected: 两项均 PASS；随后删除临时 `.env`。

- [ ] **Step 7: 提交编排和备份配置**

  ```bash
  git add compose.yaml .env.example .gitignore deploy
  git commit -m "ops: add compose persistence and backups"
  ```

### Task 6: 添加部署和验收说明

**Files:**
- Create: `docs/deployment/aliyun-test.md`
- Modify: `README.md`

- [ ] **Step 1: 编写服务器部署 Runbook**

  文档必须包含：

  - 已知服务器：Ubuntu 22.04、`47.99.181.222`、SSH 别名 `aerogp`。
  - 2 GB swap 创建与校验。
  - Docker 官方 apt 仓库安装方法。
  - `/opt/aerogp` 上传、`.env` 和 `.htpasswd` 生成。
  - 首次构建、启动、查看状态和日志。
  - 数据备份、恢复、升级、回滚步骤。
  - 安全组只开放 22/80、删除 3389。
  - 测试环境只允许虚构数据，域名备案后再配置 DNS/HTTPS。

- [ ] **Step 2: 更新 README 入口**

  README 增加本地启动、测试、构建及阿里云测试部署文档链接，不放密码。

- [ ] **Step 3: 人工校对所有命令**

  Run: `rg -n "CHANGE_ME|localhost:4300|localhost:5174|3389|5432:|4300:" README.md docs/deployment deploy compose.yaml .env.example`

  Expected: 除文档明确说明和验证脚本中的禁止项外，无遗留生产占位值或错误端口映射。

- [ ] **Step 4: 提交文档**

  ```bash
  git add README.md docs/deployment
  git commit -m "docs: add Aliyun test deployment runbook"
  ```

### Task 7: 本地完整验证

**Files:**
- Modify only if verification exposes defects.

- [ ] **Step 1: 运行 API 全部测试**

  Run: `npm test -w apps/api`

  Expected: 全部 PASS，0 failed。

- [ ] **Step 2: 构建两个前端**

  Run: `npm run build`

  Expected: 两个 Vite build 成功。

- [ ] **Step 3: 验证部署配置**

  Run: `powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1`

  Run: `docker compose config --quiet`

  Expected: 均 PASS。

- [ ] **Step 4: 本机启动 Compose 并做冒烟测试（若本机 Docker 可用）**

  Run: `docker compose up -d --build`

  验证：

  - `/healthz` 返回 200。
  - 无认证访问 `/` 返回 401。
  - 带认证访问 `/`、`/admin/`、`/api/public/event` 返回成功。
  - `docker compose ps` 全部 healthy。
  - `docker compose down` 后再 `up -d`，数据库和上传仍存在。

- [ ] **Step 5: 检查工作树和差异**

  Run: `git status --short`

  Run: `git diff --check`

  Expected: 只有预期文件，且无空白错误。

### Task 8: 准备阿里云 ECS

**Files:**
- Remote only: `/etc/fstab`, Docker apt configuration, `/opt/aerogp`

- [ ] **Step 1: 记录上线前状态**

  ```bash
  ssh aerogp 'uname -a; free -h; df -h /; ss -lntp; docker --version || true'
  ```

- [ ] **Step 2: 创建并持久化 2 GB swap**

  在执行前确认 `/swapfile` 不存在；创建、限制权限、初始化、启用，并只在 `/etc/fstab` 无对应行时追加。

  验证：`swapon --show && free -h`

  Expected: 显示约 2 GiB swap。

- [ ] **Step 3: 安装 Docker Engine 和 Compose plugin**

  使用 Docker 官方 Ubuntu apt 仓库安装 `docker-ce`、`docker-ce-cli`、`containerd.io`、`docker-buildx-plugin`、`docker-compose-plugin`。

  验证：`docker version && docker compose version && systemctl is-enabled docker`

- [ ] **Step 4: 创建部署目录**

  创建 `/opt/aerogp`、`/opt/aerogp/backups`、`/opt/aerogp/auth`，权限仅 root 可写；不删除服务器上任何未知目录。

### Task 9: 上传并启动测试环境

**Files:**
- Remote: `/opt/aerogp/.env`
- Remote: `/opt/aerogp/auth/.htpasswd`
- Remote: `/opt/aerogp/*` project files

- [ ] **Step 1: 上传已验证的源码**

  从本机把 Git 跟踪文件复制到 `/opt/aerogp`，排除 `.git`、`.env`、`node_modules`、`dist`、本地上传和 QA 截图。

- [ ] **Step 2: 在服务器生成随机数据库密码**

  用 `openssl rand -base64 36` 生成，仅写入 `/opt/aerogp/.env`，设置权限 600。数据库名和用户使用 `aerogp`，密码不回显到聊天或日志。

- [ ] **Step 3: 生成测试访问账号**

  用户名采用 `aerogp-test`，密码随机生成并通过 `htpasswd -B` 生成 `/opt/aerogp/auth/.htpasswd`；明文密码仅单独交付给用户一次，不写入仓库。

- [ ] **Step 4: 构建并启动**

  ```bash
  cd /opt/aerogp
  docker compose config --quiet
  docker compose up -d --build
  docker compose ps
  ```

  Expected: `web`、`api`、`postgres`、`backup` 均运行，前三个 healthy。

- [ ] **Step 5: 查看启动日志**

  Run: `docker compose logs --tail=100 postgres api web backup`

  Expected: 无数据库迁移失败、连接重试耗尽、Nginx 配置错误或备份脚本循环退出。

### Task 10: 配置安全组并验收公网访问

**Files:**
- Aliyun security group only.

- [ ] **Step 1: 修改阿里云安全组**

  - 添加 TCP 80 入方向规则。
  - 删除 TCP 3389 入方向规则。
  - 保留 TCP 22；本次先允许当前规则，后续可缩小到固定办公公网 IP。
  - ICMP 可保留用于诊断。

- [ ] **Step 2: 验证宿主机监听端口**

  Run: `ssh aerogp 'ss -lntp'`

  Expected: 公网监听只有 SSH 22 和 Web 80；没有 4300 或 5432。

- [ ] **Step 3: 从本机验证 HTTP 认证**

  - `http://47.99.181.222/healthz` 返回 200。
  - 不带认证访问 `/` 返回 401。
  - 带认证访问 `/`、`/admin/` 和 `/api/public/event` 返回 200。
  - 官网报名按钮进入 `/admin/`，管理端刷新深层路径不出现 404。

- [ ] **Step 4: 验证核心业务流程**

  使用虚构数据完成：登录、创建报名、查询报名、录入成绩、生成/发布测试证书。禁止上传真实身份证件、手机号或正式证书。

- [ ] **Step 5: 验证持久化**

  记录一条测试报名 ID，执行：

  ```bash
  ssh aerogp 'cd /opt/aerogp && docker compose restart api postgres && docker compose ps'
  ```

  重启后查询该报名仍存在。

- [ ] **Step 6: 验证备份可用**

  手工执行一次备份脚本，确认 `/opt/aerogp/backups` 产生非空 `.dump` 文件；使用 `pg_restore --list` 验证备份可读，不在当前生产卷上做破坏性恢复演练。

### Task 11: 最终交付与回滚点

**Files:**
- Modify only if final verification exposes defects.

- [ ] **Step 1: 运行最终验证**

  - 本地：API tests、Vite build、部署配置验证、`git diff --check`。
  - 服务器：Compose healthy、HTTP 认证、核心 API、持久化、备份、端口检查。

- [ ] **Step 2: 记录精确部署版本**

  Run: `git rev-parse HEAD`

  把 commit SHA、部署时间、服务器目录和镜像状态写入交付说明；不记录密码。

- [ ] **Step 3: 给出安全回滚方法**

  回滚只允许切换到已验证 Git commit 后重新 `docker compose up -d --build`；回滚前额外生成数据库备份，不删除 `postgres_data` 和 `uploads_data` volumes。

- [ ] **Step 4: 提交必要的最终修正**

  若验收中产生修复：

  ```bash
  git add <仅本次部署相关文件>
  git commit -m "fix: complete AeroGP test deployment"
  ```

