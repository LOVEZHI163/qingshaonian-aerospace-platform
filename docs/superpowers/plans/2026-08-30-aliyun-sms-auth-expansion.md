# 阿里云短信认证扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为个人和组织注册增加手机号短信验证，正式启用普通用户、组织负责人和管理员的阿里云短信登录与密码重置，同时保留密码和邮箱认证通道。

**Architecture:** 在现有按 purpose 隔离的短信挑战服务中增加 `sms-registration`，验证码确认后签发绑定手机号的 15 分钟 HMAC 注册凭证，两类注册服务在创建账号前强制验证该凭证。注册、登录和重置密码分别使用独立阿里云模板和独立功能开关；AccessKey 仅保存在 `server115` 的 root-only 环境文件中。

**Tech Stack:** Node.js 20、Express 4、PostgreSQL/文件测试存储、Node test runner、Vue 3、Vitest、Vite、Docker Compose、阿里云短信 SDK `@alicloud/dysmsapi20170525`、可选阿里云验证码 SDK `@alicloud/captcha20230305`。

**Spec:** `docs/superpowers/specs/2026-08-30-aliyun-sms-auth-expansion-design.md`

## Global Constraints

- 公开注册只允许个人账号和组织负责人账号，两者都必须验证手机号；管理员没有公开注册入口。
- 启用的管理员可以短信登录和短信重置密码；短信登录不得绕过 `mustChangePassword`、用户停用或组织审核状态。
- 密码登录、邮箱链接找回密码和管理员后台重置密码必须保持可用。
- 短信用途固定为 `sms-registration`、`sms-login`、`sms-password-reset`，不得跨用途消费验证码。
- 三个用途分别使用 `ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE`、`ALIYUN_SMS_LOGIN_TEMPLATE_CODE`、`ALIYUN_SMS_RESET_TEMPLATE_CODE`，不得回退到旧通用模板。
- 验证码固定为 6 位纯数字、5 分钟过期、最多错误 5 次、正确后一次性消费。
- 同一手机号发送冷却 60 秒、每小时最多 5 条且三个用途合并计数；同一 IP 每小时最多 20 次。
- 注册凭证使用 HMAC-SHA256、绑定规范化手机号和 `sms-registration`、15 分钟过期，只保存在页面内存。
- 不引入 JWT 或新的认证依赖；签名密钥从 `SESSION_SECRET` 按 `sms-registration-ticket:v1` 域分离派生。
- 短信配置缺失时对应功能独立失败关闭，不得影响其他短信用途、密码或邮箱通道。
- 真实 AccessKey、验证码、完整手机号和注册凭证不得进入 Git、镜像、响应、测试快照或日志。
- 当前生产 SSH 别名为 `server115`，地址为 `115.29.206.107`；旧别名和旧 IP 仅为历史记录。
- 生产目录固定为 `/opt/aerogp`；禁止 `docker compose down -v`、删除 PostgreSQL/uploads 命名卷或覆盖 `.env`。

---

## File Structure

### 新建文件

- `apps/api/src/auth/sms-registration.js`：注册验证码确认、HMAC 注册凭证签发和验证。
- `apps/api/src/routes/sms-registration.js`：注册短信 request/confirm 的 Express 路由适配层。
- `apps/api/test/sms-registration.test.js`：注册短信服务、凭证安全和账号状态单元测试。
- `apps/api/test/sms-registration-routes.test.js`：注册短信路由响应和错误映射测试。
- `apps/admin/src/components/RegistrationPhoneVerification.vue`：两类注册共享的手机号、验证码、倒计时和凭证内存状态。
- `apps/admin/src/components/__tests__/RegistrationPhoneVerification.test.js`：共享注册验证组件测试。
- `docs/operations/sms-auth.md`：短信模板、RAM、启停、监控和回滚运维手册。

### 修改文件

- `apps/api/src/auth/sms.js`、`sms-challenges.js`、`human-verification.js`：注册 purpose、模板、资格和 captcha 场景。
- `apps/api/src/services/organizations.js`、`routes/organizations.js`、`server.js`：注册凭证强制校验、路由装配和旧入口移除。
- `apps/api/test-support/server.js` 与相关注册测试：使用同一测试密钥签发注册凭证，不增加生产后门。
- `apps/admin/src/components/OrdinaryRegistrationForm.vue`、`OrganizationRegistrationForm.vue`、`pages/AuthPage.vue`、测试和 `styles.css`：注册验证 UI。
- `.env.example`、`compose.yaml`、部署检查和运维文档：安全配置与发布验证。

---

### Task 1: 扩展短信 purpose、供应商模板与人机验证配置

**Files:**
- Modify: `apps/api/src/auth/sms.js`
- Modify: `apps/api/src/auth/sms-challenges.js`
- Modify: `apps/api/src/auth/human-verification.js`
- Modify: `apps/api/test/sms-challenges.test.js`
- Modify: `apps/api/test/human-verification.test.js`
- Modify: `.env.example`
- Modify: `compose.yaml`
- Modify: `apps/api/test/deployment-paths.test.js`
- Modify: `deploy/verify-config.ps1`

**Interfaces:**
- Produces: `SMS_PURPOSES.registration === "sms-registration"`。
- Produces: `createAliyunSmsProvider(env).enabled("sms-registration")`。
- Produces: `createSmsChallengeService({ resolveEligibleTarget })`，替代仅适用于用户的 `resolveEligibleUser`。
- Produces: 按 purpose 选择的统一发送文案，以及所有短信 request 共用的大陆手机号格式校验。
- Produces: captcha 服务端场景 `sms-registration`。

- [ ] **Step 1: 写注册模板映射和功能开关失败测试**

在 `apps/api/test/sms-challenges.test.js` 使用：

```js
const PURPOSES = {
  registration: "sms-registration",
  login: "sms-login",
  passwordReset: "sms-password-reset"
};
```

供应商测试增加：

```js
ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE: "SMS_REGISTER"
```

依次发送三个用途并断言：

```js
assert.deepEqual(requests.map((row) => row.templateCode), [
  "SMS_REGISTER", "SMS_LOGIN", "SMS_RESET"
]);
```

再断言只配置注册模板时注册为 `true`，登录和重置为 `false`；缺失 AccessKey 或签名时抛 `Aliyun SMS configuration is incomplete`。

challenge 测试再覆盖：注册验证码不能被登录/重置 purpose 消费；三个用途共同计入手机号每小时 5 条上限；注册 purpose 同样执行 60 秒冷却、IP 每小时 20 次、5 分钟过期、5 次错误和一次性消费；旧异步发送失败不能删除较新的 challenge。

断言合法但已注册/不存在/状态不允许的号码仍得到 purpose 对应统一文案，且不调用供应商：

```js
const messageByPurpose = {
  "sms-registration": "如果该手机号可用于注册，验证码将发送到该号码",
  "sms-login": "如果该手机号已注册，验证码将发送到该号码",
  "sms-password-reset": "如果该手机号已注册，验证码将发送到该号码"
};
```

非法大陆手机号在限流、资格查询和供应商调用前返回 422。

- [ ] **Step 2: 写通用资格解析和注册 captcha 场景失败测试**

把 challenge harness 参数改为：

```js
resolveEligibleTarget: (db, phone) => db.users.find(
  (user) => user.phone === phone && user.status === "active"
)
```

`human-verification.test.js` 完整环境增加：

```js
ALIYUN_CAPTCHA_SMS_REGISTRATION_SCENE_ID: "sms-registration-scene"
```

并断言注册场景请求使用服务端 `sms-registration-scene`。

- [ ] **Step 3: 运行测试并确认失败**

Run:

```powershell
node --test apps/api/test/sms-challenges.test.js apps/api/test/human-verification.test.js
```

Expected: FAIL，注册 purpose、模板变量和场景尚不存在。

- [ ] **Step 4: 实现 purpose 与通用资格解析**

```js
export const SMS_PURPOSES = Object.freeze({
  registration: "sms-registration",
  login: "sms-login",
  passwordReset: "sms-password-reset"
});
```

后台任务改为：

```js
const eligibleTarget = await resolveEligibleTarget(db, phone);
if (!eligibleTarget) {
  await authState.deleteChallenge({ purpose, phone, digest: requestDigest });
  return;
}
```

所有调用点和测试统一使用 `resolveEligibleTarget`。

request 开头规范化后执行：

```js
if (!/^1[3-9]\d{9}$/.test(phone)) {
  throw new SmsChallengeError(422, "手机号格式无效");
}
```

校验通过后才消耗手机号/IP 限流。返回文案从 `messageByPurpose[purpose]` 读取，不允许注册 purpose 复用“已注册”文案。

- [ ] **Step 5: 实现三个模板映射和 captcha 场景**

`sms.js`：

```js
const templateByPurpose = {
  "sms-registration": env.ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE,
  "sms-login": env.ALIYUN_SMS_LOGIN_TEMPLATE_CODE,
  "sms-password-reset": env.ALIYUN_SMS_RESET_TEMPLATE_CODE
};
```

`human-verification.js`：

```js
const sceneIds = {
  "sms-registration": env.ALIYUN_CAPTCHA_SMS_REGISTRATION_SCENE_ID,
  "sms-login": env.ALIYUN_CAPTCHA_LOGIN_SCENE_ID,
  "sms-password-reset": env.ALIYUN_CAPTCHA_SMS_RESET_SCENE_ID,
  "email-password-reset": env.ALIYUN_CAPTCHA_EMAIL_RESET_SCENE_ID
};
```

保持 captcha 关闭时 no-op，开启但配置不全时失败关闭。

- [ ] **Step 6: 更新环境、Compose 和配置检查**

`.env.example` 增加：

```dotenv
ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE=
ALIYUN_CAPTCHA_SMS_REGISTRATION_SCENE_ID=
```

`compose.yaml` 透传同名变量。配置测试和 PowerShell 检查断言变量存在，且不存在旧 `ALIYUN_SMS_TEMPLATE_CODE` 或硬编码 Secret。

- [ ] **Step 7: 运行定向与配置测试**

```powershell
node --test apps/api/test/sms-challenges.test.js apps/api/test/human-verification.test.js apps/api/test/deployment-paths.test.js
powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1
```

Expected: PASS。

- [ ] **Step 8: 提交**

```powershell
git add apps/api/src/auth apps/api/test/sms-challenges.test.js apps/api/test/human-verification.test.js apps/api/test/deployment-paths.test.js .env.example compose.yaml deploy/verify-config.ps1
git commit -m "feat(auth): add sms registration purpose"
```

---

### Task 2: 创建短期手机号注册凭证服务

**Files:**
- Create: `apps/api/src/auth/sms-registration.js`
- Create: `apps/api/test/sms-registration.test.js`

**Interfaces:**
- Consumes: `challengeService.enabled/request/consume`。
- Produces: `createPhoneRegistrationToken({ phone, secret, now, nonce }) -> { phoneVerificationToken, expiresAt }`。
- Produces: `verifyPhoneRegistrationToken({ phone, phoneVerificationToken, secret, now }) -> true`。
- Produces: `createSmsRegistrationService({ challengeService, readDb, secret, clock, randomNonce })`，返回 `enabled/request/confirm/verify`。

- [ ] **Step 1: 写签名、过期和篡改失败测试**

```js
const issued = createPhoneRegistrationToken({
  phone: "138 0000 0001",
  secret: "s".repeat(32),
  now,
  nonce: "fixed-nonce"
});
assert.equal(issued.expiresAt, new Date(now + 15 * 60 * 1000).toISOString());
assert.equal(verifyPhoneRegistrationToken({
  phone: "13800000001",
  phoneVerificationToken: issued.phoneVerificationToken,
  secret: "s".repeat(32),
  now: now + 14 * 60 * 1000
}), true);
```

同一测试分别用不同手机号、尾部篡改令牌、不同 secret 和 `now + 15 分钟`，均断言 `SmsRegistrationError(422, "手机号验证已过期，请重新验证")`。

另断言 token 未过期时，同一手机号可在表单校验失败后重复验证并重试最终注册；纯 token 校验本身不承担一次性消费，最终账号唯一性由数据库写入边界保证。

- [ ] **Step 2: 写验证码确认和账号状态重检失败测试**

```js
const service = createSmsRegistrationService({
  challengeService: {
    enabled: true,
    request: async (input) => ({ ok: true, input }),
    consume: async () => valid
  },
  readDb: async () => structuredClone(db),
  secret: "s".repeat(32),
  clock: () => now,
  randomNonce: () => "fixed-nonce"
});
```

断言正确 code 返回 token；错误 code 拒绝；发送后手机号被注册时 confirm 返回“验证码无效或已过期”。

- [ ] **Step 3: 运行测试并确认失败**

```powershell
node --test apps/api/test/sms-registration.test.js
```

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现无依赖 HMAC 令牌**

使用 Node crypto：

```js
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
const TOKEN_TTL_MS = 15 * 60 * 1000;
const PURPOSE = "sms-registration";
const normalizePhone = (value) => String(value || "").replace(/\D/g, "");
```

载荷固定为：

```js
{ v: 1, purpose: PURPOSE, phone: normalizePhone(phone), iat: now, exp: now + TOKEN_TTL_MS, nonce }
```

签名密钥：

```js
const key = createHmac("sha256", secret)
  .update("sms-registration-ticket:v1")
  .digest();
```

令牌为 `<base64url(JSON)>.<base64url(HMAC)>`。验证时检查两段和 Buffer 长度，再用 `timingSafeEqual`；解析、签名、版本、用途、手机号和过期错误全部映射为同一安全错误。

- [ ] **Step 5: 实现服务工厂**

```js
async confirm({ phone, code }) {
  const normalized = normalizePhone(phone);
  if (!await challengeService.consume({ phone: normalized, code })) throw invalidCode();
  const db = await readDb();
  if (db.users.some((user) => normalizePhone(user.phone) === normalized)) throw invalidCode();
  return createPhoneRegistrationToken({
    phone: normalized, secret, now: clock(), nonce: randomNonce()
  });
}
```

`verify(input)` 调用纯验证函数；`request(input)` 原样委托 challenge；`enabled` 等于 challenge 的开关。

- [ ] **Step 6: 运行测试并提交**

```powershell
node --test apps/api/test/sms-registration.test.js
git add apps/api/src/auth/sms-registration.js apps/api/test/sms-registration.test.js
git commit -m "feat(auth): issue verified phone registration tokens"
```

Expected: PASS 后提交。

---

### Task 3: 在所有公开注册路径强制验证手机号凭证

**Files:**
- Modify: `apps/api/src/services/organizations.js`
- Modify: `apps/api/src/routes/organizations.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test-support/server.js`
- Modify: `apps/api/test/organization-credentials.test.js`
- Modify: `apps/api/test/authorization.test.js`
- Modify: `apps/api/test/membership-relations.test.js`
- Modify: `apps/api/test/mutation-architecture.test.js`
- Modify: `apps/api/test/organization-account-lifecycle.test.js`
- Modify: `apps/api/test/submission-assets.test.js`

**Interfaces:**
- Consumes: `verifyPhoneRegistration({ phone, phoneVerificationToken }) -> true`。
- Produces: 两个注册业务服务在写入前验证凭证。
- Produces: `createOrganizationsRouter({ verifyPhoneRegistration, ... })`。
- Removes: 旧 `POST /api/auth/register`，请求返回 404。

- [ ] **Step 1: 写两类注册凭证失败测试**

服务级测试传入：

```js
verifyPhoneRegistration: async () => {
  throw new Error("invalid registration token");
}
```

断言个人和组织注册均抛 `OrganizationError(422, "手机号验证已过期，请重新验证")`，`writeDb` 与组织 `saveFile` 未调用。成功测试断言验证器收到规范化手机号和输入 token。

增加两个并发最终注册测试：同一手机号持相同有效 token 同时提交时恰好一个成功，另一个返回 409；组织注册失败分支不得残留资质文件。现有密码强度、手机号唯一、信用代码唯一、真实文件签名和文件大小测试必须继续通过。

- [ ] **Step 2: 写旧注册入口绕过测试**

```js
const legacy = await fetch(`${baseUrl}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "绕过", phone: "13600009989", password: "Strong123", type: "ordinary" })
});
assert.equal(legacy.status, 404);
```

- [ ] **Step 3: 运行测试并确认失败**

```powershell
node --test apps/api/test/organization-credentials.test.js
```

Expected: FAIL，业务服务未校验，旧路由仍存在。

- [ ] **Step 4: 在注册服务集中验证**

```js
async function assertPhoneVerified(input, phone, verifyPhoneRegistration) {
  try {
    await verifyPhoneRegistration({
      phone,
      phoneVerificationToken: String(input.phoneVerificationToken || "")
    });
  } catch {
    throw validationError("手机号验证已过期，请重新验证");
  }
}
```

`registerOrdinary` 在密码哈希和数据库写入前调用；`registerOrganization` 在 `saveFile` 和写入前调用。两个函数签名增加 `verifyPhoneRegistration`。

- [ ] **Step 5: 注入路由并删除旧入口**

`createOrganizationsRouter` 接收验证器并加入 `deps`。完整删除 `server.js` 中旧 `app.post("/api/auth/register", ...)`，不保留兼容分支。

- [ ] **Step 6: 为集成测试签发真实格式测试 token**

`apps/api/test-support/server.js` 导入 Task 2 纯函数：

```js
const sessionSecret = env.SESSION_SECRET || "test-session-secret-32-characters";
function phoneVerificationToken(phone) {
  return createPhoneRegistrationToken({
    phone,
    secret: sessionSecret,
    now: Date.now(),
    nonce: `test-${String(phone).replace(/\D/g, "")}`
  }).phoneVerificationToken;
}
```

子进程显式获得相同 `SESSION_SECRET`；回调上下文增加 `phoneVerificationToken`。现有个人 JSON 和组织 FormData 都补充同名字段。直接调用业务服务、专门测试文件回滚的位置传 `verifyPhoneRegistration: async () => true`。

- [ ] **Step 7: 更新路由工厂测试依赖**

直接创建 `createOrganizationsRouter` 的测试增加：

```js
verifyPhoneRegistration: async () => true
```

并断言失败验证不会产生业务写入。

- [ ] **Step 8: 运行所有注册相关测试**

```powershell
node --test apps/api/test/organization-credentials.test.js apps/api/test/authorization.test.js apps/api/test/membership-relations.test.js apps/api/test/mutation-architecture.test.js apps/api/test/organization-account-lifecycle.test.js apps/api/test/submission-assets.test.js
```

Expected: PASS；旧入口为 404；两类正式入口必须有有效 token。

- [ ] **Step 9: 提交**

```powershell
git add apps/api/src/services/organizations.js apps/api/src/routes/organizations.js apps/api/src/server.js apps/api/test-support/server.js apps/api/test
git commit -m "feat(auth): require verified phones for registration"
```

---

### Task 4: 接通注册短信 API，并回归三类账号的登录与重置

**Files:**
- Create: `apps/api/src/routes/sms-registration.js`
- Create: `apps/api/test/sms-registration-routes.test.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test/sms-login.test.js`
- Modify: `apps/api/test/password-reset.test.js`

**Interfaces:**
- Produces: `POST /api/auth/register/sms/request`，请求体 `{ phone, captchaVerifyParam? }`。
- Produces: `POST /api/auth/register/sms/confirm`，请求体 `{ phone, code }`，成功返回 `{ phoneVerificationToken, expiresAt }`。
- Produces: 公共功能开关 `smsRegistrationEnabled`，供管理端决定是否开放注册提交。
- Consumes: captcha purpose `sms-registration`。
- Preserves: 短信登录和短信重置的普通用户、组织负责人、管理员资格规则。

- [ ] **Step 1: 写注册短信路由响应失败测试**

用最小 fake service 创建路由，覆盖：

```js
const service = {
  enabled: true,
  request: async ({ phone, ip }) => ({ accepted: true, phone, ip }),
  confirm: async () => ({
    phoneVerificationToken: "signed-registration-token",
    expiresAt: "2026-08-30T10:15:00.000Z"
  })
};
```

断言 request 成功统一返回不泄露账号状态的受理文案；confirm 成功只返回 token 和过期时间。另覆盖：功能关闭 503、手机号格式错误 422、验证码错误 422、限流 429、异常不泄露完整手机号或验证码。

- [ ] **Step 2: 写三类账号资格回归测试**

在 `sms-login.test.js` 增加：

```js
for (const role of ["ordinary", "organization_owner", "admin"]) {
  // active eligible account requests and consumes an sms-login challenge
}
```

断言：启用管理员可登录；停用管理员不可登录；组织负责人仅在组织 `approved` 且 `active` 时可登录；短信登录后仍保留 `mustChangePassword` 语义。

增加“发送后状态变化”用例：验证码发送后停用普通用户/管理员，或把组织改为待审核、驳回、停用，confirm 均失败且不创建会话。

在 `password-reset.test.js` 断言：启用的三类账号均可短信重置；待审核或被拒绝组织的启用负责人仍可重置；重置后 `sessionVersion` 增加、旧会话失效、临时密码密文清除且 `mustChangePassword === false`。

- [ ] **Step 3: 运行测试并确认失败**

```powershell
node --test apps/api/test/sms-registration-routes.test.js apps/api/test/sms-login.test.js apps/api/test/password-reset.test.js
```

Expected: FAIL，注册短信路由尚不存在，challenge 参数仍使用旧接口名。

- [ ] **Step 4: 实现薄路由适配层**

导出：

```js
export function createSmsRegistrationRouter({ smsRegistration })
```

request 路由把参数交给注册服务：

```js
await smsRegistration.request({
  phone: req.body?.phone,
  captchaVerifyParam: req.body?.captchaVerifyParam,
  ip: req.ip
});
```

captcha 仍由 challenge service 以 `sms-registration` purpose 验证，不在路由重复验证。confirm 仅调用 `smsRegistration.confirm({ phone, code })`。错误映射沿用短信登录/重置现有状态码和安全文案，不复制业务逻辑。

- [ ] **Step 5: 在 server 装配注册服务**

注册 challenge 的资格解析器固定为“手机号尚未注册”：

```js
resolveEligibleTarget: (db, phone) => {
  const exists = db.users.some((user) => normalizePhone(user.phone) === phone);
  return exists ? null : { phone };
}
```

创建 `createSmsRegistrationService(...)`，挂载路由，并把：

```js
verifyPhoneRegistration: smsRegistration.verify
```

传给组织路由。公共配置响应增加：

```js
smsRegistrationEnabled: smsRegistration.enabled
```

验证码启用时，公开 captcha 配置还要包含：

```js
smsRegistration: captchaConfig.scenes[SMS_PURPOSES.registration] || ""
```

验证码关闭时不暴露 scene、不阻止短信。登录和密码重置 challenge 调用点全部从 `resolveEligibleUser` 改为 `resolveEligibleTarget`，资格行为保持不变。

- [ ] **Step 6: 运行 API 回归测试**

```powershell
node --test apps/api/test/sms-registration-routes.test.js apps/api/test/sms-registration.test.js apps/api/test/sms-login.test.js apps/api/test/password-reset.test.js apps/api/test/organization-credentials.test.js
```

Expected: PASS；注册 request 不枚举账号；管理员无注册入口但可登录、可重置。

- [ ] **Step 7: 提交**

```powershell
git add apps/api/src/routes/sms-registration.js apps/api/src/server.js apps/api/test/sms-registration-routes.test.js apps/api/test/sms-login.test.js apps/api/test/password-reset.test.js
git commit -m "feat(api): expose verified sms registration flow"
```

---

### Task 5: 在个人和组织注册界面加入短信验证

**Files:**
- Create: `apps/admin/src/components/RegistrationPhoneVerification.vue`
- Create: `apps/admin/src/components/__tests__/RegistrationPhoneVerification.test.js`
- Modify: `apps/admin/src/components/OrdinaryRegistrationForm.vue`
- Modify: `apps/admin/src/components/OrganizationRegistrationForm.vue`
- Modify: `apps/admin/src/pages/AuthPage.vue`
- Modify: `apps/admin/src/components/__tests__/OrdinaryRegistrationForm.test.js`
- Modify: `apps/admin/src/components/__tests__/OrganizationRegistrationForm.test.js`
- Modify: `apps/admin/src/pages/__tests__/AuthPage.test.js`
- Modify: `apps/admin/src/styles.css`

**Interfaces:**
- Consumes: `smsRegistrationEnabled`、注册短信 request/confirm API、`AliyunCaptchaGate`。
- Produces: `v-model:phone` 和 `v-model:phone-verification-token`。
- Emits: `verified`、`invalidated`、`error`。
- Produces: 两类正式注册提交字段 `phoneVerificationToken`。

- [ ] **Step 1: 写共享组件交互失败测试**

挂载组件并模拟 API，覆盖：

```js
await wrapper.get('[data-testid="registration-sms-request"]').trigger("click");
await wrapper.get('[data-testid="registration-sms-code"]').setValue("123456");
await wrapper.get('[data-testid="registration-sms-confirm"]').trigger("click");
```

断言：发送时传手机号和 captcha 参数；成功后显示“手机号已验证”、锁定手机号并 emit token；60 秒内禁止重复发送；点击“修改手机号”清空验证码和 token；父组件改变手机号也必须 emit `invalidated`。

- [ ] **Step 2: 写不持久化和失败关闭测试**

断言组件不调用 `localStorage`、`sessionStorage` 或 cookie；刷新/重新挂载时 token 为空。`smsRegistrationEnabled === false` 时不渲染不可用的短信输入表单，只在注册页显示简短的“注册暂不可用”说明，注册提交保持禁用。

- [ ] **Step 3: 写两类表单提交失败测试**

个人注册 JSON 断言：

```js
expect(body.phoneVerificationToken).toBe("signed-registration-token");
```

组织注册 FormData 断言：

```js
expect(formData.get("phoneVerificationToken")).toBe("signed-registration-token");
```

缺 token 时两者都不得发起注册请求。组织资料补交 `resubmission === true` 继续走既有身份会话，不要求重新短信验证。

- [ ] **Step 4: 运行测试并确认失败**

```powershell
npm run test -w apps/admin -- RegistrationPhoneVerification OrdinaryRegistrationForm OrganizationRegistrationForm AuthPage
```

Expected: FAIL，共享组件和 token 字段尚不存在。

- [ ] **Step 5: 实现共享注册验证组件**

组件只在 Vue 内存保存：

```js
const code = ref("");
const secondsRemaining = ref(0);
const verifiedPhone = ref("");
const phoneVerificationToken = ref("");
```

请求短信时经 `AliyunCaptchaGate` 获得 `captchaVerifyParam`，成功后开始 60 秒倒计时。确认成功设置 token 和已验证手机号；手机号编辑、组件卸载和“修改手机号”均清空 token。不得打印 API 响应或 token。

- [ ] **Step 6: 接入个人与组织注册表单**

两个表单共同满足：

```js
const canSubmit = computed(() =>
  props.smsRegistrationEnabled && Boolean(phoneVerificationToken.value)
);
```

注册错误若为手机号凭证过期，清空 token 并提示重新验证。注册成功后沿用当前成功页面，不创建会话、不自动登录。

- [ ] **Step 7: 从 AuthPage 传递功能开关并补充样式**

公共配置读取 `smsRegistrationEnabled`，同时传给两类注册组件。`AuthPage` 回归测试还要证明 `smsRegistrationEnabled`、`smsLoginEnabled`、`smsPasswordResetEnabled` 独立控制三个界面；管理员短信登录/重置继续可用；密码登录和邮箱找回入口始终保留。验证码输入、倒计时、已验证状态和移动端布局复用现有认证配色与可访问性样式；按钮有明确 disabled 和 loading 状态。

- [ ] **Step 8: 运行管理端测试与构建**

```powershell
npm run test -w apps/admin
npm run build -w apps/admin
```

Expected: PASS；构建产物无 token/AccessKey；密码登录和已有短信登录/重置测试仍通过。

- [ ] **Step 9: 提交**

```powershell
git add apps/admin/src/components apps/admin/src/pages/AuthPage.vue apps/admin/src/pages/__tests__/AuthPage.test.js apps/admin/src/styles.css
git commit -m "feat(admin): verify phones during account registration"
```

---

### Task 6: 完成回归、配置检查和运维手册

**Files:**
- Create: `docs/operations/sms-auth.md`
- Modify: `deploy/verify-release.sh`
- Modify: `deploy/remote-smoke-test.sh`
- Modify: `apps/api/test/deployment-paths.test.js`

**Interfaces:**
- Produces: 可重复执行的三用途配置检查、关闭状态 smoke 和上线/回滚手册。
- Preserves: 不触发真实短信的默认 CI 与本地测试路径。

- [ ] **Step 1: 写部署检查失败测试**

`deployment-paths.test.js` 断言：

- `.env.example`、Compose 和检查脚本都有三个独立模板变量。
- 部署脚本不包含旧服务器 IP `47.99.181.222` 或旧 SSH 别名 `aerogp` 作为当前目标。
- 脚本不包含 `docker compose down -v`、AccessKey 字面量或通用模板自动回退。
- `remote-smoke-test.sh` 在任一短信功能启用时只核对 feature flag，不请求验证码；仅在该功能关闭时断言 request 返回 503。

- [ ] **Step 2: 扩展关闭状态 smoke**

未配置模板的测试环境依次请求：

```text
/api/auth/register/sms/request
/api/auth/sms-login/request
/api/auth/password-reset/sms/request
```

三个端点都应稳定返回 503 功能未启用，不调用供应商；密码登录和邮箱重置健康检查仍成功。

`remote-smoke-test.sh` 中现有组织公开注册 fixture 必须携带真实格式 token，但不得发送短信。增加 helper，在 API 容器内部导入 `createPhoneRegistrationToken`，用容器已有 `SESSION_SECRET` 为本次随机测试手机号签发 15 分钟 token，写入权限 600 的临时文件并随 multipart 提交；helper 不回显 secret 或 token，脚本退出时删除文件。这是服务器运维 smoke，不新增 HTTP 后门，且仍验证正式注册路由的 token 强制校验。

`verify-release.sh` 增加三个必填布尔期望值：

```sh
EXPECTED_SMS_REGISTRATION_ENABLED=false
EXPECTED_SMS_LOGIN_ENABLED=false
EXPECTED_SMS_PASSWORD_RESET_ENABLED=false
```

脚本严格核对 `/api/public/features`。生产启用阶段改传 `true`；这些变量只表达预期状态，绝不触发短信发送。

- [ ] **Step 3: 编写运维手册**

`docs/operations/sms-auth.md` 必须包含：

- 三个模板变量与用途映射，明确禁止使用旧通用模板兜底。
- RAM 最小权限、`.env` 权限 600、密钥轮换与泄露处置。
- 配置前置条件、启用顺序、功能关闭行为、监控指标、阿里云发送记录核对。
- 注册/登录/重置的冒烟矩阵，普通、组织负责人和管理员资格边界。
- 单用途紧急关闭：清空对应模板变量后仅重建 API 容器。
- 严禁输出验证码、完整手机号、token 和 AccessKey。

- [ ] **Step 4: 执行全量自动验证**

```powershell
npm run test -w apps/api
npm run test -w apps/admin
npm run test -w apps/web -- --run
npm run build -w apps/admin
npm run build -w apps/web
$env:POSTGRES_PASSWORD = "config-check-only"
$env:SESSION_SECRET = "config-check-session-secret-32-chars"
$env:REGISTRATION_ID_ENCRYPTION_KEY = "config-check-registration-key-32"
$env:RELEASE_SHA = "0000000000000000000000000000000000000000"
docker compose config --quiet
powershell -ExecutionPolicy Bypass -File deploy/verify-config.ps1
```

在已启动的隔离 Compose 测试栈中另运行：

```sh
EXPECTED_RELEASE=0000000000000000000000000000000000000000 \
EXPECTED_SMS_REGISTRATION_ENABLED=false \
EXPECTED_SMS_LOGIN_ENABLED=false \
EXPECTED_SMS_PASSWORD_RESET_ENABLED=false \
BASE_URL=http://127.0.0.1 sh deploy/verify-release.sh
BASE_URL=http://127.0.0.1 sh deploy/remote-smoke-test.sh
```

Expected: 全部 PASS。若仓库脚本名或 workspace 命令发生变化，先按实际 `package.json` 更新本计划命令及运维文档，再运行等价全量验证。

- [ ] **Step 5: 执行敏感信息扫描**

```powershell
rg -l -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!.git/**' "LTAI[A-Za-z0-9]+|ALIBABA_CLOUD_ACCESS_KEY_(ID|SECRET)=.+|SMS_[0-9]{8,}" .
```

Expected: 命令只输出文件名，不输出匹配行。只允许 `.env.example` 的空变量名、测试假值，以及设计/运维文档明确记录的非秘密历史模板号；任何包含真实 AccessKey、Secret 或意外模板号的文件必须先安全移除，并轮换暴露凭据。

- [ ] **Step 6: 请求代码审查并处理发现**

按照 `superpowers:requesting-code-review` 对照本计划和设计文档审查：资格矩阵、旧入口删除、purpose 隔离、注册 token 生命周期、日志脱敏、失败关闭和回滚。修复发现后重跑受影响测试与全量验证。

- [ ] **Step 7: 提交**

```powershell
git add docs/operations/sms-auth.md deploy/verify-release.sh deploy/remote-smoke-test.sh apps/api/test/deployment-paths.test.js
git commit -m "docs(ops): document sms authentication rollout"
```

---

### Task 7: 先发布短信保持关闭的代码版本

**External state:** `server115:/opt/aerogp`、生产 PostgreSQL 和 uploads 命名卷。

**Interfaces:**
- Consumes: 已审查且工作区干净的 Git commit。
- Produces: 三个短信功能均为关闭状态的新代码版本和可验证回滚点。
- Preserves: 当前 `.env`、数据库、uploads、Caddy 数据和上一 release。

- [ ] **Step 1: 做只读生产前检查**

```powershell
ssh server115 "hostname; cd /opt/aerogp && docker compose ps"
ssh server115 "cd /opt/aerogp && docker compose exec -T api node -v"
```

核对 SSH 配置解析到 `115.29.206.107`，并检查磁盘空间、容器健康、restart count、当前 release 标识、数据库和上传卷存在。命令不得读取或输出 `.env` 内容。

- [ ] **Step 2: 创建并验证可恢复备份**

使用仓库现有脚本：

```sh
sh deploy/backup-postgres.sh
sh deploy/backup-uploads.sh
sh deploy/verify-backup.sh
sh deploy/verify-uploads-backup.sh
```

若脚本需要既有参数，按服务器当前运维约定注入。备份放在 `/opt/aerogp/backups` 下的明确时间戳目录，另保存当前 release/Compose/Caddy 文件；检查非空和 SHA256。不得下载 `.env`，不得删除旧备份。

- [ ] **Step 3: 确认待发布 commit 精确且工作区干净**

```powershell
git status --short
git rev-parse HEAD
git log -1 --oneline
```

使用 `superpowers:verification-before-completion` 复核全量测试结果。工作区非空、commit 未经过审查或测试结果过期时停止发布。

- [ ] **Step 4: 打包并校验精确 commit**

用 `git archive <reviewed-sha>` 生成 release 压缩包，计算 SHA256，通过 `scp` 传到 `server115` 的单个临时 release 路径，服务器重新计算并核对 SHA256。禁止用 `scp -r` 覆盖 `/opt/aerogp`，禁止把本机 `.env` 或未跟踪文件加入包。

- [ ] **Step 5: 确认第一阶段短信保持关闭**

在不显示值的检查中，确认运行时尚未同时具备 AccessKey、签名和三个新模板 Code。若生产 `.env` 已含任何可启用组合，先停止并向用户确认，不擅自清空或覆盖。第一阶段目标是：

```text
smsRegistrationEnabled=false
smsLoginEnabled=false
smsPasswordResetEnabled=false
```

- [ ] **Step 6: 切换新 release 并构建服务**

解压到新的 release 目录，以项目既有原子切换机制指向该目录，同时复用 `/opt/aerogp/.env`、`backups` 和命名卷。运行：

```sh
docker compose config --quiet
docker compose build api web
docker compose up -d api web caddy
```

等待 API、Web 和 Caddy 健康；核对数据库迁移和容器 restart count。失败时切回上一 release 并 `docker compose up -d`，不得执行 `down -v`。

- [ ] **Step 7: 验证关闭状态版本**

```sh
EXPECTED_RELEASE=<deployed-40-char-sha> \
EXPECTED_SMS_REGISTRATION_ENABLED=false \
EXPECTED_SMS_LOGIN_ENABLED=false \
EXPECTED_SMS_PASSWORD_RESET_ENABLED=false \
BASE_URL=https://aerogp.cn sh deploy/verify-release.sh

BASE_URL=https://aerogp.cn sh deploy/remote-smoke-test.sh
```

确认三个验证码 request 端点返回 503 且没有供应商发送记录；密码登录、邮箱找回、管理端、个人/组织注册失败关闭说明及既有业务 smoke 通过。完成此阶段后再进入阿里云资源配置。

---

### Task 8: 配置阿里云短信模板与最小权限 RAM 身份

**External state:** 阿里云短信控制台、RAM 控制台、`server115:/opt/aerogp/.env`。

**Interfaces:**
- Produces: 注册、登录、重置三个独立审核通过的模板 Code。
- Produces: 仅允许 `dysms:SendSms` 的程序访问 RAM 用户。
- Produces: 仅在服务器 root-only `.env` 中存在的短信 AccessKey。

- [ ] **Step 1: 只读复核当前阿里云资源**

通过用户已登录的 Chrome 会话核对签名 `温州市少航科创中心` 状态、现有模板、套餐余量和运营商报备状态。记录非秘密信息，不复制浏览器中可能出现的凭据，不改动资源。

- [ ] **Step 2: 填写三个模板草稿但不提交**

分别填写：

```text
注册：您正在注册航空航天创新比赛平台账号，验证码为${code}，5分钟内有效，请勿泄露。
登录：您正在登录航空航天创新比赛平台，验证码为${code}，5分钟内有效，若非本人操作请忽略。
重置：您正在重置航空航天创新比赛平台账号密码，验证码为${code}，5分钟内有效，若非本人操作请忽略。
```

模板变量只允许 `${code}`，类型选择验证码，签名选择现有已通过签名。旧通用模板 `SMS_337755325` 保留但不作为代码回退。

- [ ] **Step 3: 在每次提交审核前向用户确认**

明确展示即将提交的三个模板名称、内容、签名和预计资源影响。只有收到此次操作的明确确认后，才点击提交；确认不能由早先的总体“允许/确认”替代。

- [ ] **Step 4: 等待并核对审核结果**

三个模板必须均为“审核通过”后才能继续生产启用。任何驳回只修订对应模板并再次在提交前确认，不使用通用模板临时替代。

- [ ] **Step 5: 准备 RAM 最小权限策略**

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

用户命名建议 `aerogp-sms-sender`，禁止控制台登录，不授予 `AliyunDysmsFullAccess` 或其他产品权限。

- [ ] **Step 6: 创建 AccessKey 前向用户确认**

说明将创建一组新的长期凭据、只能显示/下载 Secret 一次，以及保存目标 `/opt/aerogp/.env`。收到操作时确认后才创建；不得将值发到聊天、终端回显、Git 或本地明文文件。

- [ ] **Step 7: 写入服务器前再次确认并安全配置**

收到把密钥传输到 `server115` 的明确确认后，通过不回显的安全输入写入 `/opt/aerogp/.env`，同时设置：

```dotenv
ALIBABA_CLOUD_ACCESS_KEY_ID=<new RAM access key id>
ALIBABA_CLOUD_ACCESS_KEY_SECRET=<new RAM access key secret>
ALIYUN_SMS_SIGN_NAME=温州市少航科创中心
ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE=<approved registration code>
ALIYUN_SMS_LOGIN_TEMPLATE_CODE=<approved login code>
ALIYUN_SMS_RESET_TEMPLATE_CODE=<approved reset code>
```

将文件权限设为 600，只核对变量是否非空和权限位，不输出值。若 Secret 曾在日志或聊天中出现，立即禁用并重新创建。

- [ ] **Step 8: 做权限负向验证**

在不发送短信的前提下确认 RAM 身份只有 `dysms:SendSms`，无模板编辑、签名编辑、RAM、ECS、OSS 或数据库权限。保存策略名称和审核通过模板 Code 作为非秘密发布记录。

---

### Task 9: 启用生产短信并验证真实闭环

**External state:** `server115`、`https://aerogp.cn`、阿里云短信发送记录。

**Files:**
- Create after deployment: `docs/deployment/aliyun-test.md`

**Interfaces:**
- Consumes: Task 7 已发布的关闭状态代码、三个审核通过模板、最小权限 RAM 凭据。
- Produces: 可回滚的短信启用、非秘密测试证据和三用途闭环结果。

- [ ] **Step 1: 做只读生产前检查**

```powershell
ssh server115 "cd /opt/aerogp && docker compose ps"
ssh server115 "cd /opt/aerogp && docker compose exec -T api node -v"
```

核对主机为 `115.29.206.107`、磁盘空间、容器健康、当前 release 与 Task 7 的审核 commit 完全一致、数据库和上传卷存在。确认 `.env` 权限为 600，并用“存在/为空”的布尔检查核对六个必填短信变量（AccessKey 两项、签名、三个模板）及可选注册 captcha scene，不输出值。

- [ ] **Step 2: 创建可恢复备份并验证**

在启用前再生成一份 PostgreSQL 和 uploads 时间戳备份；检查文件非空并记录 SHA256。保留 Task 7 的关闭状态 release 作为立即回滚点，不得把 `.env` 打包到本地或聊天，不得删除旧备份。

- [ ] **Step 3: 安全解析新配置但不打印 Secret**

在 `server115:/opt/aerogp` 运行：

```sh
docker compose config --quiet
```

再用只输出变量名和布尔状态的检查确认三个模板、签名、AccessKey ID/Secret 均非空，且容器尚未重建、公开 feature 仍是三个 `false`。任何配置错误先修正 `.env`，不启动服务。

- [ ] **Step 4: 重建 API 以启用短信并等待健康**

代码和 Web 镜像保持 Task 7 版本，只让 API 容器重新读取 `.env`：

```sh
docker compose up -d --no-deps --force-recreate api
```

循环检查 API health、容器 restart count 和反向代理响应。失败立即停止后续真实短信测试，恢复 `.env` 的关闭状态副本并重建 API；不切换代码、不触碰数据卷。

- [ ] **Step 5: 执行发布和远程非短信 smoke**

```sh
EXPECTED_RELEASE=<deployed-40-char-sha> \
EXPECTED_SMS_REGISTRATION_ENABLED=true \
EXPECTED_SMS_LOGIN_ENABLED=true \
EXPECTED_SMS_PASSWORD_RESET_ENABLED=true \
BASE_URL=https://aerogp.cn sh deploy/verify-release.sh

BASE_URL=https://aerogp.cn sh deploy/remote-smoke-test.sh
```

以上命令在 `server115:/opt/aerogp` 中执行，管理端 smoke 凭据沿用服务器现有的非回显注入方式。核对首页、管理端、密码登录、公共配置和注册页面；确认 `smsRegistrationEnabled`、短信登录和短信重置开关符合生产配置；确认管理员仍无注册入口。启用状态的 remote smoke 不调用三个验证码 request 端点。

- [ ] **Step 6: 发送真实短信前向用户请求操作时确认**

确认信息必须列明：掩码手机号、测试账号角色、要测试的 purpose、预计发送条数和可能产生的短信费用。最低供应商连通性是三个用途各 1 条；若要完成普通用户、组织负责人和管理员的完整生产角色矩阵，预计最多 8 条（注册 2、登录 3、重置 3）。执行时只发送用户此次确认的号码、用途和条数；未经确认不得点击发送、调用 API 或继续自动发送。

- [ ] **Step 7: 验证注册闭环**

在确认后的测试手机号上：请求注册验证码、由用户提供收到的验证码、确认后获得内存 token、完成个人注册并验证没有自动登录。再验证重复手机号被统一拒绝、刷新后 token 丢失、旧 `/api/auth/register` 为 404。组织注册使用另一个未注册手机号或在明确同意后清理专用测试数据，验证提交后处于待审核状态。

- [ ] **Step 8: 验证登录和密码重置闭环**

对经过用户明确指定的测试账号覆盖：

- 普通用户短信登录和短信重置。
- 已审核、启用组织负责人短信登录；待审核/被拒绝负责人不能短信登录但可重置。
- 启用管理员短信登录和短信重置；管理员注册入口不存在。
- 重置后旧会话失效；密码登录、邮箱找回、管理员重置仍可用。

每次新增短信发送仍受 Step 6 确认的手机号、purpose 和条数范围限制，超出范围必须再次确认。

- [ ] **Step 9: 核对阿里云记录和运营商可达性**

在发送记录中按掩码号码和时间核对三模板 Code、成功状态与计费条数，不复制短信正文、完整手机号或验证码。若移动/联通/电信任一报备仍待验证，只记录风险并使用用户授权的真实号码验证；不得为了凑覆盖向未知号码发送。

- [ ] **Step 10: 记录非秘密发布证据**

`docs/deployment/aliyun-test.md` 只记录：部署 commit、时间、模板 Code、测试角色/purpose、掩码手机号、HTTP/供应商结果、备份位置标识和回滚结论。不得记录 AccessKey、验证码、完整手机号、注册 token 或 session cookie。

```powershell
git add docs/deployment/aliyun-test.md
git commit -m "docs(deploy): record aliyun sms production verification"
```

- [ ] **Step 11: 验证单用途回滚**

先在隔离测试栈验证单用途回滚。若必须在生产演练，需再次向用户说明将短暂关闭的用途和时间窗口并取得操作时确认。紧急关闭某用途时只清空对应模板变量并重建 API：

```sh
docker compose up -d --no-deps --force-recreate api
```

确认该用途 request 返回 503，另外两个短信用途和密码/邮箱通道保持可用。整版回滚切回上一 release 并 `docker compose up -d`；禁止 `down -v`。

---

## Final Acceptance Checklist

- [ ] 两类公开注册均无法绕过手机号验证，旧 `/api/auth/register` 返回 404。
- [ ] 注册验证码确认签发绑定手机号、purpose 和 15 分钟过期时间的 HMAC token。
- [ ] token 只在页面内存，手机号变化、刷新和注册失败过期场景均会清除。
- [ ] 管理员无公开注册，但启用管理员可短信登录、短信重置。
- [ ] 组织负责人登录资格与审核/启用状态一致，密码重置资格不被待审核/拒绝状态误挡。
- [ ] 三个 purpose、模板 Code、功能开关和 captcha scene 相互独立，验证码不可跨用途消费。
- [ ] 6 位验证码、5 分钟、5 次尝试、60 秒冷却、5/小时/手机号和 20/小时/IP 均有自动测试。
- [ ] 密码登录、邮箱找回和管理员后台重置全部回归通过。
- [ ] AccessKey 只存在于 `server115:/opt/aerogp/.env`，权限 600，RAM 仅有 `dysms:SendSms`。
- [ ] 默认测试和 smoke 不发送真实短信；每次真实发送都经过操作时确认并限制号码、用途和条数。
- [ ] 全量测试、前端构建、Compose/config/release 检查和生产健康检查通过。
- [ ] 数据库、uploads 和上一 release 有已验证备份，回滚演练不触碰命名卷。
- [ ] 日志、Git、构建产物和发布记录不含 Secret、验证码、完整手机号、token 或 cookie。

## Official References

- [阿里云短信服务：验证码模板规范](https://help.aliyun.com/zh/sms/user-guide/verification-code-template-specifications)
- [阿里云短信服务：签名规范](https://help.aliyun.com/zh/sms/user-guide/signature-specifications-1)
- [阿里云短信服务：身份管理](https://help.aliyun.com/zh/sms/identity-management)
- [阿里云短信服务：仅发送短信的最小权限策略](https://help.aliyun.com/zh/sms/custom-permission-policy-reference)
- [阿里云 RAM：创建自定义权限策略](https://help.aliyun.com/zh/ram/create-a-custom-policy)
- [阿里云短信服务：验证码防盗刷](https://help.aliyun.com/zh/sms/user-guide/verification-code-scams-and-message-flooding-1)
