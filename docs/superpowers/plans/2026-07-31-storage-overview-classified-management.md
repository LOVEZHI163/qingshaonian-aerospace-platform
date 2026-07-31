# Server Overview and Classified Storage Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在赛事管理平台概览显示真实服务器与磁盘状态，并让平台管理员按分类筛选、批量下载和批量清理作品、证书、官网媒体、组织资质及临时文件。

**Architecture:** API 从上传卷 `statfs`、系统内存、数据库和只读备份目录获取实时状态；统一资产目录服务把不同业务表映射为不含磁盘路径的安全视图。批量下载直接流式生成 ZIP，批量清理先校验分类资格并更新数据库，再删除实体文件和写审计/重试日志。

**Tech Stack:** Node.js 22、Express 4、PostgreSQL 16、Archiver、Node streams、Vue 3、Vitest、Node test runner、Docker Compose、Nginx

**Execution Order:** 这是第 3 阶段；开始前必须完成 `2026-07-31-image-video-submissions.md`，并复用其中已建立的 `system-storage.js` 磁盘阈值和视频上传保护。

## Global Constraints

- 概览必须显示 API、数据库、文件存储、磁盘总量/已用/剩余/使用率和系统内存。
- 磁盘 80% 黄色预警，90% 红色预警。
- 分类固定为作画视频、作品图片、证书文件、官网图片及附件、组织资质文件、临时上传和失败残留。
- 图片和视频必须分开管理、分开选择、分开下载和清理。
- 批量下载不得先在上传卷生成同等体积的完整压缩包。
- 单批过大时必须自动拆分多个下载批次。
- 批量清理只需要一次明确确认，不要求勾选声明或输入报名编号。
- 清理保留元数据、关联业务、审核结果和审计记录，实体文件状态显示“已清理”。
- 当前组织资质和仍被官网引用的媒体不可清理。
- 物理删除失败写入 `file_cleanup_journal`，不得回滚已经提交的数据库状态。
- 只有平台管理员能访问系统概览、批量下载和清理。

---

## File Structure

- Modify: `apps/api/src/services/system-storage.js` — 扩展既有磁盘保护，增加内存、备份时间和服务分级状态。
- Modify: `apps/api/test/system-storage.test.js`
- Create: `apps/api/src/services/storage-assets.js` — 分类目录、筛选、资格和安全记录解析。
- Create: `apps/api/test/storage-assets.test.js`
- Create: `apps/api/src/services/storage-downloads.js` — 批次规划和流式 ZIP。
- Create: `apps/api/test/storage-downloads.test.js`
- Create: `apps/api/src/services/storage-cleanup.js` — 分类清理、审计和重试。
- Create: `apps/api/test/storage-cleanup.test.js`
- Create: `apps/api/src/routes/storage-management.js` — 管理员 API。
- Modify: `apps/api/src/server.js` — 挂载路由。
- Modify: `apps/api/package.json` and `package-lock.json` — 固定 Archiver 依赖。
- Modify: `compose.yaml` — API 只读挂载备份目录并设置 `BACKUP_ROOT`。
- Create: `apps/admin/src/components/ServerStorageOverview.vue`
- Create: `apps/admin/src/components/__tests__/ServerStorageOverview.test.js`
- Create: `apps/admin/src/components/StorageAssetManager.vue`
- Create: `apps/admin/src/components/__tests__/StorageAssetManager.test.js`
- Modify: `apps/admin/src/pages/DashboardPage.vue`
- Modify: `apps/admin/src/pages/__tests__/DashboardPage.test.js`
- Modify: `apps/admin/src/lib/download.js`
- Modify: `apps/admin/src/lib/__tests__/download.test.js`
- Modify: `apps/admin/src/styles/admin.css`
- Modify: `apps/api/test/authorization.test.js`
- Modify: `apps/api/test/deployment-paths.test.js`
- Modify: `deploy/remote-smoke-test.sh`
- Modify: `docs/deployment/aliyun-test.md`

### Task 1: Extend the System and Disk Status Service

**Files:**
- Modify: `apps/api/src/services/system-storage.js`
- Modify: `apps/api/test/system-storage.test.js`
- Create: `apps/api/src/routes/storage-management.js`
- Modify: `apps/api/src/server.js`
- Modify: `compose.yaml`
- Modify: `apps/api/test/deployment-paths.test.js`

**Interfaces:**
- Extends: `readStorageStatus({ uploadRoot, backupRoot, fileSystem, osModule, clock })`
- Preserves: `assertVideoUploadCapacity(status, incomingBytes)` from the image-video submissions plan
- Produces: `GET /api/admin/system/storage-summary`

- [ ] **Step 1: Write failing service tests**

Inject `statfs` and `os`:

```js
const status = await readStorageStatus({
  uploadRoot: "/uploads",
  backupRoot: "/backups",
  fileSystem: {
    statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: 150, bavail: 120 }),
    access: async () => {},
    readdir: async () => []
  },
  osModule: { totalmem: () => 2_000, freemem: () => 500 }
});

assert.equal(status.disk.totalBytes, 4_096_000);
assert.equal(status.disk.usedPercent, 85);
assert.equal(status.level, "warning");
assert.equal(status.memory.usedBytes, 1_500);
```

Keep the existing exact boundary tests for 79.99 → normal, 80 → warning, 90 → critical. Add memory, backup timestamp and storage-health assertions without changing the upload guard contract.

- [ ] **Step 2: Run and verify failure**

```bash
node --test apps/api/test/system-storage.test.js
```

Expected: FAIL because the existing service does not yet expose memory, backup and service-health fields.

- [ ] **Step 3: Implement real filesystem calculations**

```js
const totalBytes = Number(stats.blocks) * Number(stats.bsize);
const availableBytes = Number(stats.bavail) * Number(stats.bsize);
const usedBytes = totalBytes - Number(stats.bfree) * Number(stats.bsize);
const usedPercent = totalBytes ? Number(((usedBytes / totalBytes) * 100).toFixed(2)) : 0;
const level = usedPercent >= criticalPercent ? "critical"
  : usedPercent >= warningPercent ? "warning"
    : "normal";
```

Return only capacity and status data, never filesystem paths.

Backup metadata must list files from the read-only `BACKUP_ROOT`, select the newest PostgreSQL dump and uploads archive by modification time, and return timestamps/names only.

- [ ] **Step 4: Add failing route authorization test**

Assert unauthenticated and ordinary users receive 401/403, while admin receives:

```js
{
  services: { api: "healthy", database: "healthy", storage: "healthy" },
  disk: { totalBytes, usedBytes, availableBytes, usedPercent },
  memory: { totalBytes, usedBytes, availableBytes, usedPercent },
  level: "normal",
  backups: { database: null, uploads: null }
}
```

- [ ] **Step 5: Implement the route**

The route already proves API and database access by reaching an authenticated store-backed handler. Use `fs.access(UPLOAD_ROOT, fs.constants.R_OK | fs.constants.W_OK)` for storage state. A backup listing error sets backup status to unavailable but does not turn the entire API into 500.

- [ ] **Step 6: Mount backups read-only**

Compose:

```yaml
api:
  environment:
    BACKUP_ROOT: /data/backups
    UPLOAD_WARNING_PERCENT: 80
    UPLOAD_CRITICAL_PERCENT: 90
  volumes:
    - uploads_data:/data/uploads
    - ./backups:/data/backups:ro
```

Add static tests requiring `:ro`.

- [ ] **Step 7: Run tests**

```bash
node --test apps/api/test/system-storage.test.js apps/api/test/authorization.test.js apps/api/test/deployment-paths.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/system-storage.js apps/api/test/system-storage.test.js apps/api/src/routes/storage-management.js apps/api/src/server.js compose.yaml apps/api/test/deployment-paths.test.js apps/api/test/authorization.test.js
git commit -m "feat: extend admin storage health"
```

### Task 2: Classified Asset Inventory

**Files:**
- Create: `apps/api/src/services/storage-assets.js`
- Create: `apps/api/test/storage-assets.test.js`
- Modify: `apps/api/src/routes/storage-management.js`

**Interfaces:**
- Produces: `STORAGE_CATEGORIES`
- Produces: `listStorageAssets(db, filters) -> { rows, total, page, pageSize, categorySummary }`
- Produces: `resolveStorageAsset(db, category, id)`
- Produces: `GET /api/admin/storage-assets`

- [ ] **Step 1: Write failing classification tests**

Create one record in each source array and assert mappings:

```js
assert.deepEqual(rows.map((row) => row.category), [
  "submission_video",
  "submission_image",
  "certificate",
  "site_media",
  "organization_credential",
  "temporary"
]);
```

Each public row contains:

```js
{
  id, category, eventId, eventName, projectId, projectName,
  registrationId, athleteName, organizationId, organizationName,
  originalName, mimeType, sizeBytes, uploadedAt, cleanedAt,
  cleanupEligible, cleanupBlockedReason
}
```

Assert `filePath` and `storedName` are absent.

- [ ] **Step 2: Add eligibility tests**

Exact rules:

- active submission image/video: eligible;
- cleaned asset: not eligible again;
- published certificate: eligible with warning `清理后用户无法下载已发布证书`;
- referenced site media: blocked;
- unreferenced site media: eligible;
- current active organization credential: blocked;
- replaced organization credential: eligible;
- active unexpired upload session: blocked;
- expired or failed upload session: eligible.

- [ ] **Step 3: Run and verify failure**

```bash
node --test apps/api/test/storage-assets.test.js
```

Expected: FAIL because the service does not exist.

- [ ] **Step 4: Implement category adapters**

Use one adapter per source type:

```js
const adapters = {
  submission_video: submissionAssetAdapter("creation_video"),
  submission_image: submissionAssetAdapter("artwork_image"),
  certificate: certificateAdapter,
  site_media: siteMediaAdapter,
  organization_credential: organizationDocumentAdapter,
  temporary: temporaryAssetAdapter
};
```

Each adapter supplies:

- `list(db)`
- `publicRow(db, record)`
- `cleanupEligibility(db, record)`
- `physicalFiles(record)` for internal use only

- [ ] **Step 5: Implement filters and pagination**

Support:

```text
category, eventId, projectId, status, cleaned, uploadedFrom, uploadedTo, page, pageSize
```

Require exactly one category per request. Sort newest first and cap page size at 100.

- [ ] **Step 6: Add route tests and implement route**

Assert invalid/mixed category input returns 422. Route returns category summaries with effective bytes excluding cleaned files.

- [ ] **Step 7: Run tests**

```bash
node --test apps/api/test/storage-assets.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/storage-assets.js apps/api/test/storage-assets.test.js apps/api/src/routes/storage-management.js
git commit -m "feat: classify managed storage assets"
```

### Task 3: Safe Batch Download Planning and Streaming ZIP

**Files:**
- Create: `apps/api/src/services/storage-downloads.js`
- Create: `apps/api/test/storage-downloads.test.js`
- Modify: `apps/api/src/routes/storage-management.js`
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `planDownloadBatches(db, { category, assetIds, maxBytes, maxFiles })`
- Produces: `streamStorageArchive({ db, category, assetIds, output })`
- Produces: `POST /api/admin/storage-assets/batch-download-plan`
- Produces: `POST /api/admin/storage-assets/batch-download`

- [ ] **Step 1: Install a pinned ZIP streaming dependency**

```bash
npm install -w apps/api archiver@7.0.1
```

Verify only `apps/api/package.json` and root `package-lock.json` change.

- [ ] **Step 2: Write failing batch-plan tests**

With sizes 60, 60, 40 and `maxBytes=100`, assert:

```js
assert.deepEqual(plan.batches.map((batch) => batch.assetIds), [
  ["A1"],
  ["A2", "A3"]
]);
```

Also assert:

- duplicate IDs are rejected;
- mixed categories are rejected;
- cleaned or missing files appear in `excluded`;
- a single file above max size receives its own batch instead of disappearing;
- maximum 100 files per batch.

- [ ] **Step 3: Run and verify failure**

```bash
node --test apps/api/test/storage-downloads.test.js
```

Expected: FAIL because the service does not exist.

- [ ] **Step 4: Implement deterministic planning**

Preserve requested selection order, deduplicate before planning and return:

```js
{
  batches: [
    { index: 1, assetIds: ["A1"], fileCount: 1, totalBytes: 60 }
  ],
  excluded: [
    { id: "A9", reason: "实体文件已清理" }
  ]
}
```

- [ ] **Step 5: Write failing ZIP tests**

Stream into a temporary output file and inspect the archive. Assert it contains:

```text
2026温州赛/绘画赛/R001_张三/作品图片_原文件名.png
清单.csv
```

Assert entry names remove `..`, slashes, control characters and Windows-reserved separators.

- [ ] **Step 6: Implement ZIP streaming**

Use `archiver("zip", { zlib: { level: 0 } })` because MP4/JPEG/PNG/PDF are already compressed. Append each file with `fs.createReadStream(realPath)`. Do not write a temporary ZIP under `UPLOAD_ROOT`.

Generate `清单.csv` in memory from safe metadata only. Escape CSV values by doubling quotes.

- [ ] **Step 7: Implement POST download route**

The route revalidates category and every asset ID, sets safe `Content-Disposition`, then pipes the archive to the response. If validation fails, do so before writing headers.

- [ ] **Step 8: Run tests**

```bash
node --test apps/api/test/storage-downloads.test.js
npm test -w apps/api
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/storage-downloads.js apps/api/test/storage-downloads.test.js apps/api/src/routes/storage-management.js apps/api/package.json package-lock.json
git commit -m "feat: stream classified asset downloads"
```

### Task 4: Classified Batch Cleanup

**Files:**
- Create: `apps/api/src/services/storage-cleanup.js`
- Create: `apps/api/test/storage-cleanup.test.js`
- Modify: `apps/api/src/routes/storage-management.js`
- Modify: `apps/api/src/services/storage-assets.js`

**Interfaces:**
- Produces: `previewStorageCleanup(db, { category, assetIds })`
- Produces: `executeStorageCleanup({ store, category, assetIds, actor, now, makeId })`
- Produces: `POST /api/admin/storage-assets/batch-cleanup/preview`
- Produces: `POST /api/admin/storage-assets/batch-cleanup`

- [ ] **Step 1: Write failing preview tests**

Assert response:

```js
{
  category: "submission_video",
  fileCount: 3,
  totalBytes: 500_000_000,
  registrationCount: 3,
  eventCount: 1,
  warnings: [],
  blocked: []
}
```

For current organization credential or referenced site media, assert the item appears under `blocked` and cannot be submitted.

- [ ] **Step 2: Write failing cleanup tests**

Assert:

- submission video gets `cleanedAt` and retains all metadata;
- registration status and result remain unchanged;
- certificate record remains and download becomes unavailable;
- unreferenced site media record becomes cleaned;
- expired temporary session becomes expired;
- audit log contains category, count and released bytes;
- physical delete failure writes `fileCleanupJournal`;
- retrying already cleaned IDs is idempotent.

- [ ] **Step 3: Run and verify failure**

```bash
node --test apps/api/test/storage-cleanup.test.js
```

Expected: FAIL because the service does not exist.

- [ ] **Step 4: Implement database-first cleanup**

Inside the mutation lock:

1. resolve all IDs from the chosen category;
2. reject any blocked item;
3. mark each record cleaned or expired;
4. write one summary audit log plus per-record target data where needed;
5. persist the database;
6. after commit, delete physical paths using adapter-owned records;
7. append cleanup journal records for failures in a second database write.

Never accept a request-provided file path.

- [ ] **Step 5: Implement cleanup routes**

Body:

```json
{
  "category": "submission_video",
  "assetIds": ["SA1", "SA2"]
}
```

Return:

```js
{
  cleanedCount,
  releasedBytes,
  failedFiles: [{ id, reason }],
  storageStatus
}
```

- [ ] **Step 6: Run tests**

```bash
node --test apps/api/test/storage-cleanup.test.js apps/api/test/storage-assets.test.js
npm test -w apps/api
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/storage-cleanup.js apps/api/test/storage-cleanup.test.js apps/api/src/routes/storage-management.js apps/api/src/services/storage-assets.js
git commit -m "feat: clean assets by protected category"
```

### Task 5: Server Storage Overview UI

**Files:**
- Create: `apps/admin/src/components/ServerStorageOverview.vue`
- Create: `apps/admin/src/components/__tests__/ServerStorageOverview.test.js`
- Modify: `apps/admin/src/pages/DashboardPage.vue`
- Modify: `apps/admin/src/pages/__tests__/DashboardPage.test.js`
- Modify: `apps/admin/src/styles/admin.css`

**Interfaces:**
- Consumes: `GET /api/admin/system/storage-summary`
- Emits: `manage(category)`
- Produces: normal/warning/critical overview cards

- [ ] **Step 1: Write failing component tests**

Assert:

- total/used/remaining bytes render in readable units;
- 79% uses normal class;
- 80% uses warning copy “磁盘空间偏高”;
- 90% uses critical copy “磁盘空间严重不足，已暂停新视频上传”;
- API/database/storage states render separately;
- backup timestamps and last cleanup render;
- each category card shows count/bytes and emits its category.

- [ ] **Step 2: Run and verify failure**

```bash
npm test -w apps/admin -- src/components/__tests__/ServerStorageOverview.test.js
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the component**

Use semantic progress markup:

```html
<progress :value="summary.disk.usedPercent" max="100">
  {{ summary.disk.usedPercent }}%
</progress>
```

Do not derive warning state in CSS alone; use the API `level` and show text.

- [ ] **Step 4: Add Dashboard integration test**

Assert storage summary loads even when no event is selected. Existing event dashboard data remains event-scoped.

- [ ] **Step 5: Integrate into Dashboard**

Load `/api/admin/system/storage-summary` independently from `/api/admin/dashboard?eventId=...`. Render storage errors in the storage panel without hiding normal event counts.

- [ ] **Step 6: Run tests**

```bash
npm test -w apps/admin -- src/components/__tests__/ServerStorageOverview.test.js src/pages/__tests__/DashboardPage.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/components/ServerStorageOverview.vue apps/admin/src/components/__tests__/ServerStorageOverview.test.js apps/admin/src/pages/DashboardPage.vue apps/admin/src/pages/__tests__/DashboardPage.test.js apps/admin/src/styles/admin.css
git commit -m "feat: show server storage overview"
```

### Task 6: Classified Asset Manager UI

**Files:**
- Create: `apps/admin/src/components/StorageAssetManager.vue`
- Create: `apps/admin/src/components/__tests__/StorageAssetManager.test.js`
- Modify: `apps/admin/src/pages/DashboardPage.vue`
- Modify: `apps/admin/src/lib/download.js`
- Modify: `apps/admin/src/lib/__tests__/download.test.js`
- Modify: `apps/admin/src/styles/admin.css`

**Interfaces:**
- Consumes: storage-assets list, plan, download and cleanup endpoints
- Produces: category-only selection state
- Produces: streamed POST blob downloads

- [ ] **Step 1: Extend the download helper test**

Add:

```js
const blob = await apiBlob("/api/admin/storage-assets/batch-download", {
  method: "POST",
  body: JSON.stringify({ category: "submission_video", assetIds: ["SA1"] }),
  headers: { "Content-Type": "application/json" }
});
downloads.save(blob, blob.fileName);
```

Assert the helper respects response `fileName` and revokes object URLs after save.

- [ ] **Step 2: Write failing manager tests**

Assert:

- selecting “作画视频” never includes image rows;
- switching category clears selection;
- filters send event/project/status/cleaned/page;
- cleaned rows cannot be selected for download or cleanup;
- batch plan renders multiple batch buttons when split;
- cleanup opens one summary dialog and uses one “确认清理” button;
- no checkbox declaration and no typed registration field exist;
- successful cleanup refreshes both list and storage summary.

- [ ] **Step 3: Run and verify failure**

```bash
npm test -w apps/admin -- src/components/__tests__/StorageAssetManager.test.js src/lib/__tests__/download.test.js
```

Expected: FAIL.

- [ ] **Step 4: Implement category navigation and filters**

Category labels:

```js
[
  ["submission_video", "作画视频"],
  ["submission_image", "作品图片"],
  ["certificate", "证书文件"],
  ["site_media", "官网图片及附件"],
  ["organization_credential", "组织资质文件"],
  ["temporary", "临时上传和失败残留"]
]
```

Selection is a `Set` scoped to the active category.

- [ ] **Step 5: Implement multi-batch download**

Call plan endpoint once, render each returned batch with file count and size, then download batches sequentially only after the administrator clicks the corresponding download button. Do not automatically trigger many browser downloads without user action.

- [ ] **Step 6: Implement one-confirmation cleanup**

Preview first, show file count, bytes, registrations/events and warnings. The confirmation button text must be:

```text
确认清理 N 个文件
```

Do not add a declaration checkbox or typed confirmation input.

- [ ] **Step 7: Integrate with Dashboard**

The overview category card opens the manager below the overview and scrolls it into view. Preserve the selected event as an optional initial filter, but allow global “全部赛事”.

- [ ] **Step 8: Run tests**

```bash
npm test -w apps/admin -- src/components/__tests__/StorageAssetManager.test.js src/pages/__tests__/DashboardPage.test.js src/lib/__tests__/download.test.js
npm test -w apps/admin
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/admin/src/components/StorageAssetManager.vue apps/admin/src/components/__tests__/StorageAssetManager.test.js apps/admin/src/pages/DashboardPage.vue apps/admin/src/lib/download.js apps/admin/src/lib/__tests__/download.test.js apps/admin/src/styles/admin.css
git commit -m "feat: manage storage by file category"
```

### Task 7: Full Verification and Production Deployment

**Files:**
- Modify: `deploy/remote-smoke-test.sh`
- Modify: `docs/deployment/aliyun-test.md`

**Interfaces:**
- Consumes: completed release-consistency and image-video plans
- Produces: deployed, verified server overview and storage manager

- [ ] **Step 1: Add storage smoke checks**

Authenticated smoke must verify:

- storage summary returns disk, memory, service and category data;
- ordinary session receives 403;
- category list never contains `filePath` or `storedName`;
- cleanup preview rejects mixed categories;
- a test temporary file can be cleaned without touching a committed registration.

- [ ] **Step 2: Run complete local verification**

```bash
npm test -w apps/api
npm test -w apps/admin
npm run build
node --test apps/api/test/deployment-paths.test.js apps/api/test/public-site-deployment.test.js
sh -n deploy/verify-release.sh
sh -n deploy/remote-smoke-test.sh
git diff --check
```

Expected: PASS.

- [ ] **Step 3: Verify database and uploads backups**

```bash
ssh aerogp 'cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-postgres.sh once'
ssh aerogp 'cd /opt/aerogp && docker compose run --rm --no-deps -T backup /bin/sh /scripts/backup-uploads.sh once'
ssh aerogp 'cd /opt/aerogp && /bin/sh deploy/preflight-admin-upgrade.sh'
```

Expected: dump and archive readable, enough disk remains, four services healthy.

- [ ] **Step 4: Preserve rollback images and source**

Tag current API/Web images with a timestamp and create a source archive excluding `.env`, `backups` and named volumes. Record tags in a mode-0600 rollback stamp.

- [ ] **Step 5: Transfer and build the exact commit**

Set:

```bash
RELEASE_SHA="$(git rev-parse HEAD)"
```

Transfer `git archive "$RELEASE_SHA"` to a staging path, switch `/opt/aerogp` source without deleting `.env` or backups, then:

```bash
docker compose build --pull api web
docker compose up -d --no-deps --wait --wait-timeout 300 api web
```

- [ ] **Step 6: Run migrations and verify services**

Use the existing migration runner through the API image before accepting traffic if the current startup path does not already run migrations. Verify:

```bash
docker compose ps
docker compose logs --tail=150 api web postgres backup
```

Expected: all services healthy, no ffprobe or migration errors.

- [ ] **Step 7: Run release and business smoke**

```bash
EXPECTED_RELEASE="$RELEASE_SHA" BASE_URL=http://127.0.0.1 sh deploy/verify-release.sh
ADMIN_TEST_PASSWORD='<temporary-test-password>' BASE_URL=http://127.0.0.1 sh deploy/remote-smoke-test.sh
```

Then manually verify:

- create/edit image-video project;
- ordinary image/video upload and submission;
- organization replacement resets approved registration to pending;
- admin image preview and Range video playback;
- storage overview warning style with test-injected thresholds in non-production test;
- separate image/video categories;
- batch ZIP contains files and `清单.csv`;
- one-confirmation cleanup retains metadata and updates disk stats.

- [ ] **Step 8: Write release marker only after all checks**

```bash
printf '%s\n' "$RELEASE_SHA" > /opt/aerogp/.release
```

- [ ] **Step 9: Record deployment evidence**

Append:

- release SHA;
- API/Web asset identity;
- database and uploads backup names;
- rollback image tags;
- migration result;
- four-service health;
- smoke summary;
- storage counts and disk status;
- confirmation that no volume was deleted.

- [ ] **Step 10: Commit deployment record**

```bash
git add deploy/remote-smoke-test.sh docs/deployment/aliyun-test.md
git commit -m "docs: record submission storage deployment"
```
