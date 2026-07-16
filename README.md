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
npm run build
powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1
```

## 部署

测试环境采用 Docker Compose、Nginx、Express 和 PostgreSQL。操作步骤见 [阿里云测试环境运维手册](docs/deployment/aliyun-test.md)。
