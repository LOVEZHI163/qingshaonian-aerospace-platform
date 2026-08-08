# qingshaonian-aerospace-platform

2026 温州市青少年航空航天创新比赛平台。

## 本地开发

```bash
npm install
npm run dev
```

- 官网：`http://localhost:5173`
- 报名与管理端：`http://localhost:5174`
- API：`http://localhost:4300`

## 验证

```bash
npm test -w apps/api
npm test -w apps/admin
npm test -w apps/web
npm run build
powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1
docker compose config --quiet
```

## 部署

测试环境采用 Docker Compose、Nginx、Express 和 PostgreSQL。操作步骤见 [阿里云测试环境运维手册](docs/deployment/aliyun-test.md)。

组织审核、报名资格、临时密码、组织删除及相关备份/回滚操作见 [组织账号生命周期运维手册](docs/operations/organization-account-lifecycle.md)。

生产 Web 构建由 Compose 注入公开 canonical 地址 `https://aerogp.cn`。它是公开配置，不属于密钥；数据库密码、会话密钥、阿里云凭据仍只能保存在服务器 root-only `.env` 中。每次发布必须先备份 PostgreSQL 与完整上传卷（包括 `site-media`），通过预检和远程冒烟后再验收页面。
