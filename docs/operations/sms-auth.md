# 短信认证上线与应急运维手册

本文适用于航空航天创新比赛平台的短信注册、短信登录和短信重置密码。当前生产主机只使用 SSH 别名 `server115`，解析地址为 `115.29.206.107`，部署目录固定为 `/opt/aerogp`。历史测试主机记录不能作为当前发布目标。

默认 CI、本地测试、`verify-release.sh` 和 `remote-smoke-test.sh` 都不得发送真实短信。真实发送会向阿里云传递手机号并产生费用，只能在另行获得当次操作确认后，按确认的掩码号码、purpose 和条数执行。

## 三个用途与独立配置

| purpose | 场景 | 模板变量 | 公开开关 |
|---|---|---|---|
| `sms-registration` | 个人或组织负责人公开注册 | `ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE` | `smsRegistrationEnabled` |
| `sms-login` | 已有账号短信登录 | `ALIYUN_SMS_LOGIN_TEMPLATE_CODE` | `smsLoginEnabled` |
| `sms-password-reset` | 已有账号短信重置密码 | `ALIYUN_SMS_RESET_TEMPLATE_CODE` | `smsPasswordResetEnabled` |

三个模板必须分别申请、审核和配置。严禁使用旧通用模板变量兜底，严禁在某个专用模板缺失时自动改用另一用途模板。一个模板变量为空时，只关闭对应用途；密码登录、邮箱链接找回和管理员后台重置密码必须继续可用。

三个用途共同遵守 6 位数字验证码、5 分钟过期、最多 5 次错误、成功后一次性消费、同号码 60 秒冷却、三个用途合并每小时 5 条和同 IP 每小时 20 次。验证码不能跨 purpose 消费。

## 账号与资格矩阵

| 账号角色/状态 | 公开注册 | 短信登录 | 短信重置密码 |
|---|---|---|---|
| 未注册个人 | 验证手机号后允许 | 不适用 | 不适用 |
| 启用普通用户 | 不允许重复注册 | 允许 | 允许 |
| 停用普通用户 | 不允许 | 不允许 | 不允许 |
| 未注册组织负责人 | 验证手机号后允许；组织初始待审核 | 不适用 | 不适用 |
| 启用负责人 + 组织已审核且启用 | 不允许重复注册 | 允许 | 允许 |
| 启用负责人 + 组织待审核或被驳回 | 不允许重复注册 | 不允许 | 允许；不会取得登录资格 |
| 启用负责人 + 组织停用 | 不允许重复注册 | 不允许 | 允许；不会取得组织工作台资格 |
| 停用组织负责人账号 | 不允许 | 不允许 | 不允许 |
| 启用管理员 | 没有公开注册入口 | 允许 | 允许 |
| 停用管理员 | 没有公开注册入口 | 不允许 | 不允许 |

登录确认必须重新读取最新用户和组织状态。短信登录不得清除 `mustChangePassword`，不得绕过账号停用或组织审核。短信重置成功后必须递增 `sessionVersion`、使旧会话失效，并清除临时密码状态。

## 阿里云和 RAM 前置条件

启用任一用途前必须确认：

1. 短信签名已审核通过，且运营商报备状态满足目标号码测试要求。
2. 三个用途各有独立的审核通过模板；实际 Code 从阿里云控制台读取，不在代码或文档中猜测。
3. 使用专门的 RAM 程序用户，不使用阿里云主账号 AccessKey，也不允许控制台登录。
4. 自定义 RAM 策略只允许发送短信：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dysms:SendSms"],
      "Resource": ["*"]
    }
  ]
}
```

不得授予 `AliyunDysmsFullAccess`，不得授予签名、模板、资质、账单、RAM、ECS、OSS、数据库或其他云产品管理权限。建议 RAM 用户名只表达单一发送用途，例如 `aerogp-sms-sender`。

## 密钥与 `.env` 安全

下列值只允许存在于 `server115:/opt/aerogp/.env` 和运行中的 API 容器环境：

- `ALIBABA_CLOUD_ACCESS_KEY_ID`
- `ALIBABA_CLOUD_ACCESS_KEY_SECRET`
- `ALIYUN_SMS_SIGN_NAME`
- 三个独立模板变量
- 可选的 `ALIYUN_CAPTCHA_SMS_REGISTRATION_SCENE_ID` 及其他验证码场景变量

`.env` 必须归部署管理员所有、权限为 `600`。进入部署目录后先执行 `umask 077`；用不会回显内容的 root 编辑方式写入，完成后执行 `chmod 600 .env`。不得通过命令行参数、聊天、工单、剪贴板记录、Git、镜像层、归档、终端回显或部署日志传递 Secret。不要运行会打印 `.env` 内容的 `cat`、`grep`、`sed`、`env` 或 `docker compose config` 非 quiet 输出。

只可用“变量是否存在/为空”的布尔检查和权限位检查做验收，不能输出变量值。发布包和备份不得包含 `.env`。

### 轮换

按组织安全周期轮换 AccessKey，并在人员变更、权限异常、未知发送或疑似泄露时立即轮换。标准顺序是：

1. 创建只有 `dysms:SendSms` 的新 AccessKey。
2. 通过不回显的方式更新 root-only `.env`，再次确认权限 `600`。
3. 只重建 API 容器并等待健康。
4. 用 feature/release 检查验证预期状态；不发送短信。
5. 经明确确认执行最小真实号码闭环后，禁用旧 AccessKey。

### 泄露处置

如果 Secret、验证码、完整手机号或注册 token 出现在聊天、日志、命令历史、构建产物或 Git：立即停止发布和真实发送，禁用受影响 AccessKey，保留不含敏感正文的事件时间线，清除暴露载体，创建新最小权限凭据，复核阿里云发送记录和 RAM 审计，再按轮换流程恢复。Secret 一旦回显就视为已泄露，不能继续使用。

## 启用顺序

1. 在本地按顺序完成 API、Admin、Web 测试与 Admin、Web 生产构建。
2. 在 `server115` 核对 `/opt/aerogp`、容器健康、磁盘、当前 40 位 release 标识和命名卷；不得读取 `.env` 内容。
3. 创建并验证 PostgreSQL、完整 uploads 和当前 release/config 备份。
4. 先发布代码但保持三个模板变量为空；重建 API/Web 后验证三个开关均为 `false`。
5. 等待三个模板审核通过并确认 RAM 最小权限。
6. 安全写入 AccessKey、签名和专用模板 Code，保持 `.env` 权限 `600`。
7. 先运行 `docker compose config --quiet`，然后只让 API 重新读取配置：

```bash
cd /opt/aerogp
docker compose up -d --no-deps --force-recreate api
docker compose ps
```

8. 等待 API 健康并核对 restart count，再运行非发送验证：

```bash
EXPECTED_RELEASE='<已部署的40位commit>' \
EXPECTED_SMS_REGISTRATION_ENABLED=true \
EXPECTED_SMS_LOGIN_ENABLED=true \
EXPECTED_SMS_PASSWORD_RESET_ENABLED=true \
BASE_URL=https://aerogp.cn \
sh deploy/verify-release.sh

BASE_URL=https://aerogp.cn sh deploy/remote-smoke-test.sh
```

`verify-release.sh` 的三个 `EXPECTED_SMS_*` 值均为必填且只能是 `true` 或 `false`。它们只描述期望，不触发发送。`remote-smoke-test.sh` 对启用的用途只核对 feature flag，绝不调用验证码 request；对关闭的用途才调用 request 并断言 `503`。

`REMOTE_SMOKE_AUTH_ONLY=true` 只供仓库内 fake `curl`/`docker` 的脚本合同测试使用；它会明确输出 `PARTIAL` 并以非零状态退出，绝不能作为发布或回滚的完整 smoke 成功证据。生产运维不得设置该变量。

9. 只有用户再次确认掩码手机号、角色、purpose、条数和费用后，才执行真实短信闭环。超出确认范围必须再次确认。

可选阿里云验证码独立启用。`ALIYUN_CAPTCHA_ENABLED=false` 时不得阻塞短信；启用前必须补齐 prefix 和每个服务端 scene，配置不完整时失败关闭。

## 关闭状态与发布验证

模板尚未审核、RAM 未准备好或首次代码发布时保持关闭：

```bash
EXPECTED_RELEASE='<已部署的40位commit>' \
EXPECTED_SMS_REGISTRATION_ENABLED=false \
EXPECTED_SMS_LOGIN_ENABLED=false \
EXPECTED_SMS_PASSWORD_RESET_ENABLED=false \
BASE_URL=https://aerogp.cn \
sh deploy/verify-release.sh

BASE_URL=https://aerogp.cn sh deploy/remote-smoke-test.sh
```

关闭状态的通过标准：三个 request 端点分别返回 `503`，密码登录成功，邮箱重置 request 仍为 `200`，且阿里云发送记录没有新增。注册关闭时，依赖公开注册造数的后续组织 smoke 会在业务写入前明确跳过；不会伪造 token 绕过生产的失败关闭门禁。

在 API 容器内部运行的组织注册 smoke 只在注册功能启用时执行。它调用生产 `createPhoneRegistrationToken`，使用容器已有 `SESSION_SECRET` 签发 15 分钟真实格式 token；token 写入 `0600` 临时文件，通过 multipart 文件输入提交，`trap` 在退出或信号中清理。该机制不新增 HTTP 后门，不请求验证码，不回显 secret 或 token。

## 冒烟矩阵

| 阶段 | 检查 | 是否发送真实短信 |
|---|---|---:|
| 默认 CI/本地 | 单元、路由、脚本行为、构建、配置静态检查 | 否 |
| 关闭状态 | 三个 feature 为 false；三个 request 为 503；密码/邮箱通道正常 | 否 |
| 启用状态非发送 smoke | 三个 feature 符合预期；密码登录、邮箱重置、正式注册路由 token 强制校验 | 否 |
| 注册真实闭环 | 个人和组织负责人分别验证、注册；管理员无注册入口 | 经当次确认 |
| 登录真实闭环 | 启用普通用户、已审核启用负责人、启用管理员成功；不合格状态失败 | 经当次确认 |
| 重置真实闭环 | 三类启用账号成功；组织审核状态不授予登录；旧会话失效 | 经当次确认 |

每轮真实验证后，只按掩码号码、时间、purpose 和模板 Code 核对阿里云发送记录、失败原因、计费条数及移动/联通/电信报备状态。不得复制短信正文、验证码或完整手机号。

## 监控与告警

持续观察：

- 各 purpose request/confirm 的成功率、`422`、`429`、`503` 和安全的供应商失败分类；
- 同号码冷却、号码小时限额、IP 小时限额命中趋势；
- 阿里云发送成功率、失败码、模板/签名状态、套餐余额和异常费用；
- feature flag 与期望配置是否漂移，API restart count 和健康检查；
- 注册 `409` 冲突、组织审核状态拒绝、重置后旧会话拒绝；
- 安全日志中是否出现疑似验证码、完整手机号、token、Cookie 或 AccessKey。

日志只记录 purpose、稳定错误分类、请求关联标识、时间和掩码号码。出现突增、未知目的地、连续供应商拒绝、RAM 权限变化或敏感输出时，先单用途关闭并保留安全证据。

## 单用途紧急关闭

单用途关闭只清空对应专用模板变量：

- 注册：`ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE`
- 登录：`ALIYUN_SMS_LOGIN_TEMPLATE_CODE`
- 重置：`ALIYUN_SMS_RESET_TEMPLATE_CODE`

使用 root 编辑器修改 `.env`，不打印修改前后值；保持权限 `600`。随后只重建 API：

```bash
cd /opt/aerogp
chmod 600 .env
docker compose up -d --no-deps --force-recreate api
docker compose ps
```

用 `verify-release.sh` 把该用途的期望设为 `false`，另外两个用途保持实际期望；再运行 remote smoke。确认被关闭用途 request 为 `503`，另外两个 feature 不变，密码登录和邮箱找回继续可用。注册关闭还必须拒绝尚未提交的历史注册 token。

不要重建 PostgreSQL，不要删除或重建 `postgres_data`、`uploads_data`、Caddy 数据或备份，不要覆盖 `.env`，严禁执行 `docker compose down -v`。

## 代码与整版回滚

代码异常时先保留日志和失败摘要，切回已经验证的上一 release，并保留 `.env`、PostgreSQL、uploads 和 Caddy 命名卷。只有确认数据库迁移不兼容且接受发布后写入损失时才恢复已验证数据库备份。

### 回滚到短信 purpose 之前的归档版本

`017-account-email-recovery.sql`、`018-sms-challenge-purposes.sql` 和 `019-team-registration.sql` 都是加法迁移，代码回滚时必须保留。尤其是 `018` 把短信 challenge 的主键改为 `(purpose, phone)`；purpose 之前的归档 API 仍使用旧通用 `ALIYUN_SMS_TEMPLATE_CODE` 和按 `phone` 的短信 SQL。若直接复用已经启用的当前短信环境，旧 API 会因“AccessKey/签名存在而旧模板为空”的不完整配置拒绝启动；即使强行提供旧模板，旧短信请求也不兼容 `018`。不要为此回退或删除任何迁移。

在部署本 release 时，把无秘密的、版本固定为 `sms-rollback-v1` 的回滚工具放到源码树之外；归档旧源码或切换旧镜像后仍可使用它：

```sh
cd /opt/aerogp
install -d -m 700 /opt/aerogp-rollback-tools/sms-rollback-v1
install -m 700 deploy/rollback/run-legacy-sms-disabled.sh \
  /opt/aerogp-rollback-tools/sms-rollback-v1/run-legacy-sms-disabled.sh
install -m 700 deploy/rollback/verify-legacy-sms-disabled.sh \
  /opt/aerogp-rollback-tools/sms-rollback-v1/verify-legacy-sms-disabled.sh
install -m 600 deploy/rollback/legacy-sms-disabled.compose.yaml \
  /opt/aerogp-rollback-tools/sms-rollback-v1/legacy-sms-disabled.compose.yaml
```

恢复已经验证的 purpose 前归档源码到 `/opt/aerogp` 时，不覆盖该目录现有 `.env`。随后以目标 SHA 启动；wrapper 会在 Compose 读取 `.env` 之前和 Compose API 环境内两次将 AccessKey、签名、旧通用模板以及三个新模板置空。它不会打印环境或调用会展开环境的 `docker compose config`，并保留 DirectMail 输入，因此密码登录和邮箱重置继续可用：

```sh
: "${PREVIOUS_RELEASE:?provide the verified 40-character previous SHA}"
RELEASE_SHA="$PREVIOUS_RELEASE" \
  /opt/aerogp-rollback-tools/sms-rollback-v1/run-legacy-sms-disabled.sh \
  /opt/aerogp -d --build --wait --wait-timeout 240
```

使用 root-owned、`0600` 的一次性密码文件运行回滚 smoke；文件路径可以进入命令，密码内容绝不能进入命令、日志或终端。该 smoke 只向保留的 PostgreSQL 查询 017–019 是否仍记录、确认旧 API 的短信 feature 为 `false` 且邮箱 feature 为 `true`、登录一个受控测试账号，并对保留的邮箱重置路由使用保留域名的未知地址（不触发实际邮件投递）：

```sh
ROLLBACK_SMOKE_PHONE='<controlled test phone>' \
ROLLBACK_SMOKE_PASSWORD_FILE='/root/aerogp-rollback-smoke-password' \
BASE_URL='http://127.0.0.1' \
  /opt/aerogp-rollback-tools/sms-rollback-v1/verify-legacy-sms-disabled.sh /opt/aerogp
```

只有 wrapper 启动、health check 和这项 smoke 都成功后，才能更新 `.release` 为 `PREVIOUS_RELEASE`。短信登录本身不修改密码，注册继续使用现有账号结构，因此供应商或模板异常通常优先使用单用途配置关闭，不需要数据库回滚。

## 严禁输出的内容

任何测试、发布、监控、排障、文档和审计记录都不得输出或保存：

- 验证码；
- 完整手机号；
- 手机号注册 token；
- AccessKey ID、AccessKey Secret；
- `SESSION_SECRET`、Cookie、管理员密码；
- 完整供应商请求/响应正文或 `.env` 内容。

只记录非秘密的 release SHA、模板 Code、掩码号码、purpose、HTTP 状态、稳定错误分类、备份标识和回滚结论。
