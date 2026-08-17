# 邮箱密码找回 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为个人用户、组织负责人和平台管理员增加已验证邮箱绑定，并通过阿里云 DirectMail 的一次性链接安全重置密码，同时保留现有短信验证码找回。

**Architecture:** 手机号继续作为唯一登录名。主数据存储增加用户邮箱字段和统一的账号邮件令牌记录；独立邮件服务负责 DirectMail SMTP 投递，独立账号邮箱服务负责绑定、换绑、令牌生命周期、限流和密码重置。管理端把现有修改密码页升级为账号安全页，并在公开登录流程中增加邮箱链接找回和令牌重置页面。

**Tech Stack:** Node.js 22、Express 4、PostgreSQL、文件型测试存储、Nodemailer、Vue 3、Vite、Vitest、Node test runner、阿里云 DirectMail SMTP。

## Global Constraints

- 登录账号仍为手机号，不实现邮箱登录。
- 邮箱找回使用一次性链接，不使用邮箱验证码；现有短信验证码找回保持可用。
- 邮箱验证链接有效期 30 分钟；密码重置链接有效期 10 分钟且只能使用一次。
- 同一邮箱每小时最多 5 次，同一 IP 每小时最多 20 次，连续请求冷却 60 秒。
- 未绑定邮箱的老账号必须继续正常登录、修改密码和使用短信找回。
- 数据库只保存令牌摘要，绝不保存原始令牌、明文密码或可用于重置的完整链接。
- 重置成功后递增 `sessionVersion`，清除临时密码状态并使旧会话全部失效。
- 公开申请接口使用统一响应，不泄露邮箱是否存在、是否验证或账号是否启用。
- 阿里云凭据和 SMTP 密码只通过服务器环境变量提供，不进入 Git、日志或前端构建产物。
- 平台管理员只能查看邮箱绑定与验证状态，不能查看用户密码、令牌或重置链接。

---

## 文件结构

- `apps/api/src/auth/account-email.js`：邮箱规范化、令牌生成与摘要、绑定/换绑/重置领域服务。
- `apps/api/src/auth/email-provider.js`：阿里云 DirectMail SMTP 适配器及邮件模板。
- `apps/api/src/data/account-email-tokens.js`：文件与 PostgreSQL 令牌仓储统一接口。
- `apps/api/src/data/migrations/017-account-email-recovery.sql`：生产数据库迁移。
- `apps/api/src/routes/account-security.js`：账号邮箱与邮箱找回 HTTP 路由。
- `apps/admin/src/pages/PasswordSettingsPage.vue`：升级为账号安全页，保留强制改密模式。
- `apps/admin/src/pages/AuthPage.vue`：手机/邮箱找回方式选择。
- `apps/admin/src/pages/EmailLinkPage.vue`：邮箱验证和密码重置链接落地页。
- `apps/api/test/account-email.test.js`、`apps/api/test/account-email-routes.test.js`：后端领域与端到端测试。
- `apps/admin/src/pages/__tests__/PasswordSettingsPage.test.js`、`AuthPage.test.js`、`EmailLinkPage.test.js`：前端行为测试。

### Task 1: 数据模型与双存储兼容

**Files:**
- Create: `apps/api/src/data/migrations/017-account-email-recovery.sql`
- Modify: `apps/api/src/data/schema.sql`
- Modify: `apps/api/src/data/seed.js`
- Modify: `apps/api/src/data/postgres-store.js`
- Modify: `apps/api/src/data/file-store.js`
- Test: `apps/api/test/postgres-store.test.js`
- Test: `apps/api/test/data-store.test.js`

**Interfaces:**
- Produces user fields: `email: string | null`, `emailVerifiedAt: string | null`, `emailUpdatedAt: string | null`.
- Produces `db.accountEmailTokens: Array<{ id, userId, purpose, targetEmail, digest, expiresAt, usedAt, requestIp, createdAt }>`.
- `purpose` is exactly `verify_email` or `reset_password`.

- [ ] **Step 1: Write failing storage tests**

Add a round-trip assertion to both stores:

```js
db.users[0].email = "owner@example.com";
db.users[0].emailVerifiedAt = "2026-08-17T10:00:00.000Z";
db.users[0].emailUpdatedAt = "2026-08-17T10:00:00.000Z";
db.accountEmailTokens = [{
  id: "ET1", userId: db.users[0].id, purpose: "reset_password",
  targetEmail: "owner@example.com", digest: "a".repeat(64),
  expiresAt: "2026-08-17T10:10:00.000Z", usedAt: null,
  requestIp: "127.0.0.1", createdAt: "2026-08-17T10:00:00.000Z"
}];
await store.write(db);
const restored = await store.read();
assert.equal(restored.users[0].email, "owner@example.com");
assert.deepEqual(restored.accountEmailTokens, db.accountEmailTokens);
```

- [ ] **Step 2: Run storage tests and verify failure**

Run: `npm test -w apps/api -- test/data-store.test.js test/postgres-store.test.js`

Expected: FAIL because email columns and `account_email_tokens` mapping do not exist.

- [ ] **Step 3: Add schema and migration**

Use this SQL shape in both schema and migration:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_updated_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
  ON users (LOWER(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_email_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  target_email TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  request_ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS account_email_tokens_user_purpose_idx
  ON account_email_tokens(user_id, purpose, expires_at DESC);
```

Map camelCase fields in `postgres-store.js`, initialize `accountEmailTokens ||= []` in file/seed normalization, and include the new fields in every users INSERT/UPDATE path, including bootstrap and registration paths discovered by `rg "sessionVersion: 0" apps/api/src`.

- [ ] **Step 4: Run storage and migration safety tests**

Run: `npm test -w apps/api -- test/data-store.test.js test/postgres-store.test.js test/deployment.test.js`

Expected: PASS; a legacy user without email returns the three new fields as `null`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/data apps/api/test/data-store.test.js apps/api/test/postgres-store.test.js
git commit -m "feat: persist verified account emails"
```

### Task 2: 一次性令牌仓储与并发语义

**Files:**
- Create: `apps/api/src/data/account-email-tokens.js`
- Create: `apps/api/test/account-email-token-store.test.js`

**Interfaces:**
- Produces `createAccountEmailTokenStore({ readDb, writeDb, pool, withMutationLock })`.
- Produces methods `replace({ userId, purpose, targetEmail, digest, expiresAt, requestIp, createdAt }): Promise<void>`, `inspect({ digest, purpose, now }): Promise<Token|null>`, `consume({ digest, purpose, now }): Promise<Token|null>`, and `revokeUserPurpose(userId, purpose): Promise<void>`.

- [ ] **Step 1: Write failing token-store tests**

Cover replacement, expiry, purpose separation and atomic one-time consumption:

```js
await store.replace({ userId: "U1", purpose: "reset_password", targetEmail: "a@example.com", digest: "d1", expiresAt: now + 600000, requestIp: "ip", createdAt: now });
await store.replace({ userId: "U1", purpose: "reset_password", targetEmail: "a@example.com", digest: "d2", expiresAt: now + 600000, requestIp: "ip", createdAt: now });
assert.equal(await store.inspect({ digest: "d1", purpose: "reset_password", now }), null);
assert.equal((await store.consume({ digest: "d2", purpose: "reset_password", now })).userId, "U1");
assert.equal(await store.consume({ digest: "d2", purpose: "reset_password", now }), null);
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -w apps/api -- test/account-email-token-store.test.js`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement file and PostgreSQL token operations**

For PostgreSQL, `consume` must use one atomic statement:

```sql
UPDATE account_email_tokens
SET used_at = $3
WHERE digest = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3
RETURNING *;
```

For file storage, wrap read/check/write in the existing `withMutationLock`. `replace` revokes all unused tokens for the same `userId + purpose` before inserting a cryptographically independent record ID.

- [ ] **Step 4: Run token-store tests**

Run: `npm test -w apps/api -- test/account-email-token-store.test.js`

Expected: PASS for both file and pg-mem-backed implementations.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/data/account-email-tokens.js apps/api/test/account-email-token-store.test.js
git commit -m "feat: add one-time account email token store"
```

### Task 3: DirectMail 邮件适配器与模板

**Files:**
- Create: `apps/api/src/auth/email-provider.js`
- Create: `apps/api/test/email-provider.test.js`
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`

**Interfaces:**
- Produces `createEmailProvider(env, { transportFactory } = {})` returning `null` when configuration is incomplete.
- Provider methods: `sendVerification({ to, verifyUrl, expiresMinutes })`, `sendPasswordReset({ to, resetUrl, expiresMinutes })`, `sendSecurityNotice({ to, kind })`.
- Required env: `DIRECTMAIL_SMTP_HOST=smtpdm.aliyun.com`, `DIRECTMAIL_SMTP_PORT=465`, `DIRECTMAIL_SMTP_USER`, `DIRECTMAIL_SMTP_PASSWORD`, `DIRECTMAIL_FROM`, `PUBLIC_APP_URL=https://aerogp.cn`.

- [ ] **Step 1: Write failing provider tests**

Inject a fake transport and assert envelope and safe HTML:

```js
await provider.sendPasswordReset({
  to: "user@example.com",
  resetUrl: "https://aerogp.cn/admin/?view=resetPassword&token=abc",
  expiresMinutes: 10
});
assert.equal(sent[0].from, "温州市青少年航空航天创新比赛 <no-reply@mail.aerogp.cn>");
assert.equal(sent[0].to, "user@example.com");
assert.match(sent[0].html, /10 分钟/);
assert.match(sent[0].html, /view=resetPassword/);
```

Also assert that logs/errors never contain the SMTP password or reset token.

- [ ] **Step 2: Run test and verify failure**

Run: `npm test -w apps/api -- test/email-provider.test.js`

Expected: FAIL because the provider module and Nodemailer dependency are absent.

- [ ] **Step 3: Install Nodemailer and implement provider**

Run: `npm install -w apps/api nodemailer`

Use `nodemailer.createTransport({ host, port: Number(port), secure: Number(port) === 465, auth: { user, pass } })`. Keep templates local and escape all interpolated values. Convert provider errors to `EMAIL_DELIVERY_FAILED` without returning vendor messages to clients.

- [ ] **Step 4: Run provider tests**

Run: `npm test -w apps/api -- test/email-provider.test.js`

Expected: PASS without any network call.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/email-provider.js apps/api/test/email-provider.test.js apps/api/package.json package-lock.json .env.example
git commit -m "feat: add DirectMail email provider"
```

### Task 4: 邮箱绑定、换绑与密码重置领域服务

**Files:**
- Create: `apps/api/src/auth/account-email.js`
- Create: `apps/api/test/account-email.test.js`
- Modify: `apps/api/src/services/audit.js`

**Interfaces:**
- Produces `normalizeEmail(value): string`.
- Produces `createAccountEmailService({ readDb, writeDb, withMutationLock, tokenStore, authState, emailProvider, secret, publicAppUrl, clock, randomBytes })`.
- Service methods: `requestVerification({ userId, currentPassword, email, ip })`, `confirmVerification({ token })`, `requestPasswordReset({ email, ip })`, `inspectPasswordReset({ token })`, `confirmPasswordReset({ token, password })`.
- Public request response is exactly `{ ok: true, message: "如果该邮箱已绑定并完成验证，重置邮件将在几分钟内发送，请同时检查垃圾邮件目录。" }`.

- [ ] **Step 1: Write failing domain tests**

Test normalization, uniqueness, current-password requirement, 30/10-minute expiry, digest-only persistence, uniform unknown-email response, replacement, one-time consumption, session invalidation, temporary-password cleanup and send-failure revocation.

Representative assertion:

```js
const result = await service.requestPasswordReset({ email: " USER@Example.COM ", ip: "127.0.0.1" });
assert.deepEqual(result, UNIFORM_EMAIL_RESET_RESPONSE);
assert.equal(sent[0].to, "user@example.com");
assert.equal(JSON.stringify(db()).includes(sent[0].rawToken), false);
await service.confirmPasswordReset({ token: sent[0].rawToken, password: "NextPass2" });
assert.equal(db().users[0].sessionVersion, 4);
assert.equal(await service.inspectPasswordReset({ token: sent[0].rawToken }), null);
```

- [ ] **Step 2: Run domain tests and verify failure**

Run: `npm test -w apps/api -- test/account-email.test.js`

Expected: FAIL with missing exported service.

- [ ] **Step 3: Implement minimal service**

Generate 32 random bytes, encode base64url, and persist `createHmac("sha256", secret).update(`${purpose}:${token}`).digest("hex")`. Reuse `validatePassword`, `verifyPassword`, `hashPassword`, `clearUserTemporaryPassword`, `authState.consumeRateLimits`, and existing audit conventions. Perform email uniqueness and password mutation inside `withMutationLock`.

- [ ] **Step 4: Run domain and existing SMS tests**

Run: `npm test -w apps/api -- test/account-email.test.js test/password-reset.test.js`

Expected: PASS; existing SMS responses and limits remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/account-email.js apps/api/src/services/audit.js apps/api/test/account-email.test.js
git commit -m "feat: implement verified email recovery service"
```

### Task 5: HTTP 路由、会话 DTO 与管理员可见状态

**Files:**
- Create: `apps/api/src/routes/account-security.js`
- Create: `apps/api/test/account-email-routes.test.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/test/admin-users.test.js`

**Interfaces:**
- Adds `POST /api/auth/email/verification/request` (authenticated).
- Adds `POST /api/auth/email/verification/resend` (authenticated).
- Adds `GET /api/auth/email/verification/confirm?token=...` (public).
- Adds `POST /api/auth/password-reset/email/request` (public).
- Adds `GET /api/auth/password-reset/email/verify?token=...` (public).
- Adds `POST /api/auth/password-reset/email/confirm` (public).
- Session/user DTO adds `email`, `emailVerified`, never `emailVerifiedAt` unless an admin list needs the timestamp.
- Public features adds `emailPasswordResetEnabled`.

- [ ] **Step 1: Write failing route tests**

Exercise all routes with a fake provider through `withTestServer` dependency injection. Assert authentication on binding, uniform public response, `422 INVALID_OR_EXPIRED_TOKEN`, successful session invalidation, and no `digest`/token leakage in `/api/auth/me` or `/api/users`.

- [ ] **Step 2: Run route tests and verify failure**

Run: `npm test -w apps/api -- test/account-email-routes.test.js test/admin-users.test.js`

Expected: FAIL with route 404 and missing DTO fields.

- [ ] **Step 3: Mount routes and wire dependencies**

Create provider and service once during server construction. Route handlers pass `req.ip`, call `sendPasswordResetError`-style typed error mapping, and return stable codes: `EMAIL_ALREADY_BOUND`, `CURRENT_PASSWORD_INVALID`, `INVALID_OR_EXPIRED_TOKEN`, `EMAIL_SERVICE_UNAVAILABLE`, `RATE_LIMITED`.

- [ ] **Step 4: Run API auth suite**

Run: `npm test -w apps/api -- test/account-email-routes.test.js test/admin-users.test.js test/auth-session.test.js test/password-reset.test.js test/authorization.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/account-security.js apps/api/src/server.js apps/api/test/account-email-routes.test.js apps/api/test/admin-users.test.js
git commit -m "feat: expose account email recovery routes"
```

### Task 6: 三类账号统一“账号安全”页面

**Files:**
- Modify: `apps/admin/src/pages/PasswordSettingsPage.vue`
- Modify: `apps/admin/src/pages/__tests__/PasswordSettingsPage.test.js`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/__tests__/App.test.js`
- Modify: `apps/admin/src/styles.css`

**Interfaces:**
- Page consumes current user `{ phone, email, emailVerified, mustChangePassword }`.
- Emits `changed(user)` after password or email state changes.
- Calls `POST /api/auth/email/verification/request` with `{ currentPassword, email }` and `POST /api/auth/email/verification/resend` with `{}`.

- [ ] **Step 1: Extend failing component tests**

Assert the page renders “账号安全”, readonly phone, unbound/pending/verified states, current-password binding form, resend action, and preserves forced-password-only mode.

```js
const wrapper = mount(PasswordSettingsPage, { props: { user: { phone: "13800000001", email: null, emailVerified: false } } });
await wrapper.get('[name="email"]').setValue("user@example.com");
await wrapper.get('[name="emailCurrentPassword"]').setValue("OldPass1");
await wrapper.get('[data-action="bind-email"]').trigger("submit");
expect(apiMock).toHaveBeenCalledWith("/api/auth/email/verification/request", expect.objectContaining({ method: "POST" }));
```

- [ ] **Step 2: Run component tests and verify failure**

Run: `npm test -w apps/admin -- src/pages/__tests__/PasswordSettingsPage.test.js src/__tests__/App.test.js`

Expected: FAIL because account email controls are absent.

- [ ] **Step 3: Implement account-security UI**

Keep existing password form logic intact. Hide email controls when `forced === true`; forced temporary-password users must change password before binding email. Use explicit status copy: “未绑定”“待验证”“已验证”。

- [ ] **Step 4: Run page and navigation tests**

Run: `npm test -w apps/admin -- src/pages/__tests__/PasswordSettingsPage.test.js src/pages/__tests__/AppNavigation.test.js src/__tests__/App.test.js`

Expected: PASS for ordinary, organization and admin routes.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/PasswordSettingsPage.vue apps/admin/src/pages/__tests__/PasswordSettingsPage.test.js apps/admin/src/App.vue apps/admin/src/__tests__/App.test.js apps/admin/src/styles.css
git commit -m "feat: upgrade password settings to account security"
```

### Task 7: 邮箱找回和链接落地页面

**Files:**
- Create: `apps/admin/src/pages/EmailLinkPage.vue`
- Create: `apps/admin/src/pages/__tests__/EmailLinkPage.test.js`
- Modify: `apps/admin/src/pages/AuthPage.vue`
- Modify: `apps/admin/src/pages/__tests__/AuthPage.test.js`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/styles.css`

**Interfaces:**
- `AuthPage` consumes feature `emailPasswordResetEnabled` and calls `/api/auth/password-reset/email/request`.
- `EmailLinkPage` prop `mode: 'verifyEmail'|'resetPassword'`, reads the URL token supplied by `App.vue`.
- Reset submission body is `{ token, password }` after local confirmation check.

- [ ] **Step 1: Write failing UI tests**

Assert “手机验证码找回 / 邮箱链接找回” tabs, uniform success copy, no account-existence disclosure, token verification loading, expired state, mismatched passwords, success redirect and mobile layout class.

- [ ] **Step 2: Run UI tests and verify failure**

Run: `npm test -w apps/admin -- src/pages/__tests__/AuthPage.test.js src/pages/__tests__/EmailLinkPage.test.js`

Expected: FAIL because email recovery tab and page do not exist.

- [ ] **Step 3: Implement routes and forms**

On startup, `App.vue` maps `view=verifyEmail` and `view=resetPassword` before requiring a session. `EmailLinkPage` first calls the GET verification endpoint; reset mode renders password inputs only when `{ valid: true }`. After success, replace URL with `/admin/` and display “密码已重置，请使用手机号和新密码登录”。

- [ ] **Step 4: Run auth UI tests and build**

Run: `npm test -w apps/admin -- src/pages/__tests__/AuthPage.test.js src/pages/__tests__/EmailLinkPage.test.js src/__tests__/App.test.js`

Run: `npm run build -w apps/admin`

Expected: all tests PASS and Vite build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/AuthPage.vue apps/admin/src/pages/EmailLinkPage.vue apps/admin/src/pages/__tests__/AuthPage.test.js apps/admin/src/pages/__tests__/EmailLinkPage.test.js apps/admin/src/App.vue apps/admin/src/styles.css
git commit -m "feat: add email link password recovery UI"
```

### Task 8: 完整验证、DirectMail 配置与生产部署

**Files:**
- Modify: `docs/deployment/aliyun-test.md`
- Create: `docs/deployment/releases/2026-08-17-email-password-recovery.md`
- Modify: deployment environment on server `/opt/aerogp/.env` (not committed)

**Interfaces:**
- Production requires all `DIRECTMAIL_*` variables and `PUBLIC_APP_URL=https://aerogp.cn`.
- Operational rollback is application rollback plus leaving nullable email columns/tables in place; migration is additive and need not be reversed.

- [ ] **Step 1: Document exact Aliyun setup**

Record: open DirectMail pay-as-you-go; verify `mail.aerogp.cn`; add the exact DNS records shown by the Aliyun console; create `no-reply@mail.aerogp.cn`; set daily quota and billing alert; put SMTP credentials into `/opt/aerogp/.env`; never paste credentials into the release document.

- [ ] **Step 2: Run full local verification**

Run: `npm test -w apps/api`

Run: `npm test -w apps/admin`

Run: `npm run build`

Expected: all suites PASS and both frontend builds succeed.

- [ ] **Step 3: Run migration and SMTP smoke test on staging**

Use a dedicated test account to bind an actual mailbox, verify the email, request a reset link, reset the password, confirm the link cannot be reused, and confirm an old authenticated session receives 401.

- [ ] **Step 4: Deploy with the existing release procedure**

Follow `docs/deployment/aliyun-test.md`: back up PostgreSQL and `/opt/aerogp/.env`, deploy the reviewed commit, run migrations once, rebuild containers/services, then check `/api/health`, `/api/public/features`, login, SMS recovery and email recovery.

- [ ] **Step 5: Verify production and monitoring**

Verify delivery to at least QQ Mail, 163 Mail and one enterprise mailbox; check sender/domain authentication, spam placement, DirectMail delivery statistics, application logs without tokens, rate limiting and billing alerts.

- [ ] **Step 6: Commit deployment documentation**

```bash
git add docs/deployment/aliyun-test.md docs/deployment/releases/2026-08-17-email-password-recovery.md
git commit -m "docs: add email recovery deployment runbook"
```

## Self-Review

- Spec coverage: data migration, three account types, email verification and replacement, password reset links, SMS fallback, DirectMail, rate limiting, audit, session invalidation, UI, tests and deployment are each mapped to a task.
- Placeholder scan: the plan contains no TBD/TODO or unspecified error-handling steps.
- Type consistency: all tasks use `email`, `emailVerifiedAt`, `emailUpdatedAt`, `accountEmailTokens`, purposes `verify_email`/`reset_password`, and the same six HTTP endpoints.
