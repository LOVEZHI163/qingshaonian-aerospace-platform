# Image and Video Competition Submissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为赛项增加“无需上传 / 图像视频作品”，让普通用户和组织管理员在报名时必传合规图片与视频，并让平台管理员在报名审核中安全预览、下载、替换和审核。

**Architecture:** 赛项通过 `submissionMode` 决定是否需要固定的 `artwork_image` 和 `creation_video` 两类材料。文件先流式写入受账号、赛事和赛项约束的上传会话，正式报名事务再绑定材料；私有读取端点统一执行报名归属检查并支持视频 Range。

**Tech Stack:** PostgreSQL 16、Node.js 22、Express 4、Multer 2 磁盘存储、file-type、Sharp、ffprobe、Vue 3、Vitest、Node test runner、Nginx、Docker Compose

**Execution Order:** 这是第 2 阶段；开始前必须完成 `2026-07-31-release-consistency-admin-errors.md`。本计划先建立上传磁盘保护，供第 3 阶段扩展为完整服务器概览。

## Global Constraints

- 赛项显示值必须是“无需上传”和“图像视频作品”。
- 图像视频作品必须同时上传作品图片与作画视频，缺一不可提交报名。
- 图片仅 JPG/PNG，最大 2MB；长边低于 780 像素警告但不阻止。
- 视频仅 MP4，最大 200MB，最长 120 秒；低于 720P警告但不阻止。
- 画面内容、剪辑、滤镜、水印和拍摄规范由管理员人工审核。
- 普通用户只能替换待审核或已驳回报名；组织管理员可替换本组织报名。
- 组织管理员替换已通过材料后，报名自动恢复待审核。
- 测试阶段文件保存在 ECS `uploads_data`；大视频不得进入 Node.js 内存。
- 文件必须私有；所有读取端点重新检查用户、赛事、报名和组织归属。
- 磁盘达到 90% 时暂停新视频上传，不影响普通报名、查看和下载。
- 原有赛项默认无需上传，现有普通报名流程必须保持兼容。

---

## File Structure

- Create: `apps/api/src/data/migrations/008-image-video-submissions.sql` — 赛项模式、上传会话和材料表。
- Modify: `apps/api/src/data/schema.sql` — 新安装数据库结构。
- Modify: `apps/api/src/data/seed.js` — JSON store 默认数组和历史赛项默认模式。
- Modify: `apps/api/src/data/postgres-store.js` — 新结构的读取与持久化。
- Create: `apps/api/src/files/submission-storage.js` — 流式临时文件、签名/元数据校验、Range读取和安全删除。
- Modify: `apps/api/src/files/policy.js` — 图片和视频策略常量。
- Create: `apps/api/src/services/system-storage.js` — 上传磁盘占用率与视频容量保护。
- Create: `apps/api/src/services/submission-assets.js` — 会话、绑定、替换、权限和状态重置。
- Create: `apps/api/src/routes/submission-assets.js` — 用户、组织和管理员上传/查看/下载 API。
- Modify: `apps/api/src/routes/registrations.js` — 正式报名绑定上传会话。
- Modify: `apps/api/src/routes/events.js` — 赛项模式输入输出。
- Modify: `apps/api/src/services/events.js` — 报名上下文暴露赛项模式。
- Modify: `apps/api/src/services/registrations.js` — 列表和详情附带材料摘要。
- Modify: `apps/api/src/server.js` — 挂载材料路由和过期清理。
- Modify: `Dockerfile.api` — 安装 ffprobe。
- Modify: `deploy/nginx.conf` — 只对作品上传路径提高限制并关闭请求缓冲。
- Modify: `compose.yaml` — 磁盘警告阈值和上传会话期限。
- Create: `apps/api/test/submission-schema.test.js`
- Create: `apps/api/test/submission-storage.test.js`
- Create: `apps/api/test/system-storage.test.js`
- Create: `apps/api/test/submission-assets.test.js`
- Create: `apps/api/test/submission-authorization.test.js`
- Modify: `apps/api/test/event-management.test.js`
- Modify: `apps/api/test/registration-management.test.js`
- Create: `apps/admin/src/lib/upload.js` — XHR 上传进度与统一错误。
- Create: `apps/admin/src/lib/__tests__/upload.test.js`
- Create: `apps/admin/src/components/SubmissionAssetUploader.vue`
- Create: `apps/admin/src/components/__tests__/SubmissionAssetUploader.test.js`
- Modify: `apps/admin/src/pages/EventManagementPage.vue`
- Modify: `apps/admin/src/pages/__tests__/EventManagementPage.test.js`
- Modify: `apps/admin/src/pages/RegistrationPage.vue`
- Modify: `apps/admin/src/pages/__tests__/RegistrationPage.event-context.test.js`
- Modify: `apps/admin/src/components/OrganizationAthleteRegistrationForm.vue`
- Modify: `apps/admin/src/pages/OrganizationEventWorkspacePage.vue`
- Modify: `apps/admin/src/pages/__tests__/OrganizationEventWorkspacePage.test.js`
- Modify: `apps/admin/src/pages/RegistrationRecordsPage.vue`
- Modify: `apps/admin/src/pages/RegistrationManagementPage.vue`
- Modify: `apps/admin/src/pages/__tests__/RegistrationManagementPage.test.js`
- Create: `apps/admin/src/components/SubmissionAssetReview.vue`
- Create: `apps/admin/src/components/__tests__/SubmissionAssetReview.test.js`
- Modify: `apps/admin/src/styles/admin.css`
- Modify: `apps/api/test/public-site-deployment.test.js`

### Task 1: Database Schema and Store Shape

**Files:**
- Create: `apps/api/src/data/migrations/008-image-video-submissions.sql`
- Modify: `apps/api/src/data/schema.sql`
- Modify: `apps/api/src/data/seed.js`
- Modify: `apps/api/src/data/postgres-store.js`
- Create: `apps/api/test/submission-schema.test.js`
- Modify: `apps/api/test/postgres-store.test.js`

**Interfaces:**
- Produces: `project.submissionMode: "none" | "image_video"`
- Produces: `db.registrationUploadSessions: RegistrationUploadSession[]`
- Produces: `db.registrationSubmissionAssets: RegistrationSubmissionAsset[]`

- [ ] **Step 1: Write failing schema tests**

```js
test("submission migration adds project mode and private upload tables", async () => {
  const migration = await read("apps/api/src/data/migrations/008-image-video-submissions.sql");
  assert.match(migration, /ADD COLUMN submission_mode TEXT NOT NULL DEFAULT 'none'/);
  assert.match(migration, /CHECK \(submission_mode IN \('none', 'image_video'\)\)/);
  assert.match(migration, /CREATE TABLE registration_upload_sessions/);
  assert.match(migration, /CREATE TABLE registration_submission_assets/);
  assert.match(migration, /CHECK \(kind IN \('artwork_image', 'creation_video'\)\)/);
  assert.match(migration, /UNIQUE \(registration_id, kind\)/);
});
```

Add a PostgreSQL round-trip case:

```js
db.projects[0].submissionMode = "image_video";
db.registrationUploadSessions.push({
  id: "US1", eventId: db.events[0].id, projectId: db.projects[0].id,
  ownerUserId: db.users[0].id, organizationId: null,
  state: "active", createdAt: now, expiresAt: later, committedAt: null
});
db.registrationSubmissionAssets.push({
  id: "SA1", registrationId: null, uploadSessionId: "US1",
  kind: "artwork_image", originalName: "work.png", storedName: "original.png",
  filePath: "/data/uploads/submission-assets/SA1/original.png",
  mimeType: "image/png", sizeBytes: 100, width: 800, height: 600,
  durationMs: null, uploadedByUserId: db.users[0].id,
  uploadedAt: now, cleanedAt: null, cleanupReason: ""
});
await store.writeDb(db);
const reloaded = await store.readDb();
assert.equal(reloaded.projects[0].submissionMode, "image_video");
assert.equal(reloaded.registrationSubmissionAssets[0].kind, "artwork_image");
```

- [ ] **Step 2: Run tests and verify failure**

```bash
node --test apps/api/test/submission-schema.test.js apps/api/test/postgres-store.test.js
```

Expected: FAIL because migration and store fields do not exist.

- [ ] **Step 3: Add migration and schema**

Use:

```sql
ALTER TABLE projects
  ADD COLUMN submission_mode TEXT NOT NULL DEFAULT 'none'
  CONSTRAINT projects_submission_mode_check
  CHECK (submission_mode IN ('none', 'image_video'));

CREATE TABLE registration_upload_sessions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('active', 'committed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ
);

CREATE TABLE registration_submission_assets (
  id TEXT PRIMARY KEY,
  registration_id TEXT REFERENCES registrations(id) ON DELETE CASCADE,
  upload_session_id TEXT NOT NULL REFERENCES registration_upload_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('artwork_image', 'creation_video')),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL,
  cleaned_at TIMESTAMPTZ,
  cleanup_reason TEXT NOT NULL DEFAULT '',
  UNIQUE (registration_id, kind)
);
```

Add indexes on session owner/expiry and asset registration/session.

- [ ] **Step 4: Extend seed shape and PostgreSQL mapper**

`ensureDbShape()` must set:

```js
db.registrationUploadSessions ||= [];
db.registrationSubmissionAssets ||= [];
for (const project of db.projects || []) project.submissionMode ||= "none";
```

Read/write all snake_case fields explicitly. Do not serialize file paths into API responses from the store layer.

- [ ] **Step 5: Run focused and full API tests**

```bash
node --test apps/api/test/submission-schema.test.js apps/api/test/postgres-store.test.js
npm test -w apps/api
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/data/migrations/008-image-video-submissions.sql apps/api/src/data/schema.sql apps/api/src/data/seed.js apps/api/src/data/postgres-store.js apps/api/test/submission-schema.test.js apps/api/test/postgres-store.test.js
git commit -m "feat: add submission asset schema"
```

### Task 2: Project Submission Mode

**Files:**
- Modify: `apps/api/src/routes/events.js`
- Modify: `apps/api/src/services/events.js`
- Modify: `apps/api/src/services/site-preview.js`
- Modify: `apps/api/test/event-management.test.js`
- Modify: `apps/admin/src/pages/EventManagementPage.vue`
- Modify: `apps/admin/src/pages/__tests__/EventManagementPage.test.js`

**Interfaces:**
- Consumes/Produces: `submissionMode: "none" | "image_video"`
- Produces: admin labels “无需上传” and “图像视频作品”

- [ ] **Step 1: Add failing API tests**

Create a project with:

```js
{
  name: "绘画赛",
  type: "individual",
  category: "美术",
  allowedGroups: ["小学低段"],
  submissionMode: "image_video"
}
```

Assert the created row and `GET /api/me/registration-context?eventId=...` both return `image_video`. Assert invalid `"video_only"` returns 422. Assert omitted mode returns `none`.

- [ ] **Step 2: Run API test and verify failure**

```bash
node --test apps/api/test/event-management.test.js
```

Expected: FAIL because the field is ignored.

- [ ] **Step 3: Add server validation**

```js
const SUBMISSION_MODES = new Set(["none", "image_video"]);

function submissionMode(value = "none") {
  if (!SUBMISSION_MODES.has(value)) {
    throw Object.assign(new Error("作品提交类型不合法"), { status: 422 });
  }
  return value;
}
```

Include the field in create, update, admin list, account registration context and site preview safe project fields.

- [ ] **Step 4: Add failing admin UI test**

```js
expect(wrapper.get('[data-field="submission-mode"]').findAll("option").map((node) => node.text()))
  .toEqual(["无需上传", "图像视频作品"]);

await wrapper.get('[data-field="submission-mode"]').setValue("image_video");
await wrapper.get("form").trigger("submit");
expect(apiMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
  body: expect.stringContaining('"submissionMode":"image_video"')
}));
```

- [ ] **Step 5: Implement admin select and list badge**

Add `submissionMode` to `PROJECT_FIELDS`, `emptyProject()`, edit cloning and save payload. Show “图像视频作品” on project cards.

- [ ] **Step 6: Run tests**

```bash
node --test apps/api/test/event-management.test.js
npm test -w apps/admin -- src/pages/__tests__/EventManagementPage.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/events.js apps/api/src/services/events.js apps/api/src/services/site-preview.js apps/api/test/event-management.test.js apps/admin/src/pages/EventManagementPage.vue apps/admin/src/pages/__tests__/EventManagementPage.test.js
git commit -m "feat: configure image video projects"
```

### Task 3: Streamed File Storage and Metadata Validation

**Files:**
- Create: `apps/api/src/files/submission-storage.js`
- Modify: `apps/api/src/files/policy.js`
- Create: `apps/api/src/services/system-storage.js`
- Create: `apps/api/test/submission-storage.test.js`
- Create: `apps/api/test/system-storage.test.js`
- Modify: `Dockerfile.api`

**Interfaces:**
- Produces: `SUBMISSION_IMAGE_POLICY`
- Produces: `SUBMISSION_VIDEO_POLICY`
- Produces: `inspectSubmissionFile({ kind, filePath, originalName, probeVideo })`
- Produces: `readSubmissionRange(record, rangeHeader)`
- Produces: `deleteSubmissionFile(record)`
- Produces: `readStorageStatus({ uploadRoot, fileSystem })`
- Produces: `assertVideoUploadCapacity(status, incomingBytes)`

- [ ] **Step 1: Write failing image validation tests**

Use temporary PNG/JPEG files generated by Sharp. Assert:

```js
const valid = await inspectSubmissionFile({ kind: "artwork_image", filePath: pngPath, originalName: "作品.png" });
assert.deepEqual(valid.warnings, []);
assert.equal(valid.mimeType, "image/png");
assert.equal(valid.width, 800);

const lowResolution = await inspectSubmissionFile({ kind: "artwork_image", filePath: smallPath, originalName: "小图.jpg" });
assert.deepEqual(lowResolution.warnings, ["作品图片长边低于建议的 780 像素"]);
```

Assert GIF, renamed PDF and files over `2 * 1024 * 1024` are rejected.

- [ ] **Step 2: Write failing video validation tests**

Inject a fake probe:

```js
const probeVideo = async () => ({ durationMs: 119_900, width: 1280, height: 720 });
const valid = await inspectSubmissionFile({
  kind: "creation_video",
  filePath: mp4Fixture,
  originalName: "作画.mp4",
  probeVideo
});
assert.equal(valid.durationMs, 119_900);
assert.deepEqual(valid.warnings, []);
```

Assert 120001ms is rejected, 640×360 returns a 720P warning, non-MP4 signature is rejected, and over 200MB is rejected by stat without reading the whole file.

- [ ] **Step 3: Write failing disk-capacity tests**

Inject `statfs` through `readStorageStatus` and assert the exact thresholds:

```js
const warning = await readStorageStatus({
  uploadRoot: "/uploads",
  fileSystem: {
    statfs: async () => ({ bsize: 1, blocks: 100, bfree: 15, bavail: 15 }),
    access: async () => {}
  }
});
assert.equal(warning.disk.usedPercent, 85);
assert.equal(warning.level, "warning");

assert.throws(
  () => assertVideoUploadCapacity({ ...warning, level: "critical" }, 1),
  /磁盘空间严重不足/
);
```

Cover 79.99 → `normal`, 80 → `warning`, 90 → `critical`. Also assert that a projected upload crossing 90% is rejected while image uploads and existing-file reads are not routed through this guard.

- [ ] **Step 4: Run tests and verify failure**

```bash
node --test apps/api/test/submission-storage.test.js apps/api/test/system-storage.test.js
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 5: Implement policies, inspection and disk guard**

Policies:

```js
export const SUBMISSION_IMAGE_POLICY = {
  mimeTypes: new Set(["image/png", "image/jpeg"]),
  maxBytes: 2 * 1024 * 1024
};

export const SUBMISSION_VIDEO_POLICY = {
  mimeTypes: new Set(["video/mp4"]),
  maxBytes: 200 * 1024 * 1024,
  maxDurationMs: 120_000
};
```

Use `fileTypeFromFile(filePath)`, `fs.stat(filePath)`, `sharp(filePath).metadata()` and an injected `probeVideo`. Production probe must execute:

```text
ffprobe -v error -show_entries format=duration:stream=codec_type,width,height -of json <file>
```

Use `execFile`, never concatenate a shell command. Select the first video stream and convert duration seconds to integer milliseconds.

Implement `readStorageStatus` with filesystem `statfs`, using `UPLOAD_WARNING_PERCENT=80` and `UPLOAD_CRITICAL_PERCENT=90`. `assertVideoUploadCapacity` must reject both an already-critical disk and an incoming video whose projected usage would cross the critical threshold. It must not be called for images, viewing or downloads.

- [ ] **Step 6: Implement private Range reads**

Parse only:

```text
bytes=<start>-<end>
bytes=<start>-
bytes=-<suffix>
```

Reject multiple ranges with 416. Return `{ status, headers, stream }`, where video partial responses include `Content-Range`, `Accept-Ranges: bytes`, exact `Content-Length`, and `Content-Type: video/mp4`.

- [ ] **Step 7: Install ffprobe in the API image**

Update:

```dockerfile
RUN apk add --no-cache libc6-compat ffmpeg
```

Add a deployment test asserting `ffmpeg` is installed without removing `USER node`.

- [ ] **Step 8: Run tests**

```bash
node --test apps/api/test/submission-storage.test.js apps/api/test/system-storage.test.js apps/api/test/public-site-deployment.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/files/submission-storage.js apps/api/src/files/policy.js apps/api/src/services/system-storage.js apps/api/test/submission-storage.test.js apps/api/test/system-storage.test.js Dockerfile.api apps/api/test/public-site-deployment.test.js
git commit -m "feat: validate streamed submission files"
```

### Task 4: Upload Sessions and Private Asset API

**Files:**
- Create: `apps/api/src/services/submission-assets.js`
- Create: `apps/api/src/routes/submission-assets.js`
- Modify: `apps/api/src/server.js`
- Create: `apps/api/test/submission-assets.test.js`

**Interfaces:**
- Produces: `createUploadSession({ db, eventId, projectId, actor, channel, now, makeId })`
- Produces: `replaceSessionAsset({ db, session, kind, stored, actor, now, makeId })`
- Produces: `submissionAssetSummary(asset)`
- Consumes: `readStorageStatus` and `assertVideoUploadCapacity`
- Produces: upload endpoints from the approved design

- [ ] **Step 1: Write failing session authorization tests**

Assert:

- ordinary user can create a session for a published, writable `image_video` project;
- session creation for `none` returns 422;
- organization owner must own an approved organization that joined the event;
- a second user cannot upload to the first user's session;
- expired and committed sessions reject uploads.

Example:

```js
const response = await fetch(`${baseUrl}/api/me/events/${eventId}/projects/${projectId}/upload-sessions`, {
  method: "POST",
  headers: { Cookie: ordinary.cookie }
});
assert.equal(response.status, 201);
assert.match((await response.json()).row.id, /^US/);
```

- [ ] **Step 2: Run test and verify failure**

```bash
node --test apps/api/test/submission-assets.test.js
```

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement session service**

Rules:

```js
const SESSION_TTL_MS = Number(process.env.SUBMISSION_SESSION_TTL_MS || 86_400_000);
```

Return only safe fields:

```js
{
  id, eventId, projectId, organizationId, state, expiresAt,
  assets: {
    artwork_image: safeAssetOrNull,
    creation_video: safeAssetOrNull
  }
}
```

Never return `filePath` or `storedName`.

- [ ] **Step 4: Implement disk upload middleware**

Authenticate and authorize the session before calling Multer. Use `diskStorage`, a controlled session directory and one file field named `file`. Set Multer limit to policy max plus one byte so the application can return a precise 413 message.

For `creation_video`, read current disk status before Multer and pass the request `Content-Length` to `assertVideoUploadCapacity`. After Multer, recalculate with the actual temporary-file size before accepting metadata; if the threshold has been crossed concurrently, delete the temporary file and return 507. Do not apply this capacity guard to images, preview or download.

After upload:

1. inspect the file;
2. on failure delete it;
3. replace an existing session asset of the same kind;
4. persist metadata;
5. delete the previous unbound file after database commit.

- [ ] **Step 5: Implement private preview/download**

Use separate user, organization and admin URL families. Each route resolves the registration and material through `registrationId`, `eventId` and `kind`; never accept a file path from the request.

- [ ] **Step 6: Run tests**

```bash
node --test apps/api/test/submission-assets.test.js
npm test -w apps/api
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/submission-assets.js apps/api/src/routes/submission-assets.js apps/api/src/server.js apps/api/test/submission-assets.test.js
git commit -m "feat: add private submission upload sessions"
```

### Task 5: Bind Materials to Registrations and Replace Safely

**Files:**
- Modify: `apps/api/src/routes/registrations.js`
- Modify: `apps/api/src/services/registrations.js`
- Modify: `apps/api/src/services/submission-assets.js`
- Create: `apps/api/test/submission-authorization.test.js`
- Modify: `apps/api/test/registration-management.test.js`

**Interfaces:**
- Consumes: request `uploadSessionId`
- Produces: `commitUploadSession({ db, sessionId, registration, actor, now })`
- Produces: `replaceRegistrationAsset({ store, registration, kind, uploadedAsset, actor, channel })`

- [ ] **Step 1: Write failing creation tests**

Assert:

- image-video registration without `uploadSessionId` returns 422;
- session with only one asset returns 422 with the missing material name;
- valid session creates the registration and binds both assets;
- normal project ignores absent session and follows the current JSON path;
- session cannot be committed twice to another registration.

- [ ] **Step 2: Run test and verify failure**

```bash
node --test apps/api/test/submission-authorization.test.js
```

Expected: FAIL because registration creation does not require materials.

- [ ] **Step 3: Implement transactional binding**

Inside the existing mutation lock:

```js
const result = createOrMergeRegistration(...);
if (project.submissionMode === "image_video") {
  commitUploadSession({
    db,
    sessionId: req.body.uploadSessionId,
    registration: result.row,
    actor: req.user,
    now
  });
}
await store.writeDb(db);
```

`commitUploadSession` must verify:

- session owner/channel;
- event and project equality;
- state `active`;
- not expired;
- both asset kinds exist and are not cleaned;
- `registrationId` assignment for both assets;
- session state becomes `committed`.

- [ ] **Step 4: Write failing replacement permission tests**

Assert:

- ordinary owner can replace pending/rejected;
- ordinary owner cannot replace approved;
- organization owner can replace own organization asset in any review state;
- organization replacement of approved changes status to pending;
- organization owner cannot replace another organization;
- admin can replace and creates an audit log;
- failed new validation leaves old file and database row unchanged.

- [ ] **Step 5: Implement replacement**

Use a new upload session asset as the replacement source. In one database write:

```js
current.originalName = replacement.originalName;
current.storedName = replacement.storedName;
current.filePath = replacement.filePath;
current.mimeType = replacement.mimeType;
current.sizeBytes = replacement.sizeBytes;
current.width = replacement.width;
current.height = replacement.height;
current.durationMs = replacement.durationMs;
current.uploadedByUserId = actor.id;
current.uploadedAt = now();
current.cleanedAt = null;
current.cleanupReason = "";
```

When organization/admin content replacement affects an approved registration:

```js
registration.status = "pending";
registration.rejectReason = "";
registration.updatedAt = now();
```

Delete the old physical file after the database write. On delete failure append `fileCleanupJournal`.

- [ ] **Step 6: Add safe material summaries to registration output**

Each registration may expose:

```js
submission: {
  required: true,
  complete: true,
  warnings: ["作画视频低于建议的 720P"],
  assets: {
    artwork_image: { kind, originalName, mimeType, sizeBytes, width, height, uploadedAt, cleanedAt },
    creation_video: { kind, originalName, mimeType, sizeBytes, width, height, durationMs, uploadedAt, cleanedAt }
  }
}
```

No path fields.

- [ ] **Step 7: Run tests**

```bash
node --test apps/api/test/submission-authorization.test.js apps/api/test/registration-management.test.js
npm test -w apps/api
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/registrations.js apps/api/src/services/registrations.js apps/api/src/services/submission-assets.js apps/api/test/submission-authorization.test.js apps/api/test/registration-management.test.js
git commit -m "feat: bind and replace registration materials"
```

### Task 6: Upload Progress Component

**Files:**
- Create: `apps/admin/src/lib/upload.js`
- Create: `apps/admin/src/lib/__tests__/upload.test.js`
- Create: `apps/admin/src/components/SubmissionAssetUploader.vue`
- Create: `apps/admin/src/components/__tests__/SubmissionAssetUploader.test.js`
- Modify: `apps/admin/src/styles/admin.css`

**Interfaces:**
- Produces: `uploadFile(path, file, { onProgress, signal })`
- Produces: `<SubmissionAssetUploader sessionId mode assets @complete @error>`

- [ ] **Step 1: Write failing upload helper tests**

Use a fake `XMLHttpRequest` and assert:

```js
expect(progress).toHaveBeenCalledWith({ loaded: 50, total: 100, percent: 50 });
expect(request.withCredentials).toBe(true);
expect(request.open).toHaveBeenCalledWith("PUT", "/api/upload-sessions/US1/creation-video");
```

Assert JSON business errors are preserved and HTML errors become the same safe message as `api.js`.

- [ ] **Step 2: Run and verify failure**

```bash
npm test -w apps/admin -- src/lib/__tests__/upload.test.js
```

Expected: FAIL because `upload.js` does not exist.

- [ ] **Step 3: Implement the XHR helper**

Send `FormData` with field `file`, set `withCredentials = true`, publish progress from `xhr.upload.onprogress`, parse only JSON responses, and support `AbortSignal`.

- [ ] **Step 4: Write failing component tests**

Assert:

- two cards render only for `image_video`;
- accept attributes are `.jpg,.jpeg,.png` and `.mp4`;
- a successful image displays preview, dimensions and size;
- low resolution warning is visible but completion is allowed;
- failed video keeps the successful image;
- both successful assets emit `complete: true`.

- [ ] **Step 5: Implement the component**

The component must not hold video bytes after passing the `File` to XHR. Revoke object URLs on replacement and unmount. Use authenticated API URLs for persisted preview.

- [ ] **Step 6: Run tests**

```bash
npm test -w apps/admin -- src/lib/__tests__/upload.test.js src/components/__tests__/SubmissionAssetUploader.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/lib/upload.js apps/admin/src/lib/__tests__/upload.test.js apps/admin/src/components/SubmissionAssetUploader.vue apps/admin/src/components/__tests__/SubmissionAssetUploader.test.js apps/admin/src/styles/admin.css
git commit -m "feat: add submission upload progress UI"
```

### Task 7: Ordinary and Organization Registration Flows

**Files:**
- Modify: `apps/admin/src/pages/RegistrationPage.vue`
- Modify: `apps/admin/src/pages/__tests__/RegistrationPage.event-context.test.js`
- Modify: `apps/admin/src/components/OrganizationAthleteRegistrationForm.vue`
- Modify: `apps/admin/src/pages/OrganizationEventWorkspacePage.vue`
- Modify: `apps/admin/src/pages/__tests__/OrganizationEventWorkspacePage.test.js`
- Modify: `apps/admin/src/pages/RegistrationRecordsPage.vue`

**Interfaces:**
- Consumes: `selectedProject.submissionMode`
- Consumes: upload session `{ id, assets }`
- Produces: registration body `{ athlete, projectId, instructor, organizationId?, uploadSessionId? }`

- [ ] **Step 1: Add failing ordinary-user tests**

Assert:

- normal project submits without session;
- image-video project creates a session;
- submit stays disabled until both assets complete;
- body includes `uploadSessionId`;
- pending/rejected record shows replacement;
- approved record is read-only.

- [ ] **Step 2: Run and verify failure**

```bash
npm test -w apps/admin -- src/pages/__tests__/RegistrationPage.event-context.test.js
```

Expected: FAIL because there is no upload UI.

- [ ] **Step 3: Integrate uploader into ordinary registration**

Watch `form.projectId`. When switching projects:

- abort in-progress upload;
- discard local session state;
- create a new session only for `image_video`;
- preserve athlete form values;
- require `assetComplete` before submit.

After successful registration reset the session and both uploader cards.

- [ ] **Step 4: Add failing organization tests**

Assert the organization form uses the organization session endpoint, includes the session in registration body, and replaces an approved record with the visible “已恢复待审核” result.

- [ ] **Step 5: Integrate organization flow**

Pass `organizationId` through the server-derived workspace context, not a user-editable field. Records display image/video availability, preview/download and replacement.

- [ ] **Step 6: Run tests**

```bash
npm test -w apps/admin -- src/pages/__tests__/RegistrationPage.event-context.test.js src/pages/__tests__/OrganizationEventWorkspacePage.test.js
npm test -w apps/admin
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/pages/RegistrationPage.vue apps/admin/src/pages/__tests__/RegistrationPage.event-context.test.js apps/admin/src/components/OrganizationAthleteRegistrationForm.vue apps/admin/src/pages/OrganizationEventWorkspacePage.vue apps/admin/src/pages/__tests__/OrganizationEventWorkspacePage.test.js apps/admin/src/pages/RegistrationRecordsPage.vue
git commit -m "feat: require materials in user registration"
```

### Task 8: Platform Review and Private Playback

**Files:**
- Create: `apps/admin/src/components/SubmissionAssetReview.vue`
- Create: `apps/admin/src/components/__tests__/SubmissionAssetReview.test.js`
- Modify: `apps/admin/src/pages/RegistrationManagementPage.vue`
- Modify: `apps/admin/src/pages/__tests__/RegistrationManagementPage.test.js`
- Modify: `apps/admin/src/styles/admin.css`

**Interfaces:**
- Consumes: registration `submission` summary
- Produces: review drawer with preview/download/replace
- Produces: status labels “无需作品 / 待上传 / 已齐全 / 有警告 / 已清理 / 文件缺失”

- [ ] **Step 1: Write failing review component tests**

Assert:

- image uses authenticated admin preview URL;
- video uses authenticated Range-capable URL;
- metadata includes size, dimensions, duration and upload time;
- cleaned video renders “视频文件已由管理员清理” and no play button;
- warning is visible;
- download calls `apiBlob`;
- replacement emits completion and requests refreshed registration data.

- [ ] **Step 2: Run and verify failure**

```bash
npm test -w apps/admin -- src/components/__tests__/SubmissionAssetReview.test.js
```

Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement review component**

Use `<video controls preload="metadata">`. Do not put access tokens in URLs; rely on same-origin session cookies. Add explicit accessible labels for image, video, replace and download controls.

- [ ] **Step 4: Add failing registration-management tests**

Assert the table includes a materials column, opens the review component, and does not approve a required submission whose files are missing or cleaned unless the administrator explicitly keeps the historical status after cleanup.

- [ ] **Step 5: Integrate with registration management**

The approval action continues to update the existing registration status. The component only provides evidence and material operations; it must not create a second review state.

- [ ] **Step 6: Run tests**

```bash
npm test -w apps/admin -- src/components/__tests__/SubmissionAssetReview.test.js src/pages/__tests__/RegistrationManagementPage.test.js
npm test -w apps/admin
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/components/SubmissionAssetReview.vue apps/admin/src/components/__tests__/SubmissionAssetReview.test.js apps/admin/src/pages/RegistrationManagementPage.vue apps/admin/src/pages/__tests__/RegistrationManagementPage.test.js apps/admin/src/styles/admin.css
git commit -m "feat: review private submission materials"
```

### Task 9: Upload Gateway, Expiry Cleanup, and Regression

**Files:**
- Modify: `deploy/nginx.conf`
- Modify: `compose.yaml`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/services/submission-assets.js`
- Modify: `apps/api/test/public-site-deployment.test.js`
- Modify: `apps/api/test/submission-assets.test.js`
- Modify: `deploy/remote-smoke-test.sh`
- Modify: `docs/deployment/aliyun-test.md`

**Interfaces:**
- Produces: Nginx upload location for submission assets with 205MB limit
- Produces: `cleanupExpiredSubmissionSessions({ store, now })`

- [ ] **Step 1: Add failing Nginx contract tests**

```js
assert.match(nginx, /location \^~ \/api\/upload-sessions\//);
assert.match(nginx, /client_max_body_size 205m/);
assert.match(nginx, /proxy_request_buffering off/);
assert.match(nginx, /proxy_read_timeout 300s/);
```

Assert the generic `/api/` location does not inherit 205MB.

- [ ] **Step 2: Add failing expiry cleanup tests**

Create expired active, current active and committed sessions. Assert only expired active files are removed, their state becomes `expired`, and failed deletes enter `fileCleanupJournal`.

- [ ] **Step 3: Run and verify failures**

```bash
node --test apps/api/test/public-site-deployment.test.js apps/api/test/submission-assets.test.js
```

Expected: FAIL.

- [ ] **Step 4: Implement Nginx and cleanup**

Use the upload route before generic `/api/`. Start a cleanup timer in production and run one cleanup at startup. Use `unref()` so tests and shutdown are not held open.

Compose values:

```yaml
SUBMISSION_SESSION_TTL_MS: 86400000
UPLOAD_WARNING_PERCENT: 80
UPLOAD_CRITICAL_PERCENT: 90
```

- [ ] **Step 5: Extend remote smoke**

Use a small generated PNG and a short MP4 fixture to verify:

- session creation;
- image and video upload;
- registration binding;
- admin material summary;
- unauthorized private access denied.

Do not upload a 200MB file in routine smoke; cover boundary sizes in automated storage tests.

- [ ] **Step 6: Run all verification**

```bash
npm test -w apps/api
npm test -w apps/admin
npm run build
node --test apps/api/test/public-site-deployment.test.js
sh -n deploy/remote-smoke-test.sh
git diff --check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add deploy/nginx.conf compose.yaml apps/api/src/server.js apps/api/src/services/submission-assets.js apps/api/test/public-site-deployment.test.js apps/api/test/submission-assets.test.js deploy/remote-smoke-test.sh docs/deployment/aliyun-test.md
git commit -m "ops: support streamed competition uploads"
```
