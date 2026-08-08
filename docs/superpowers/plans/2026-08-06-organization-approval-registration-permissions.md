# Organization Approval and Registration Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让组织负责人仅在资质审核通过后获得组织管理权限，禁止无有效组织关系的普通用户报名，并补齐组织删除、临时密码管理和后台赛事列表实时刷新。

**Architecture:** 后端新增集中式组织状态与报名资格策略，所有路由只消费统一判定结果；组织删除和临时密码生命周期在数据库事务中完成。前端根据后端稳定错误码和资格 DTO 做引导，不承担安全边界；实施前先把服务器 `/opt/aerogp` 的有效源码安全同步到独立工作树，因为线上版本新于当前本地分支。

**Tech Stack:** Node.js 22、Express 4、PostgreSQL 16、Vue 3、Vite 6、Vitest 4、Node test runner、Docker Compose、Caddy

## Global Constraints

- 系统账号类型仅允许 `admin`、`organization`、`ordinary`，不新增角色。
- 一个 `organization` 负责人账号只能对应一个组织，不增加独立“新增组织”功能。
- 普通用户参加任何赛制都必须拥有一个已审核、已启用组织的有效成员关系。
- 组织负责人只有在组织 `reviewStatus=approved`、`status=active` 且无强制改密限制时获得组织业务权限。
- 组织报名来源只使用 `member_registration`（成员报名）和 `organization_proxy`（组织代报名）；历史值在展示层兼容映射。
- 删除组织负责人仅限平台管理员；保留历史报名、成绩和证书及组织名称快照。
- 管理员不能查看当前密码；未失效临时密码必须用服务器密钥加密保存，用户改密后永久删除。
- 临时密码加密密钥仅来自 `TEMP_PASSWORD_ENCRYPTION_KEY`，要求 Base64 解码后正好 32 字节；缺失或无效时拒绝管理端重置/查看接口。
- 不复制或提交服务器 `.env`、数据库文件、上传文件、证书、备份、构建产物或账号凭据。
- 平台管理员的组织和普通用户管理是全平台维度，不受当前赛事筛选影响。
- 所有后端权限必须由服务与路由校验，前端隐藏菜单和按钮仅用于用户引导。
- 每个任务先写失败测试、确认失败，再做最小实现、跑测试并提交。

---

### Task 1: 建立线上有效源码的本地开发基线

**Files:**
- Import from server: `/opt/aerogp/apps/**`, `/opt/aerogp/deploy/**`, `/opt/aerogp/Dockerfile.*`, `/opt/aerogp/package*.json`, `/opt/aerogp/compose.yaml`, `/opt/aerogp/.dockerignore`, `/opt/aerogp/.env.example`, `/opt/aerogp/.gitignore`, `/opt/aerogp/.gitattributes`, `/opt/aerogp/README.md`
- Preserve: `docs/superpowers/specs/2026-08-06-organization-approval-registration-permissions-design.md`
- Preserve: `docs/superpowers/plans/2026-08-06-organization-approval-registration-permissions.md`

**Interfaces:**
- Consumes: SSH alias `aerogp`, deployed source root `/opt/aerogp`.
- Produces: isolated worktree branch `codex/organization-registration-permissions` whose source matches the deployed application before feature edits.

- [ ] **Step 1: Create the isolated worktree with the required skill**

Invoke `superpowers:using-git-worktrees`, then create or select a worktree for branch `codex/organization-registration-permissions`. Record its absolute path as `$worktree`; verify it resolves beneath the repository-approved worktree root before any replacement.

- [ ] **Step 2: Build a safe server-side source archive**

Run from PowerShell:

```powershell
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$remoteArchive = "/tmp/aerogp-source-$stamp.tar.gz"
ssh aerogp "tar -C /opt/aerogp -czf '$remoteArchive' --exclude=.env --exclude=node_modules --exclude=backups --exclude=uploads --exclude=certificates --exclude='**/dist' --exclude='qa-*.png' --exclude='*.before-*' apps deploy Dockerfile.api Dockerfile.web package.json package-lock.json compose.yaml .dockerignore .env.example .gitignore .gitattributes README.md"
scp "aerogp:$remoteArchive" "$env:TEMP\aerogp-source-$stamp.tar.gz"
ssh aerogp "rm -f '$remoteArchive'"
```

Expected: local archive exists; `tar -tf` contains source/config files and contains none of `.env`, `backups`, `uploads`, `certificates`, `node_modules`, or `dist`.

- [ ] **Step 3: Mirror the safe snapshot into the isolated worktree**

After resolving and printing `$worktree`, remove only these verified targets inside it: `apps`, `deploy`, `Dockerfile.api`, `Dockerfile.web`, `package.json`, `package-lock.json`, `compose.yaml`, `.dockerignore`, `.env.example`, `.gitignore`, `.gitattributes`, `README.md`. Extract the archive into `$worktree`, then run:

```powershell
git -C $worktree status --short
git -C $worktree diff --check
rg -n "POSTGRES_PASSWORD=.+|SESSION_SECRET=.+|TEMP_PASSWORD_ENCRYPTION_KEY=.+" $worktree -g '!docs/**'
```

Expected: source changes are visible; `git diff --check` succeeds; secret scan has no populated secret values.

- [ ] **Step 4: Verify the imported baseline before feature work**

Run:

```powershell
npm ci --prefix $worktree
npm test --prefix "$worktree\apps\api"
npm test --prefix "$worktree\apps\admin"
npm run build --prefix $worktree
```

Expected: API tests, Admin tests, and production builds all pass before modifications.

- [ ] **Step 5: Commit the deployed-source baseline**

```powershell
git -C $worktree add -A
git -C $worktree commit -m "chore: sync deployed aerogp source baseline"
```

---

### Task 2: Add encrypted temporary-password persistence and deletion-safe snapshots

**Files:**
- Create: `apps/api/src/data/migrations/013-organization-account-lifecycle.sql`
- Create: `apps/api/src/auth/temporary-passwords.js`
- Modify: `apps/api/src/data/schema.sql`
- Modify: `apps/api/src/data/postgres-store.js`
- Modify: `apps/api/src/data/seed.js`
- Modify: `.env.example`
- Modify: `compose.yaml`
- Test: `apps/api/test/temporary-passwords.test.js`
- Test: `apps/api/test/postgres-store.test.js`

**Interfaces:**
- Consumes: `users.password`, `users.mustChangePassword`, the flat database DTO returned by `store.readDb()`.
- Produces: `createTemporaryPasswordVault(secret)`, returning `{ generate(), seal(value), open(record), clear(user) }`; user DTO fields `temporaryPasswordCiphertext`, `temporaryPasswordIv`, `temporaryPasswordTag`, `temporaryPasswordCreatedAt`.

- [ ] **Step 1: Write failing cryptography and schema round-trip tests**

Add tests equivalent to:

```js
test("temporary password is encrypted, decryptable, and clearable", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const vault = createTemporaryPasswordVault(key);
  const password = vault.generate();
  const sealed = vault.seal(password);
  assert.notEqual(sealed.ciphertext, password);
  assert.equal(vault.open(sealed), password);
  const user = { ...sealed, temporaryPasswordCreatedAt: new Date().toISOString() };
  vault.clear(user);
  assert.equal(user.temporaryPasswordCiphertext, null);
});

test("temporary password vault rejects a missing or non-32-byte key", () => {
  assert.throws(() => createTemporaryPasswordVault(""), /TEMP_PASSWORD_ENCRYPTION_KEY/);
  assert.throws(() => createTemporaryPasswordVault(Buffer.alloc(16).toString("base64")), /32 bytes/);
});
```

Extend the PostgreSQL store round-trip test with a user containing all four temporary-password fields and assert the same values are returned after `writeDb`/`readDb`.

- [ ] **Step 2: Run the focused tests and confirm failure**

```powershell
npm test --prefix apps/api -- --test-name-pattern="temporary password|temporary-password fields"
```

Expected: FAIL because the module, migration columns, and store mappings do not exist.

- [ ] **Step 3: Add migration and schema rules**

Migration `013-organization-account-lifecycle.sql` must execute these concrete changes idempotently:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS temporary_password_ciphertext TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS temporary_password_iv TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS temporary_password_tag TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS temporary_password_created_at TIMESTAMPTZ;

ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_created_by_user_id_fkey;
ALTER TABLE registrations ALTER COLUMN created_by_user_id DROP NOT NULL;
ALTER TABLE registrations ADD CONSTRAINT registrations_created_by_user_id_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_organization_id_fkey;
ALTER TABLE registrations ADD CONSTRAINT registrations_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;

ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_owner_snapshot_check
  CHECK (personal_user_id IS NOT NULL OR organization_id IS NOT NULL OR organization_name <> '');
```

Mirror the final definitions in `schema.sql`; add the four nullable camelCase fields in `ensureDbShape`, `readDb`, and user upsert SQL in `postgres-store.js`.

- [ ] **Step 4: Implement the AES-256-GCM vault**

`temporary-passwords.js` must use `randomBytes`, `randomInt`, `createCipheriv`, and `createDecipheriv`. The generated password must contain uppercase, lowercase, and digits, avoid ambiguous characters, and satisfy `validatePassword`. `seal()` returns Base64 ciphertext/IV/tag; `open()` authenticates the GCM tag; `clear()` sets all four user fields to `null`.

- [ ] **Step 5: Add deployment configuration without adding a secret value**

Append only an empty declaration to `.env.example`:

```dotenv
TEMP_PASSWORD_ENCRYPTION_KEY=
```

Pass it to the API container in `compose.yaml`:

```yaml
TEMP_PASSWORD_ENCRYPTION_KEY: ${TEMP_PASSWORD_ENCRYPTION_KEY:-}
```

- [ ] **Step 6: Run focused and migration tests**

```powershell
npm test --prefix apps/api -- --test-name-pattern="temporary password|postgres store|migration"
```

Expected: PASS, including pg-mem and real SQL-shape assertions.

- [ ] **Step 7: Commit**

```powershell
git add apps/api/src/data apps/api/src/auth/temporary-passwords.js apps/api/test .env.example compose.yaml
git commit -m "feat: persist encrypted temporary passwords"
```

---

### Task 3: Centralize organization access state and ordinary-user registration eligibility

**Files:**
- Modify: `apps/api/src/services/access-control.js`
- Modify: `apps/api/src/services/registrations.js`
- Modify: `apps/api/src/routes/registrations.js`
- Modify: `apps/api/src/routes/account-events.js`
- Test: `apps/api/test/multi-event-access-control.test.js`
- Test: `apps/api/test/membership-service.test.js`
- Test: `apps/api/test/registration-management.test.js`

**Interfaces:**
- Produces: `organizationAccessState(db, user)` returning `{ allowed, code, organization }`.
- Produces: `ordinaryRegistrationEligibility(db, userId)` returning `{ eligible, code, organization, membership }`.
- Produces: `registrationContextPayload(...).eligibility` with stable code `ACTIVE_ORGANIZATION_REQUIRED` when ineligible.

- [ ] **Step 1: Write failing policy tests**

Cover these exact cases:

```js
assert.deepEqual(organizationAccessState(db, pendingOwner), {
  allowed: false,
  code: "ORGANIZATION_REVIEW_PENDING",
  organization: pendingOrganization
});
assert.equal(ordinaryRegistrationEligibility(db, unaffiliatedUser.id).code, "ACTIVE_ORGANIZATION_REQUIRED");
assert.equal(ordinaryRegistrationEligibility(db, activeMember.id).eligible, true);
```

Add route tests proving personal registration returns HTTP `403` plus `{ code: "ACTIVE_ORGANIZATION_REQUIRED" }` for no membership, pending membership, rejected organization, and disabled organization; prove approved active membership succeeds for both individual and team projects.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm test --prefix apps/api -- --test-name-pattern="organization access state|ACTIVE_ORGANIZATION_REQUIRED|ordinary registration eligibility"
```

Expected: FAIL because missing `organizationId` is currently accepted.

- [ ] **Step 3: Implement the centralized access functions**

Implement stable mappings:

```js
export function organizationAccessState(db, user) {
  const organization = organizationForOwner(db, user?.id);
  if (user?.type !== "organization" || !organization) return { allowed: false, code: "ORGANIZATION_OWNER_REQUIRED", organization };
  if (organization.reviewStatus === "pending") return { allowed: false, code: "ORGANIZATION_REVIEW_PENDING", organization };
  if (organization.reviewStatus === "rejected") return { allowed: false, code: "ORGANIZATION_REJECTED", organization };
  if (organization.status !== "active") return { allowed: false, code: "ORGANIZATION_DISABLED", organization };
  if (user.mustChangePassword) return { allowed: false, code: "PASSWORD_CHANGE_REQUIRED", organization };
  return { allowed: true, code: "OK", organization };
}
```

`ordinaryRegistrationEligibility` must choose the single active `membership.role === "member"`, then require organization `approved` and `active`. It must not accept a caller-supplied organization ID as proof of membership.

- [ ] **Step 4: Enforce the eligibility in context, create, update, and upload-session paths**

Change personal registration validation so it always derives the organization from `ordinaryRegistrationEligibility`, ignores attempts to substitute another organization, stores that organization ID/name, and uses source `member_registration`. Apply the same policy to personal update and personal image/video upload-session creation so direct API calls cannot bypass it.

- [ ] **Step 5: Return stable codes from organization owner guards**

Replace generic `ORGANIZATION_NOT_APPROVED` branches with the three approved design codes. Route error responses must be JSON objects containing both `error` and `code`.

- [ ] **Step 6: Run access, registration, and upload authorization tests**

```powershell
npm test --prefix apps/api -- --test-name-pattern="access control|registration eligibility|membership|submission authorization"
```

Expected: PASS; an unaffiliated ordinary user cannot create a registration or upload session.

- [ ] **Step 7: Commit**

```powershell
git add apps/api/src/services/access-control.js apps/api/src/services/registrations.js apps/api/src/routes/registrations.js apps/api/src/routes/account-events.js apps/api/test
git commit -m "feat: enforce organization-backed registration eligibility"
```

---

### Task 4: Support member registration and organization proxy registration

**Files:**
- Modify: `apps/api/src/services/registrations.js`
- Modify: `apps/api/src/routes/registrations.js`
- Modify: `apps/api/src/routes/memberships.js`
- Modify: `apps/admin/src/components/OrganizationAthleteRegistrationForm.vue`
- Modify: `apps/admin/src/pages/OrganizationEventWorkspacePage.vue`
- Modify: `apps/admin/src/pages/OrganizationRegistrationRecordsPage.vue`
- Test: `apps/api/test/multi-event-registration-merge.test.js`
- Test: `apps/api/test/organization-registration-history.test.js`
- Test: `apps/admin/src/pages/__tests__/OrganizationEventWorkspacePage.test.js`
- Test: `apps/admin/src/pages/__tests__/OrganizationRegistrationRecordsPage.test.js`

**Interfaces:**
- Consumes: `organizationAccessState`, active ordinary memberships.
- Produces: organization POST body `{ registrationSource, memberUserId?, athlete, projectId, instructor, uploadSessionId? }`.
- Produces: registration `source` equal to `member_registration` or `organization_proxy`.

- [ ] **Step 1: Write failing API tests for both organization channels**

Add assertions:

```js
assert.equal(memberRow.source, "member_registration");
assert.equal(memberRow.personalUserId, activeMember.id);
assert.equal(memberRow.organizationId, organization.id);

assert.equal(proxyRow.source, "organization_proxy");
assert.equal(proxyRow.personalUserId, null);
assert.equal(proxyRow.organizationId, organization.id);
```

Also assert a foreign, pending, or disabled member ID returns `403`; missing `memberUserId` for member mode returns `422`; proxy mode never accepts `personalUserId` from the client.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm test --prefix apps/api -- --test-name-pattern="member_registration|organization_proxy"
```

Expected: FAIL because the current organization channel always creates an unlinked organization row with source `organization`.

- [ ] **Step 3: Implement channel-specific validation**

In `createOrMergeRegistration`, derive values as follows:

```js
const registrationSource = input.registrationSource === "member_registration"
  ? "member_registration"
  : "organization_proxy";
const personalUserId = registrationSource === "member_registration"
  ? requireActiveOrganizationMember(db, organization.id, input.memberUserId).id
  : null;
```

The service must overwrite rather than trust client-provided `organizationId`, `personalUserId`, `source`, and `createdVia`. Preserve `createdVia: "organization"` for compatibility.

- [ ] **Step 4: Return selectable members to the organization workspace**

Extend the existing organization membership list/workspace DTO with active ordinary members only:

```js
members: [{ id: user.id, name: user.name, phone: user.phone }]
```

No user from another organization, pending invitation, or rejected relation may appear.

- [ ] **Step 5: Add the two-mode organization form**

Render a required segmented choice “成员报名 / 组织代报名”. Member mode shows a searchable/selectable active member and pre-fills name/phone while keeping school/grade editable. Proxy mode shows the current manual athlete fields. Submit the exact `registrationSource` and, only in member mode, `memberUserId`.

- [ ] **Step 6: Display source labels in organization records and exports**

Map values exactly:

```js
const sourceText = {
  member_registration: "成员报名",
  organization_proxy: "组织代报名",
  personal: "成员本人报名",
  organization: "历史组织报名"
};
```

Add the source to organization records and the existing registration workbook export without rewriting historical database rows.

- [ ] **Step 7: Run API and Admin tests**

```powershell
npm test --prefix apps/api -- --test-name-pattern="organization registration|registration export"
npm test --prefix apps/admin -- OrganizationEventWorkspacePage OrganizationRegistrationRecordsPage
```

Expected: PASS for both registration modes, filtering, labels, and export.

- [ ] **Step 8: Commit**

```powershell
git add apps/api/src/services/registrations.js apps/api/src/routes apps/api/src/exports apps/api/test apps/admin/src/components/OrganizationAthleteRegistrationForm.vue apps/admin/src/pages/OrganizationEventWorkspacePage.vue apps/admin/src/pages/OrganizationRegistrationRecordsPage.vue apps/admin/src/pages/__tests__
git commit -m "feat: add member and proxy organization registrations"
```

---

### Task 5: Delete an organization account while retaining historical snapshots

**Files:**
- Create: `apps/api/src/services/organization-account-lifecycle.js`
- Modify: `apps/api/src/routes/organizations.js`
- Modify: `apps/api/src/data/postgres-store.js`
- Test: `apps/api/test/organization-account-lifecycle.test.js`
- Test: `apps/api/test/organization-registration-history.test.js`
- Test: `apps/api/test/organization-certificate-history.test.js`

**Interfaces:**
- Produces: `deleteOrganizationAccount(db, { organizationId, actor, makeId, now })` returning `{ ownerUserId, organizationName, retainedRegistrationCount, queuedFileCount }`.
- Produces: `DELETE /api/admin/organizations/:id` available only to platform administrators.

- [ ] **Step 1: Write failing lifecycle tests**

Build a fixture containing an organization owner, active member, participation, credential, proxy registration, result, and certificate. After deletion assert:

```js
assert.equal(db.users.some((row) => row.id === owner.id), false);
assert.equal(db.organizations.some((row) => row.id === organization.id), false);
assert.equal(db.memberships.some((row) => row.organizationId === organization.id), false);
assert.equal(registration.organizationId, null);
assert.equal(registration.createdByUserId, null);
assert.equal(registration.organization, organization.name);
assert.ok(db.certificates.some((row) => row.registrationId === registration.id));
assert.ok(db.fileCleanupJournal.some((row) => row.category === "organization-deleted"));
```

Add route tests for admin success and `403` for ordinary/organization users.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm test --prefix apps/api -- --test-name-pattern="delete organization account|retains organization history"
```

Expected: FAIL because the current generic user deletion rejects linked registrations.

- [ ] **Step 3: Implement the atomic flat-DB mutation**

The service must snapshot `organization.name`, set matching registrations to `organizationId=null` and owner-created rows to `createdByUserId=null`, remove memberships/invitations/participations/documents/organization/owner user, enqueue every uncleaned credential path, and record an `organization.delete` audit log without passwords.

Do not delete registrations, results, certificates, or ordinary member accounts. Display “原组织已删除” when a record has a non-empty organization snapshot but `organizationId === null`.

- [ ] **Step 4: Add the administrator-only route**

Implement:

```js
router.delete("/admin/organizations/:id", requireAdmin, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await store.readDb();
  const result = deleteOrganizationAccount(db, { organizationId: req.params.id, actor: req.user, makeId, now });
  await store.writeDb(db);
  res.json({ ok: true, ...result });
}));
```

Use the router’s existing mutation-lock wrapper so database writes commit or roll back together. Physical credential deletion runs from the cleanup journal after the database commit and remains retryable.

- [ ] **Step 5: Run lifecycle, store, history, and authorization tests**

```powershell
npm test --prefix apps/api -- --test-name-pattern="organization account lifecycle|organization registration history|organization certificate history|authorization"
```

Expected: PASS; historical rows remain queryable after the owner account is gone.

- [ ] **Step 6: Commit**

```powershell
git add apps/api/src/services/organization-account-lifecycle.js apps/api/src/routes/organizations.js apps/api/src/data/postgres-store.js apps/api/test
git commit -m "feat: delete organizations with historical snapshots"
```

---

### Task 6: Complete temporary-password reset, repeat viewing, and password clearing

**Files:**
- Create: `apps/api/src/services/account-passwords.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/auth/password-reset.js`
- Modify: `apps/api/src/routes/organizations.js`
- Modify: `apps/admin/src/pages/OrganizationManagementPage.vue`
- Modify: `apps/admin/src/pages/UserManagementPage.vue`
- Create: `apps/admin/src/pages/PasswordSettingsPage.vue`
- Modify: `apps/admin/src/App.vue`
- Test: `apps/api/test/password-reset.test.js`
- Test: `apps/api/test/admin-users.test.js`
- Test: `apps/admin/src/pages/__tests__/OrganizationManagementPage.test.js`
- Test: `apps/admin/src/pages/__tests__/PasswordSettingsPage.test.js`

**Interfaces:**
- Produces: `resetUserTemporaryPassword(db, user, { vault, hashPassword, now })`.
- Produces: `readUserTemporaryPassword(user, vault)`.
- Produces: `POST /api/admin/users/:id/reset-password` with no caller-supplied password.
- Produces: `GET /api/admin/users/:id/temporary-password`.
- Produces: normal/forced user password settings UI.

- [ ] **Step 1: Write failing API lifecycle tests**

Assert the exact sequence:

```js
const reset = await admin.post(`/api/admin/users/${user.id}/reset-password`).send({});
assert.match(reset.body.temporaryPassword, /[A-Za-z]/);
assert.equal(reset.body.user.mustChangePassword, true);
assert.equal((await login(user.phone, oldPassword)).status, 401);
assert.equal((await login(user.phone, reset.body.temporaryPassword)).status, 200);
assert.equal((await admin.get(`/api/admin/users/${user.id}/temporary-password`)).body.temporaryPassword, reset.body.temporaryPassword);
await changePassword(reset.body.temporaryPassword, newPassword);
assert.equal((await admin.get(`/api/admin/users/${user.id}/temporary-password`)).status, 404);
```

Also assert missing/invalid encryption configuration returns `503` with code `TEMP_PASSWORD_KEY_UNAVAILABLE`, and neither audit logs nor public user DTOs contain plaintext/password hashes.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm test --prefix apps/api -- --test-name-pattern="temporary password|reset password|must change password"
```

Expected: FAIL because reset currently accepts an administrator-supplied password and cannot re-display it.

- [ ] **Step 3: Implement account password services and routes**

`resetUserTemporaryPassword` generates, hashes, seals, sets `mustChangePassword=true`, increments `sessionVersion`, and returns plaintext only in the current response. `readUserTemporaryPassword` decrypts only when all encrypted fields exist. Both admin endpoints write audit entries without secret material.

- [ ] **Step 4: Clear encrypted temporary secrets in every password-change path**

Call `vault.clear(user)` after successful `/api/auth/change-password` and SMS password reset. Keep normal change-password validation: current password, new password, and confirmation handled by the UI; forced change accepts the temporary password as current password and remains unskippable through `requirePasswordReady`.

- [ ] **Step 5: Write failing Admin UI tests**

Test that Organization Management renders “重置密码” and “删除”; reset opens a copyable temporary-password dialog; reopening uses the GET endpoint; delete uses a yes/no confirmation describing retained history. Test that both ordinary and organization sidebars contain “修改密码”, while a forced user sees only the password form and logout path.

- [ ] **Step 6: Implement organization-management actions and password page**

In `OrganizationManagementPage.vue`, use `owner(row).id` for password endpoints and `row.id` for organization deletion. The delete confirmation text must state:负责人账号、组织资料、成员关系和资质将删除；历史报名、成绩和证书保留组织名称快照；操作不可恢复.

`PasswordSettingsPage.vue` must submit:

```js
await api("/api/auth/change-password", {
  method: "POST",
  body: JSON.stringify({ currentPassword, newPassword })
});
```

It must require matching confirmation locally and clear all input values on success.

- [ ] **Step 7: Run API and Admin UI tests**

```powershell
npm test --prefix apps/api -- --test-name-pattern="password|admin users|audit"
npm test --prefix apps/admin -- OrganizationManagementPage PasswordSettingsPage AppNavigation
```

Expected: PASS; admin can repeatedly retrieve only an unexpired current temporary password, and users can remove it only by changing their password.

- [ ] **Step 8: Commit**

```powershell
git add apps/api/src/services/account-passwords.js apps/api/src/server.js apps/api/src/auth/password-reset.js apps/api/src/routes/organizations.js apps/api/test apps/admin/src/pages apps/admin/src/App.vue apps/admin/src/pages/__tests__
git commit -m "feat: add secure temporary password lifecycle"
```

---

### Task 7: Guide restricted organization accounts and ineligible ordinary users

**Files:**
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/pages/OrganizationConsolePage.vue`
- Modify: `apps/admin/src/pages/RegistrationPage.vue`
- Modify: `apps/admin/src/pages/EventCenterPage.vue`
- Modify: `apps/admin/src/state/session.js`
- Modify: `apps/admin/src/styles/forms.css`
- Test: `apps/admin/src/pages/__tests__/OrganizationConsolePage.test.js`
- Test: `apps/admin/src/pages/__tests__/OrdinaryEventWorkflow.test.js`
- Test: `apps/admin/src/pages/__tests__/RegistrationPage.event-context.test.js`
- Test: `apps/admin/src/__tests__/App.test.js`

**Interfaces:**
- Consumes: `organizationAccessState` error codes and `registrationContextPayload.eligibility`.
- Produces: pending/rejected/disabled organization guidance; ordinary-user “请先加入组织” route to `myOrganization`.

- [ ] **Step 1: Write failing route/navigation tests**

Test these exact outcomes:

```js
expect(pendingOwnerNavigation).toEqual(["organization", "passwordSettings"]);
expect(wrapper.text()).toContain("资质审核中");
expect(unaffiliatedRegistration.text()).toContain("请先加入组织");
expect(unaffiliatedRegistration.find("form").exists()).toBe(false);
```

Rejected state must show reject reason and resubmission controls; disabled state must explain that platform administration has disabled the organization. Direct URLs to organization workspace/records/certificates must redirect to the review page.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm test --prefix apps/admin -- OrganizationConsolePage OrdinaryEventWorkflow RegistrationPage App
```

Expected: FAIL because organization accounts currently receive the full menu and the ordinary form permits “不关联组织”.

- [ ] **Step 3: Restrict organization navigation from server state**

Derive `organizationOperational` from the organization returned by `/api/auth/me`. Pending/rejected/disabled owners see only “审核进度”, “修改密码”, and “退出登录”. Route guards must return them to `organization`; do not infer permission from whether a button is visible.

- [ ] **Step 4: Replace optional organization selection with eligibility guidance**

`RegistrationPage.vue` must never render an “不关联组织” option. When `eligibility.eligible === false`, render a card with stable copy and a button emitting navigation to `myOrganization`. When eligible, show the single organization as read-only and prefill school while still allowing school edits.

- [ ] **Step 5: Normalize API error-code translations**

Add one mapping used by Event Center, Registration Page, and Organization Console:

```js
const accessMessages = {
  ACTIVE_ORGANIZATION_REQUIRED: "请先加入已通过审核的组织后再报名",
  ORGANIZATION_REVIEW_PENDING: "组织资质正在审核中",
  ORGANIZATION_REJECTED: "组织资质未通过，请按原因重新提交",
  ORGANIZATION_DISABLED: "组织已被平台停用"
};
```

- [ ] **Step 6: Run Admin tests and build**

```powershell
npm test --prefix apps/admin
npm run build --prefix apps/admin
```

Expected: PASS with no form path for unaffiliated ordinary users and no organization-management path for restricted owners.

- [ ] **Step 7: Commit**

```powershell
git add apps/admin/src/App.vue apps/admin/src/pages apps/admin/src/state apps/admin/src/styles apps/admin/src/**/__tests__
git commit -m "feat: guide restricted organization and ordinary accounts"
```

---

### Task 8: Refresh administrator event context after event mutations

**Files:**
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/pages/EventManagementPage.vue`
- Modify: `apps/admin/src/pages/DashboardPage.vue`
- Test: `apps/admin/src/pages/__tests__/AdminEventContext.test.js`
- Test: `apps/admin/src/pages/__tests__/EventManagementPage.test.js`
- Test: `apps/admin/src/pages/__tests__/DashboardPage.test.js`

**Interfaces:**
- Produces: `refreshAdminEventContext()` that reloads both public event data and `/api/admin/events`.
- Consumes: `EventManagementPage` event `event-changed` after create/update/copy/archive/delete.

- [ ] **Step 1: Write the stale-deletion regression test**

Mock the first `/api/admin/events` response with events A and B, then delete B and return only A. Assert:

```js
expect(apiMock).toHaveBeenCalledWith("/api/admin/events");
expect(wrapper.find('option[value="B"]').exists()).toBe(false);
expect(new URL(window.location.href).searchParams.has("eventId")).toBe(false);
```

Also cover create, edit, copy, and archive emitting exactly one refresh request after the mutation succeeds.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm test --prefix apps/admin -- AdminEventContext EventManagementPage DashboardPage
```

Expected: FAIL because `@event-changed` currently calls only `loadEvent`.

- [ ] **Step 3: Implement the unified refresh**

Add:

```js
async function refreshAdminEventContext() {
  await Promise.all([loadEvent(), loadAdminEvents()]);
  if (adminEventId.value && !adminEvents.value.some((event) => event.id === adminEventId.value)) {
    setAdminEventId("");
  }
}
```

Bind `@event-changed="refreshAdminEventContext"`. `DashboardPage` must render only the current `adminEvents` prop and must not merge local cached names.

- [ ] **Step 4: Run focused and full Admin tests**

```powershell
npm test --prefix apps/admin -- AdminEventContext EventManagementPage DashboardPage
npm test --prefix apps/admin
```

Expected: PASS; a deleted event disappears without page reload.

- [ ] **Step 5: Commit**

```powershell
git add apps/admin/src/App.vue apps/admin/src/pages/EventManagementPage.vue apps/admin/src/pages/DashboardPage.vue apps/admin/src/pages/__tests__
git commit -m "fix: refresh admin events after mutations"
```

---

### Task 9: Full verification, safe deployment, and production acceptance

**Files:**
- Modify: `deploy/remote-smoke-test.sh`
- Modify: `deploy/verify-release.sh`
- Modify: `README.md`
- Create: `docs/operations/organization-account-lifecycle.md`

**Interfaces:**
- Consumes: completed API/Admin implementation and Docker Compose deployment.
- Produces: verified release on `https://aerogp.cn` with rollback artifacts and operations documentation.

- [ ] **Step 1: Extend release smoke coverage before deployment**

Add smoke assertions for:

```text
pending organization workspace -> 403 ORGANIZATION_REVIEW_PENDING
unaffiliated ordinary registration -> 403 ACTIVE_ORGANIZATION_REQUIRED
admin temporary-password reset -> 200 and mustChangePassword=true
temporary-password repeat view -> 200
event list after smoke event deletion -> deleted ID absent
```

Create smoke accounts/events with unique timestamp IDs; cleanup in the script trap. Do not print passwords to terminal logs.

- [ ] **Step 2: Run the complete local gate**

```powershell
npm test --prefix apps/api
npm test --prefix apps/admin
npm test --prefix apps/web
npm run build
git diff --check
git status --short
```

Expected: every test and build passes; only intended source/docs changes are present.

- [ ] **Step 3: Perform a final code review and fix findings**

Invoke `superpowers:requesting-code-review`, address all correctness/security findings, then rerun Step 2. Review must specifically inspect authorization bypasses, password plaintext leakage, organization deletion FK behavior, cleanup-journal durability, and historical registration visibility.

- [ ] **Step 4: Prepare server secrets and backups**

On the server, create a database backup and verify it:

```bash
ssh aerogp 'cd /opt/aerogp && mkdir -p backups && docker compose exec -T postgres sh -c '\''pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'\'' > "backups/pre-org-lifecycle-$(date +%Y%m%d%H%M%S).dump"'
ssh aerogp 'cd /opt/aerogp && ./deploy/verify-backup.sh'
```

Generate the encryption key locally without displaying it, append it to server `.env` with restrictive permissions if the variable is absent, and never add it to Git:

```bash
ssh aerogp 'set -eu; umask 077; key="$(openssl rand -base64 32 | tr -d "\n")"; if grep -q "^TEMP_PASSWORD_ENCRYPTION_KEY=" /opt/aerogp/.env; then sed -i "s|^TEMP_PASSWORD_ENCRYPTION_KEY=.*|TEMP_PASSWORD_ENCRYPTION_KEY=$key|" /opt/aerogp/.env; else printf "\nTEMP_PASSWORD_ENCRYPTION_KEY=%s\n" "$key" >> /opt/aerogp/.env; fi; unset key'
```

- [ ] **Step 5: Sync only reviewed source and build a new release**

From the reviewed worktree, create a server-side source backup, upload only deployable source, verify `/opt/aerogp`, and replace only source directories/root build files. The commands intentionally preserve `.env`, named Docker volumes, uploads, certificates, and database backups:

```powershell
$release = (git rev-parse HEAD).Trim()
if ($release -notmatch '^[0-9a-f]{40}$') { throw 'release SHA must be 40 hexadecimal characters' }
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$archive = Join-Path $env:TEMP "aerogp-release-$stamp.tar.gz"

ssh aerogp "test \"`$(realpath /opt/aerogp)\" = /opt/aerogp && cd /opt/aerogp && tar -czf \"backups/source-before-org-lifecycle-$stamp.tar.gz\" --exclude=.env --exclude=node_modules --exclude=backups --exclude=uploads --exclude=certificates --exclude='**/dist' apps deploy Dockerfile.api Dockerfile.web package.json package-lock.json compose.yaml .dockerignore .env.example .gitignore .gitattributes README.md"
tar -C . -czf $archive --exclude='**/node_modules' --exclude='**/dist' apps deploy Dockerfile.api Dockerfile.web package.json package-lock.json compose.yaml .dockerignore .env.example .gitignore .gitattributes README.md
scp $archive "aerogp:/tmp/aerogp-release-$stamp.tar.gz"
ssh aerogp "set -eu; test \"`$(realpath /opt/aerogp)\" = /opt/aerogp; cd /opt/aerogp; rm -rf apps deploy; tar -xzf \"/tmp/aerogp-release-$stamp.tar.gz\"; rm -f \"/tmp/aerogp-release-$stamp.tar.gz\"; if grep -q '^RELEASE_SHA=' .env; then sed -i \"s/^RELEASE_SHA=.*/RELEASE_SHA=$release/\" .env; else printf '\nRELEASE_SHA=%s\n' '$release' >> .env; fi"
Remove-Item -LiteralPath $archive

ssh aerogp "cd /opt/aerogp && docker compose build api web"
ssh aerogp "cd /opt/aerogp && docker compose up -d --wait postgres api web caddy backup"
ssh aerogp "cd /opt/aerogp && docker compose ps"
```

Expected: all services are healthy; migration `013-organization-account-lifecycle.sql` is recorded.

- [ ] **Step 6: Run release and smoke verification**

```bash
ssh aerogp 'cd /opt/aerogp && EXPECTED_RELEASE="$(sed -n "s/^RELEASE_SHA=//p" .env)" BASE_URL=https://aerogp.cn ./deploy/verify-release.sh'
ssh aerogp 'cd /opt/aerogp && ADMIN_TEST_PASSWORD="$(sed -n "s/^密码=//p" /root/aerogp-admin-credentials.txt)" BASE_URL=https://aerogp.cn ./deploy/remote-smoke-test.sh'
```

Expected: release SHA matches API and Admin assets; all public, admin, registration, organization, password, and cleanup smoke checks pass.

- [ ] **Step 7: Perform browser acceptance**

Using the in-app browser, verify at `https://aerogp.cn/admin/`:

1. Pending organization owner sees only review/resubmit, password settings, and logout.
2. Approved active owner can select member registration or proxy registration.
3. Unaffiliated ordinary user sees “请先加入组织” and no registration form.
4. Admin can reset/reopen a temporary password and receives a copyable value.
5. Admin organization deletion confirmation explains retained history; after a test deletion, historical registration/result/certificate remain marked “原组织已删除”.
6. Deleting a test event immediately removes its name from the overview switcher.

- [ ] **Step 8: Document operations and commit deployment checks**

Document key rotation, temporary-password behavior, organization deletion effects, backup/rollback commands, and audit actions in `docs/operations/organization-account-lifecycle.md` without including real secrets.

```powershell
git add deploy README.md docs/operations/organization-account-lifecycle.md
git commit -m "docs: add organization account lifecycle operations"
```

- [ ] **Step 9: Finish the development branch**

Invoke `superpowers:finishing-a-development-branch`, present the verified commit list and production acceptance evidence, and keep the rollback backup until the user explicitly authorizes its cleanup.
