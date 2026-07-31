# Release Consistency and Admin Error Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复线上旧 Web 调用新 API 导致的原始 HTML 404，并让构建、部署和后台启动都能识别 API/Web 版本不一致。

**Architecture:** API 与两个 Vite 应用使用同一个 `RELEASE_SHA` 构建标识；API 提供公开只读版本端点，管理后台启动时比较自身编译版本与 API 版本。部署脚本再从服务器外部验证 `.release`、API 标识和实际 HTML 资源入口，避免只看容器健康状态。

**Tech Stack:** Node.js 22、Express 4、Vue 3、Vite 6、Vitest、Node test runner、Docker Compose、Nginx、POSIX shell

**Execution Order:** 这是三份实施计划中的第 1 阶段；先恢复 API/Web 版本一致性和可诊断错误，再开发作品上传与存储管理。

## Global Constraints

- API 与 Web 必须从同一个 Git 提交构建和部署。
- `/admin/index.html` 保持 `Cache-Control: no-store`，带哈希的 JS/CSS 保持 immutable。
- 前端不得向用户展示整段 HTML、代理错误正文、服务器堆栈或内部路径。
- 旧 `/api/admin/registrations` 继续返回 404；生产代码必须使用 `/api/admin/events/:eventId/registrations`。
- 赛事设置、组织审核和报名管理是发布后必测页面。
- 禁止执行 `docker compose down -v`，禁止删除 PostgreSQL 和 uploads 命名卷。

---

## File Structure

- Create: `apps/api/src/routes/system.js` — 返回 API 发布标识和兼容性信息。
- Create: `apps/api/test/system-version.test.js` — 验证版本端点输出、缓存策略和默认值。
- Create: `apps/admin/src/lib/release.js` — 管理端版本比较与可测试的错误模型。
- Create: `apps/admin/src/lib/__tests__/release.test.js` — 验证版本一致、不一致和开发环境行为。
- Modify: `apps/admin/src/lib/api.js` — 按 Content-Type 安全解析错误响应。
- Modify: `apps/admin/src/lib/__tests__/api.test.js` — 覆盖 HTML 和纯文本失败响应。
- Modify: `apps/admin/src/App.vue` — 后台恢复会话前执行版本检查并阻断高风险管理页面。
- Modify: `apps/admin/src/__tests__/App.test.js` — 验证版本不一致提示和阻断。
- Modify: `apps/api/src/server.js` — 挂载系统版本路由。
- Modify: `Dockerfile.api` — 注入 `RELEASE_SHA`。
- Modify: `Dockerfile.web` — 同时向 Web/Admin Vite 构建注入 `VITE_RELEASE_SHA`。
- Modify: `compose.yaml` — API/Web 使用同一个 `RELEASE_SHA`。
- Create: `deploy/verify-release.sh` — 验证运行时 API、HTML 和资源入口一致。
- Modify: `deploy/remote-smoke-test.sh` — 纳入版本与关键页面接口检查。
- Modify: `apps/api/test/deployment-paths.test.js` — 静态验证 Compose/Dockerfile/脚本契约。
- Modify: `apps/api/test/public-site-deployment.test.js` — 验证 Nginx 缓存契约保持不变。
- Modify: `docs/deployment/aliyun-test.md` — 写入同版本发布、验证和回滚命令。

### Task 1: API Release Identity

**Files:**
- Create: `apps/api/src/routes/system.js`
- Create: `apps/api/test/system-version.test.js`
- Modify: `apps/api/src/server.js`

**Interfaces:**
- Consumes: `process.env.RELEASE_SHA`
- Produces: `createSystemRouter({ releaseSha })`
- Produces: `GET /api/system/version -> { releaseSha: string, apiVersion: 1 }`

- [ ] **Step 1: Write the failing API test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { withTestServer } from "../test-support/server.js";

test("system version returns the injected immutable release identity", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/system/version`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      releaseSha: "release-test-123",
      apiVersion: 1
    });
  }, { env: { RELEASE_SHA: "release-test-123" } });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
node --test apps/api/test/system-version.test.js
```

Expected: FAIL because `/api/system/version` does not exist.

- [ ] **Step 3: Implement the version router**

```js
import express from "express";

export function normalizeReleaseSha(value) {
  const releaseSha = String(value || "").trim();
  return releaseSha || "development";
}

export function createSystemRouter({ releaseSha = process.env.RELEASE_SHA } = {}) {
  const router = express.Router();
  router.get("/system/version", (_req, res) => {
    res.set("Cache-Control", "no-store").json({
      releaseSha: normalizeReleaseSha(releaseSha),
      apiVersion: 1
    });
  });
  return router;
}
```

Mount it before authenticated routers:

```js
app.use("/api", createSystemRouter({ releaseSha: process.env.RELEASE_SHA }));
```

- [ ] **Step 4: Run focused and full API tests**

Run:

```bash
node --test apps/api/test/system-version.test.js
npm test -w apps/api
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/system.js apps/api/src/server.js apps/api/test/system-version.test.js
git commit -m "feat: expose API release identity"
```

### Task 2: Safe Non-JSON API Errors

**Files:**
- Modify: `apps/admin/src/lib/api.js`
- Modify: `apps/admin/src/lib/__tests__/api.test.js`

**Interfaces:**
- Consumes: `Response.headers.get("content-type")`
- Produces: `readPayload(response) -> { payload, responseKind }`
- Produces: `ApiError.message = "服务暂时不可用，请刷新后重试 (404)"` for HTML errors

- [ ] **Step 1: Add failing tests for HTML and plain-text responses**

```js
it("does not expose HTML error documents to users", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
    "<!DOCTYPE html><html><body><pre>Cannot GET /api/admin/registrations</pre></body></html>",
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
  )));

  await expect(api("/api/admin/registrations")).rejects.toMatchObject({
    status: 404,
    message: "服务暂时不可用，请刷新后重试 (404)"
  });
});

it("keeps JSON business errors but normalizes proxy text errors", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: "赛事不存在" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    }))
    .mockResolvedValueOnce(new Response("Bad Gateway", {
      status: 502,
      headers: { "Content-Type": "text/plain" }
    })));

  await expect(api("/api/events/E404")).rejects.toMatchObject({ message: "赛事不存在" });
  await expect(api("/api/events/E1")).rejects.toMatchObject({
    message: "服务暂时不可用，请刷新后重试 (502)"
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
npm test -w apps/admin -- src/lib/__tests__/api.test.js
```

Expected: FAIL because raw HTML/text is used as `message`.

- [ ] **Step 3: Implement Content-Type-aware parsing**

Use this contract in `api.js`:

```js
async function readPayload(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const text = await response.text().catch(() => "");
  if (!text) return { payload: {}, responseKind: "empty" };
  if (contentType.includes("application/json")) {
    try { return { payload: JSON.parse(text), responseKind: "json" }; }
    catch { return { payload: {}, responseKind: "invalid-json" }; }
  }
  return { payload: {}, responseKind: contentType.includes("text/html") ? "html" : "text" };
}

function apiFailure(response, parsed) {
  const payload = parsed.payload || {};
  const code = payload.code || "";
  const message = parsed.responseKind === "json"
    ? payload.error || payload.message || payload.errors?.join("，") || `请求失败 (${response.status})`
    : `服务暂时不可用，请刷新后重试 (${response.status})`;
  return new ApiError(message, { status: response.status, code, payload });
}
```

Update `api()` and `apiBlob()` to pass the parsed object.

- [ ] **Step 4: Run focused and full admin tests**

Run:

```bash
npm test -w apps/admin -- src/lib/__tests__/api.test.js
npm test -w apps/admin
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/api.js apps/admin/src/lib/__tests__/api.test.js
git commit -m "fix: normalize non-JSON API errors"
```

### Task 3: Admin Runtime Version Guard

**Files:**
- Create: `apps/admin/src/lib/release.js`
- Create: `apps/admin/src/lib/__tests__/release.test.js`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/__tests__/App.test.js`

**Interfaces:**
- Consumes: `import.meta.env.VITE_RELEASE_SHA`
- Consumes: `GET /api/system/version`
- Produces: `checkReleaseCompatibility(request, webRelease) -> Promise<{ compatible, webRelease, apiRelease }>`
- Produces: user-visible blocking message when production versions differ

- [ ] **Step 1: Write failing unit tests**

```js
import { describe, expect, it, vi } from "vitest";
import { checkReleaseCompatibility } from "../release.js";

describe("checkReleaseCompatibility", () => {
  it("accepts equal release identities", async () => {
    const request = vi.fn().mockResolvedValue({ releaseSha: "abc", apiVersion: 1 });
    await expect(checkReleaseCompatibility(request, "abc")).resolves.toEqual({
      compatible: true,
      webRelease: "abc",
      apiRelease: "abc"
    });
  });

  it("rejects unequal production identities", async () => {
    const request = vi.fn().mockResolvedValue({ releaseSha: "old-api", apiVersion: 1 });
    await expect(checkReleaseCompatibility(request, "new-web")).resolves.toEqual({
      compatible: false,
      webRelease: "new-web",
      apiRelease: "old-api"
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
npm test -w apps/admin -- src/lib/__tests__/release.test.js
```

Expected: FAIL because `release.js` does not exist.

- [ ] **Step 3: Implement the release helper**

```js
export async function checkReleaseCompatibility(request, webRelease) {
  const normalizedWeb = String(webRelease || "development").trim() || "development";
  const payload = await request("/api/system/version");
  const apiRelease = String(payload?.releaseSha || "").trim();
  const development = normalizedWeb === "development" || apiRelease === "development";
  return {
    compatible: development || normalizedWeb === apiRelease,
    webRelease: normalizedWeb,
    apiRelease
  };
}
```

- [ ] **Step 4: Add the App-level failing test**

Mock `/api/system/version` to return another release and assert:

```js
expect(wrapper.text()).toContain("系统版本不一致，请刷新页面或联系管理员");
expect(wrapper.find('[data-testid="admin-shell"]').exists()).toBe(false);
```

- [ ] **Step 5: Implement the App guard**

Add:

```js
const releaseReady = ref(false);
const releaseBlocked = ref(false);

async function verifyRelease() {
  const result = await checkReleaseCompatibility(api, import.meta.env.VITE_RELEASE_SHA);
  releaseBlocked.value = !result.compatible;
  releaseReady.value = true;
}
```

Call `verifyRelease()` before session restoration. Render a dedicated blocking panel when `releaseBlocked` is true. Network failure should use the normalized API error and must not expose HTML.

- [ ] **Step 6: Run focused and full admin tests**

Run:

```bash
npm test -w apps/admin -- src/lib/__tests__/release.test.js src/__tests__/App.test.js
npm test -w apps/admin
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/lib/release.js apps/admin/src/lib/__tests__/release.test.js apps/admin/src/App.vue apps/admin/src/__tests__/App.test.js
git commit -m "feat: guard admin against mixed releases"
```

### Task 4: Inject One Release into API and Web Builds

**Files:**
- Modify: `Dockerfile.api`
- Modify: `Dockerfile.web`
- Modify: `compose.yaml`
- Modify: `apps/api/test/deployment-paths.test.js`

**Interfaces:**
- Consumes: Compose variable `RELEASE_SHA`
- Produces: API environment `RELEASE_SHA`
- Produces: Vite environment `VITE_RELEASE_SHA`

- [ ] **Step 1: Add failing deployment contract assertions**

```js
assert.match(apiDockerfile, /^ARG RELEASE_SHA$/m);
assert.match(apiDockerfile, /^ENV RELEASE_SHA=\$RELEASE_SHA$/m);
assert.match(webDockerfile, /^ARG RELEASE_SHA$/m);
assert.match(webDockerfile, /^ENV VITE_RELEASE_SHA=\$RELEASE_SHA$/m);
assert.match(compose, /RELEASE_SHA:\s*\$\{RELEASE_SHA:\?RELEASE_SHA is required\}/);
```

Also assert both `api.build.args.RELEASE_SHA` and `web.build.args.RELEASE_SHA` use the same Compose variable.

- [ ] **Step 2: Run the deployment test and verify failure**

Run:

```bash
node --test apps/api/test/deployment-paths.test.js
```

Expected: FAIL because no release build arguments exist.

- [ ] **Step 3: Update Dockerfiles and Compose**

`Dockerfile.api`:

```dockerfile
ARG RELEASE_SHA
ENV RELEASE_SHA=$RELEASE_SHA
```

`Dockerfile.web` build stage:

```dockerfile
ARG RELEASE_SHA
ENV VITE_RELEASE_SHA=$RELEASE_SHA
```

`compose.yaml`:

```yaml
api:
  build:
    args:
      RELEASE_SHA: ${RELEASE_SHA:?RELEASE_SHA is required}
  environment:
    RELEASE_SHA: ${RELEASE_SHA:?RELEASE_SHA is required}

web:
  build:
    args:
      RELEASE_SHA: ${RELEASE_SHA:?RELEASE_SHA is required}
```

- [ ] **Step 4: Run deployment tests and a local build**

Run:

```bash
node --test apps/api/test/deployment-paths.test.js apps/api/test/public-site-deployment.test.js
RELEASE_SHA=local-release npm run build
```

Expected: PASS; admin bundle contains `local-release`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile.api Dockerfile.web compose.yaml apps/api/test/deployment-paths.test.js
git commit -m "build: inject one release identity"
```

### Task 5: Runtime Release Verification Script

**Files:**
- Create: `deploy/verify-release.sh`
- Modify: `deploy/remote-smoke-test.sh`
- Modify: `apps/api/test/deployment-paths.test.js`
- Modify: `docs/deployment/aliyun-test.md`

**Interfaces:**
- Consumes: `BASE_URL`, `EXPECTED_RELEASE`
- Produces: exit 0 only when API, `.release` expectation, admin HTML and hashed assets are current

- [ ] **Step 1: Add failing static tests for the script contract**

```js
const verifyRelease = await fs.readFile(path.join(root, "deploy/verify-release.sh"), "utf8");
assert.match(verifyRelease, /api\/system\/version/);
assert.match(verifyRelease, /EXPECTED_RELEASE/);
assert.match(verifyRelease, /admin\/index\.html/);
assert.match(verifyRelease, /admin\/assets\/index-[A-Za-z0-9_-]+\.js/);
assert.match(verifyRelease, /api\/admin\/registrations/);
assert.doesNotMatch(verifyRelease, /set -[^\r\n]*x/);
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test apps/api/test/deployment-paths.test.js
```

Expected: FAIL because `deploy/verify-release.sh` does not exist.

- [ ] **Step 3: Implement `verify-release.sh`**

The script must:

1. Require non-empty `EXPECTED_RELEASE`.
2. Fetch `/api/system/version` with `Cache-Control: no-cache`.
3. Parse `releaseSha` using Node, not `grep` against arbitrary JSON.
4. Fetch `/admin/index.html?release-check=<release>`.
5. Extract exactly one `/admin/assets/index-*.js`.
6. Require the asset URL to return 200.
7. Require the asset to contain the expected release.
8. Fail if the asset contains the legacy literal `"/api/admin/registrations?pageSize=100"`.

Core extraction:

```sh
asset_path="$(node -e '
const fs = require("fs");
const html = fs.readFileSync(process.argv[1], "utf8");
const matches = [...html.matchAll(/src="(\/admin\/assets\/index-[A-Za-z0-9_-]+\.js)"/g)].map(m => m[1]);
if (matches.length !== 1) process.exit(2);
process.stdout.write(matches[0]);
' "$admin_html")"
```

- [ ] **Step 4: Extend remote smoke order**

Add the version check before authenticated admin business checks. Keep legacy endpoint 404 verification, then verify the event-scoped endpoint succeeds.

- [ ] **Step 5: Document exact deployment usage**

```bash
export RELEASE_SHA="$(git rev-parse HEAD)"
docker compose build --pull api web
docker compose up -d --no-deps --wait --wait-timeout 240 api web
EXPECTED_RELEASE="$RELEASE_SHA" BASE_URL=http://127.0.0.1 sh deploy/verify-release.sh
ADMIN_TEST_PASSWORD='...' BASE_URL=http://127.0.0.1 sh deploy/remote-smoke-test.sh
printf '%s\n' "$RELEASE_SHA" > .release
```

State that `.release` is written only after both scripts pass.

- [ ] **Step 6: Run tests**

Run:

```bash
node --test apps/api/test/deployment-paths.test.js apps/api/test/public-site-deployment.test.js
sh -n deploy/verify-release.sh
sh -n deploy/remote-smoke-test.sh
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add deploy/verify-release.sh deploy/remote-smoke-test.sh apps/api/test/deployment-paths.test.js docs/deployment/aliyun-test.md
git commit -m "ops: verify API and Web release consistency"
```

### Task 6: Rebuild and Verify Production

**Files:**
- Modify after successful verification: `/opt/aerogp/.release` on the ECS host
- No database or uploads volume deletion

**Interfaces:**
- Consumes: committed release SHA, verified backups, SSH alias `aerogp`
- Produces: production Web/API on one release

- [ ] **Step 1: Run the full local verification**

```bash
npm test -w apps/admin
npm test -w apps/api
npm run build
git diff --check
```

Expected: all pass.

- [ ] **Step 2: Create and verify backups**

```bash
ssh aerogp 'cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-postgres.sh once'
ssh aerogp 'cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-uploads.sh once'
ssh aerogp 'cd /opt/aerogp && /bin/sh deploy/preflight-admin-upgrade.sh'
```

Expected: backups readable and preflight passes.

- [ ] **Step 3: Transfer the exact committed source**

Create an archive from `git archive HEAD`, transfer it to a new staging directory, preserve `.env` and `backups`, and atomically replace only the source tree after verifying the archive commit.

- [ ] **Step 4: Build API and Web with one release**

```bash
ssh aerogp "cd /opt/aerogp && export RELEASE_SHA='<exact-commit>' && docker compose build --pull api web && docker compose up -d --no-deps --wait --wait-timeout 240 api web"
```

Expected: API and Web healthy.

- [ ] **Step 5: Verify release and authenticated flows**

```bash
ssh aerogp "cd /opt/aerogp && EXPECTED_RELEASE='<exact-commit>' BASE_URL=http://127.0.0.1 sh deploy/verify-release.sh"
ssh aerogp "cd /opt/aerogp && ADMIN_TEST_PASSWORD='<temporary-test-password>' BASE_URL=http://127.0.0.1 sh deploy/remote-smoke-test.sh"
```

Then verify:

- event management no longer displays `Cannot GET /api/admin/registrations`;
- organization management no longer displays raw HTML;
- registration management loads the selected event;
- `/admin/index.html` references the new hashed script.

- [ ] **Step 6: Write `.release` only after success**

```bash
ssh aerogp "cd /opt/aerogp && printf '%s\n' '<exact-commit>' > .release"
```

- [ ] **Step 7: Record the deployment evidence**

Append the release SHA, service health, asset name, smoke result, backup names and rollback image tags to `docs/deployment/aliyun-test.md`.

- [ ] **Step 8: Commit the deployment record**

```bash
git add docs/deployment/aliyun-test.md
git commit -m "docs: record release consistency deployment"
```
