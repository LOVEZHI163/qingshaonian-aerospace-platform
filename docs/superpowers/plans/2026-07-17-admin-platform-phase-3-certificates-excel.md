# AeroGP 管理平台阶段三：Excel 内嵌图片与证书管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将证书模型升级为每条报名两个证书位置，交付 Excel 内嵌图片预检查与确认导入、手动上传、修改、替换、删除和批量发布闭环。

**Architecture:** PostgreSQL 使用 `(registration_id, slot)` 唯一约束。ExcelJS 按报名编号和图片锚点解析工作簿，预检查结果及临时图片保存在 import staging；确认后才写入正式证书记录。手动上传和 Excel 导入调用同一 certificate service，所有新证书默认为 draft。

**Tech Stack:** Node.js/Express、PostgreSQL、ExcelJS、Multer、file-type、Vue 3、Vitest、Node Test Runner。

## Global Constraints

- 每条报名最多两个证书位置，`slot` 只能为 1 或 2。
- 完全取消证书编号的业务字段和界面，不再接受 ZIP 批量上传。
- Excel 只接受 `.xlsx`；内嵌图片只接受 PNG、JPG、JPEG。
- Excel 导入产生的证书一律为 `draft`，必须由管理员检查后发布。
- 手动上传接受 PDF、PNG、JPG、JPEG、WebP，单文件最大 10 MB。
- 证书替换必须在预览中明确提示；确认前不覆盖现有正式文件。
- 未发布证书仅管理员可见；已发布证书只允许对应用户、所属组织负责人和管理员访问。

---

### Task 1: 迁移为双证书位置和导入批次数据模型

**Files:**
- Create: `apps/api/src/data/migrations/003-certificate-slots-imports.sql`
- Create: `apps/api/test/certificate-schema.test.js`
- Modify: `apps/api/src/data/schema.sql`
- Modify: `apps/api/src/data/seed.js`
- Modify: `apps/api/src/data/postgres-store.js`
- Modify: `apps/api/test/postgres-store.test.js`
- Modify: `apps/api/test/certificates.test.js`

**Interfaces:**
- Produces: `certificate.slot: 1 | 2`、`certificate.title`、`certificate.source`、`certificate.importBatchId`、`certificate.cleanedAt`。
- Produces: `certificateImportBatches[]`，批次包含状态、统计、预览 JSON 和错误 JSON。
- Consumes: 现有 certificates、registrations、users、organizations。

- [ ] **Step 1: 写数据库迁移失败测试**

  `certificate-schema.test.js` 验证旧证书迁移到 slot 1、同一报名可插入 slot 2、重复 slot 被拒绝：

  ```js
  await pool.query(`
    INSERT INTO certificates
      (id, registration_id, slot, title, user_id, organization_id, file_name, stored_name, file_path,
       award_name, rank, score, status, source, uploaded_at)
    VALUES
      ('C-SLOT-2', 'R20260627001', 2, '优秀选手', 'U1001', 'O1001', 'two.png', 'two.png', '/tmp/two.png',
       '优秀选手', '', '', 'draft', 'manual', NOW())
  `);
  await assert.rejects(pool.query(`
    INSERT INTO certificates
      (id, registration_id, slot, title, file_name, stored_name, file_path, status, source, uploaded_at)
    VALUES ('C-DUP', 'R20260627001', 2, '重复', 'dup.png', 'dup.png', '/tmp/dup.png', 'draft', 'manual', NOW())
  `));
  ```

  断言 `certificate_import_batches` 和 `certificate_import_errors` 存在，`readDb().certificates` 不再要求 `certificateNo`。

  Run: `npm test -w apps/api -- --test-name-pattern="certificate schema"`

  Expected: FAIL，当前 `registration_id` 仍有单列唯一约束。

- [ ] **Step 2: 编写证书迁移 SQL**

  `003-certificate-slots-imports.sql`：

  ```sql
  ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_registration_id_key;
  ALTER TABLE certificates ALTER COLUMN certificate_no DROP NOT NULL;
  ALTER TABLE certificates ADD COLUMN IF NOT EXISTS slot SMALLINT NOT NULL DEFAULT 1;
  ALTER TABLE certificates ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '获奖证书';
  ALTER TABLE certificates ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
  ALTER TABLE certificates ADD COLUMN IF NOT EXISTS import_batch_id TEXT;
  ALTER TABLE certificates ADD COLUMN IF NOT EXISTS cleaned_at TIMESTAMPTZ;

  CREATE UNIQUE INDEX IF NOT EXISTS certificates_registration_slot_key
    ON certificates(registration_id, slot);

  CREATE TABLE IF NOT EXISTS certificate_import_batches (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id),
    original_name TEXT NOT NULL,
    status TEXT NOT NULL,
    preview_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    valid_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    replace_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    committed_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS certificate_import_errors (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES certificate_import_batches(id) ON DELETE CASCADE,
    row_number INTEGER NOT NULL,
    registration_id TEXT,
    message TEXT NOT NULL
  );
  ```

  给 `import_batch_id` 增加外键需要在批次表创建后执行。保留旧 `certificate_no` 列为 nullable 兼容迁移，但所有新代码不读写该列。

- [ ] **Step 3: 更新 store 映射和删除同步顺序**

  `readDb()` 返回两个证书位置，不再按 registration 覆盖成一个对象；`writeDb()` upsert 时写入 slot、title、source、import batch 和 cleanedAt。删除顺序为 import errors → certificates → import batches → registrations，避免外键冲突。

  `ensureDbShape()` 对旧 JSON 数据执行：

  ```js
  for (const certificate of db.certificates) {
    certificate.slot ||= 1;
    certificate.title ||= certificate.awardName || "获奖证书";
    certificate.source ||= "manual";
    certificate.importBatchId ||= null;
    certificate.cleanedAt ||= "";
  }
  db.certificateImportBatches ||= [];
  db.certificateImportErrors ||= [];
  ```

- [ ] **Step 4: 更新现有证书测试并提交**

  现有上传测试改为断言 `slot === 1` 和 `title`，批量 ZIP 测试删除，替换为“同报名可以保存两个证书”的 API 前置测试。

  Run: `npm test -w apps/api -- --test-name-pattern="certificate|PostgreSQL"`

  Expected: PASS。

  ```bash
  git add apps/api/src/data apps/api/test
  git commit -m "feat: support two certificate slots"
  ```

### Task 2: 生成证书模板并解析 Excel 内嵌图片

**Files:**
- Create: `apps/api/src/certificates/template.js`
- Create: `apps/api/src/certificates/workbook-parser.js`
- Create: `apps/api/test/certificate-workbook.test.js`
- Modify: `apps/api/src/exports/registration-workbook.js`
- Modify: `apps/api/src/routes/registrations.js`

**Interfaces:**
- Produces: `buildCertificateTemplate(rows): Promise<ExcelJS.Workbook>`。
- Produces: `parseCertificateWorkbook(buffer, registrations): Promise<{ candidates, errors }>`。
- Candidate: `{ rowNumber, registrationId, result, certificates: [{ slot, title, extension, mimeType, buffer, replacing }] }`。
- Consumes: 阶段二的 approved registration rows 和报名 workbook 样式。

- [ ] **Step 1: 写包含两张嵌入图片的 parser 失败测试**

  测试创建工作簿，报名数据在第 2 行，图片锚定 M2 和 O2：

  ```js
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const workbook = await buildCertificateTemplate([approvedRegistration]);
  const sheet = workbook.getWorksheet("证书导入");
  sheet.getCell("L2").value = "一等奖";
  sheet.getCell("N2").value = "优秀选手";
  const image1 = workbook.addImage({ buffer: onePixelPng, extension: "png" });
  const image2 = workbook.addImage({ buffer: onePixelPng, extension: "png" });
  sheet.addImage(image1, { tl: { col: 12.1, row: 1.1 }, ext: { width: 80, height: 80 } });
  sheet.addImage(image2, { tl: { col: 14.1, row: 1.1 }, ext: { width: 80, height: 80 } });
  const buffer = await workbook.xlsx.writeBuffer();

  const parsed = await parseCertificateWorkbook(buffer, [approvedRegistration]);
  assert.deepEqual(parsed.candidates[0].certificates.map((row) => [row.slot, row.title]), [[1, "一等奖"], [2, "优秀选手"]]);
  assert.equal(parsed.errors.length, 0);
  ```

  再写缺图片、有图片无名称、重复图片锚点、未知报名编号、非 approved 报名和图片放错列的错误用例。

  Run: `npm test -w apps/api -- --test-name-pattern="certificate workbook"`

  Expected: FAIL，template/parser 模块不存在。

- [ ] **Step 2: 固化模板列和样式**

  `template.js` 导出列定义：

  ```js
  export const CERTIFICATE_COLUMNS = [
    ["报名编号", "id"], ["姓名", "athlete.name"], ["学校", "athlete.school"], ["实际年级", "athlete.grade"],
    ["组别", "group"], ["赛项", "projectName"], ["指导老师", "instructor"], ["状态", "status"],
    ["奖项/等级", "awardName"], ["名次", "rank"], ["成绩/分数", "score"],
    ["证书1名称", "certificate1Title"], ["证书1图片", "certificate1Image"],
    ["证书2名称", "certificate2Title"], ["证书2图片", "certificate2Image"]
  ];
  ```

  sheet 名称固定为 `证书导入`，表头在第 1 行，数据从第 2 行开始。A–H 使用灰底，I–O 使用浅黄色；M、O 列宽 24，报名行高 90；首行冻结和筛选。模板不启用 sheet protection，以免阻止 Excel 插入图片。

- [ ] **Step 3: 实现按锚点解析图片**

  parser 只识别 M 列 slot 1、O 列 slot 2：

  ```js
  const imageColumnToSlot = new Map([[13, 1], [15, 2]]);
  const imagesByCell = new Map();
  for (const placed of sheet.getImages()) {
    const row = Math.floor(placed.range.tl.nativeRow) + 1;
    const column = Math.floor(placed.range.tl.nativeCol) + 1;
    const slot = imageColumnToSlot.get(column);
    if (!slot) {
      errors.push({ rowNumber: row, registrationId: String(sheet.getCell(row, 1).value || ""), message: "图片必须放在证书1图片或证书2图片列" });
      continue;
    }
    const asset = workbook.getImage(placed.imageId);
    const key = `${row}:${slot}`;
    if (imagesByCell.has(key)) errors.push({ rowNumber: row, message: `证书${slot}图片单元格只能放一张图片` });
    else imagesByCell.set(key, asset);
  }
  ```

  parser 限制 5,000 行、10,000 张图片和 25 MB workbook；报名匹配只使用 A 列报名编号。I–K 转为字符串保存成绩；L/M 和 N/O 必须成对出现。

- [ ] **Step 4: 暴露模板下载并提交**

  `GET /api/admin/events/:eventId/certificate-template.xlsx` 只查询该赛事 approved 报名，调用新 builder，文件名为 `赛事名称_证书导入模板.xlsx`。

  Run: `npm test -w apps/api -- --test-name-pattern="certificate workbook|registration workbook"`

  Expected: PASS。

  ```bash
  git add apps/api/src/certificates apps/api/src/exports/registration-workbook.js apps/api/src/routes/registrations.js apps/api/test/certificate-workbook.test.js
  git commit -m "feat: parse embedded certificate images"
  ```

### Task 3: 实现 Excel 预检查、确认导入和错误报告

**Files:**
- Create: `apps/api/src/routes/certificate-imports.js`
- Create: `apps/api/src/services/certificate-imports.js`
- Create: `apps/api/src/certificates/error-report.js`
- Create: `apps/api/test/certificate-imports.test.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/files/storage.js`

**Interfaces:**
- Produces: `POST /api/admin/certificate-imports/preview`、`POST /api/admin/certificate-imports/:id/commit`、`DELETE /api/admin/certificate-imports/:id`。
- Produces: `GET /api/admin/certificate-imports/:id/previews/:rowNumber/:slot` 管理员临时图片预览。
- Produces: `GET /api/admin/certificate-imports/:id/errors.xlsx`。
- Consumes: Task 2 parser、Task 1 import batch 表和 certificate slots。

- [ ] **Step 1: 写预检查与确认失败测试**

  测试上传一个有效行、一个未知报名编号；预检查后正式 certificates 数量不变；确认后仅有效行写入两个 draft 证书并更新成绩；再次预览同一文件显示两个 replacements。

  ```js
  assert.equal(preview.validCount, 1);
  assert.equal(preview.errorCount, 1);
  assert.equal(preview.replaceCount, 0);
  assert.equal(beforeConfirmCertificates.length, 0);

  assert.equal(commit.createdCount, 2);
  assert.equal(commit.replacedCount, 0);
  assert.equal(committedCertificates.every((row) => row.status === "draft"), true);
  ```

  测试普通用户访问预检查返回 403，重复 commit 返回 409，取消 preview 删除 staging 文件。

  Run: `npm test -w apps/api -- --test-name-pattern="certificate import preview"`

  Expected: FAIL。

- [ ] **Step 2: 实现 staging 和 preview batch**

  上传字段固定为 `workbook`，Multer memory limit 25 MB。解析后，把有效图片保存到 `import-staging/<batchId>/`，`preview_json` 只保存相对临时路径，不把二进制写进数据库。批次状态为 `preview`。

  响应候选项不返回文件系统路径，只返回：

  ```js
  {
    rowNumber, registrationId, athleteName, projectName,
    result: { awardName, rank, score },
    certificates: [{ slot, title, mimeType, replacing, previewUrl }]
  }
  ```

  `previewUrl` 指向受 `requireAdmin` 保护的 `/api/admin/certificate-imports/:id/previews/:rowNumber/:slot`。接口只从批次 preview JSON 解析相对路径，并验证归一化后的绝对路径仍位于该批次 staging 目录中。

- [ ] **Step 3: 实现确认导入**

  确认时重新读取批次且要求 `status === 'preview'`。对每个有效报名行：保存新正式文件 → 更新该行成绩 → upsert `(registrationId, slot)` 为 draft → 记录 replaced 旧文件。数据库写入成功后删除旧文件和 staging；失败时删除本次新文件并保持旧证书。

  批次更新为：

  ```js
  batch.status = "committed";
  batch.committedAt = now;
  batch.previewJson = [];
  ```

  同一行内成绩和两个证书必须共同成功或共同跳过。

- [ ] **Step 4: 生成可下载错误报告**

  `buildCertificateErrorReport(batch, errors)` 创建 `导入错误` sheet，列为“Excel 行号、报名编号、错误原因”。没有错误时返回 404，不生成空报告。

- [ ] **Step 5: 运行测试并提交**

  Run: `npm test -w apps/api -- --test-name-pattern="certificate import"`

  Expected: PASS。

  ```bash
  git add apps/api/src/routes/certificate-imports.js apps/api/src/services/certificate-imports.js apps/api/src/certificates/error-report.js apps/api/src/files/storage.js apps/api/src/server.js apps/api/test/certificate-imports.test.js
  git commit -m "feat: preview and commit certificate workbooks"
  ```

### Task 4: 实现手动证书 CRUD、批量发布和受控下载

**Files:**
- Create: `apps/api/src/routes/certificates.js`
- Create: `apps/api/src/services/certificates.js`
- Create: `apps/api/test/certificate-management.test.js`
- Modify: `apps/api/src/server.js`
- Modify: `apps/api/src/files/policy.js`
- Modify: `apps/api/test/certificates.test.js`

**Interfaces:**
- Produces: `POST /api/admin/registrations/:id/certificates/:slot`、`PATCH/DELETE /api/admin/certificates/:id`。
- Produces: `POST /api/admin/certificates/bulk-status`。
- Produces: `GET /api/certificates/:id/file` 和 certificate list endpoints。
- Consumes: 双 slot 数据模型、session 用户和组织 active membership。

- [ ] **Step 1: 写手动管理失败测试**

  覆盖上传 PNG 到 slot 1、上传 PDF 到 slot 2、修改标题、替换 slot 1、删除 slot 2、批量发布、批量撤回。权限断言：未登录 401、普通用户读取 draft 403、本人读取 published 200、其他普通用户 403、所属组织 active owner 200。

  Run: `npm test -w apps/api -- --test-name-pattern="manual certificate management"`

  Expected: FAIL。

- [ ] **Step 2: 实现统一 certificate service**

  service 接口固定为：

  ```js
  upsertCertificate(db, { registration, slot, title, storedFile, source, importBatchId = null, now })
  updateCertificateMetadata(db, { certificateId, title, awardName, rank, score, now })
  removeCertificate(db, certificateId)
  setCertificateStatuses(db, ids, status, now)
  ```

  `slot` 非 1/2 返回 422；title trim 后为空返回 422；批量状态只接受 `draft` 或 `published`；发布时 `publishedAt=now`，撤回时清空。

- [ ] **Step 3: 实现手动文件路由和安全替换**

  手动文件策略：

  ```js
  export const CERTIFICATE_POLICY = {
    extensions: new Set(["pdf", "png", "jpg", "jpeg", "webp"]),
    mimeTypes: new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]),
    maxBytes: 10 * 1024 * 1024
  };
  ```

  替换流程先保存新文件，数据库成功后再删除旧文件。删除证书先记录文件路径并提交数据库删除，再删除实际文件；物理删除失败写日志并由资源清理任务重试。

- [ ] **Step 4: 实现列表和下载权限**

  管理员列表返回 draft/published 全部；普通用户仅本人 published；组织负责人仅其 active 组织成员 published。下载响应设置原始 MIME 和自动文件名：

  ```js
  const downloadName = `${athlete.name}_${registration.projectName}_${certificate.title}.${extension}`;
  res.download(certificate.filePath, downloadName);
  ```

  图片预览使用 `Content-Disposition: inline`，下载使用 attachment，二者执行相同权限判断。

- [ ] **Step 5: 删除旧 ZIP 与证书编号代码并提交**

  删除 `/api/admin/certificates/batch`、`AdmZip` 依赖、`matchCertificateFile()`、`certificateNo` 请求字段和测试。若 `adm-zip` 无其他用途，运行 `npm uninstall -w apps/api adm-zip`。

  Run: `npm test -w apps/api -- --test-name-pattern="certificate"`

  Expected: PASS，`rg "certificateNo|certificates/batch|AdmZip" apps/api/src apps/api/test` 无业务代码结果。

  ```bash
  git add apps/api package-lock.json
  git commit -m "feat: manage and publish certificate files"
  ```

### Task 5: 交付 Excel 导入预览和完整证书管理页面

**Files:**
- Create: `apps/admin/src/pages/CertificateManagementPage.vue`
- Create: `apps/admin/src/components/CertificateImportPanel.vue`
- Create: `apps/admin/src/components/CertificateSlotEditor.vue`
- Create: `apps/admin/src/components/FilePreviewDialog.vue`
- Create: `apps/admin/src/pages/__tests__/CertificateManagementPage.test.js`
- Modify: `apps/admin/src/pages/RegistrationManagementPage.vue`
- Modify: `apps/admin/src/App.vue`
- Modify: `apps/admin/src/styles.css`

**Interfaces:**
- Produces: `CertificateImportPanel` emits `committed(batch)`。
- Produces: `CertificateSlotEditor` props `{ registration, certificates }`，emits `changed`。
- Consumes: Tasks 3–4 import/manual/bulk APIs。

- [ ] **Step 1: 写页面失败测试**

  测试 mock 一个 preview 批次，断言页面显示有效 1、错误 1、替换 1；“确认导入”调用 commit；选择两张 draft 后“批量发布”提交两个 ID；报名详情渲染两个 slot 且没有证书编号输入。

  ```js
  expect(wrapper.find('input[placeholder="证书编号"]').exists()).toBe(false);
  expect(wrapper.text()).toContain("证书位置 1");
  expect(wrapper.text()).toContain("证书位置 2");
  ```

  Run: `npm test -w apps/admin -- --run CertificateManagementPage`

  Expected: FAIL。

- [ ] **Step 2: 实现导入面板**

  面板限定 `.xlsx`，上传后显示批次摘要和逐行状态。有效项显示报名编号、姓名、赛项、成绩、证书标题、缩略图和“将替换”标签；错误项显示 Excel 行号和原因；有错误时提供下载错误报告。确认按钮只有 validCount > 0 时启用。

- [ ] **Step 3: 实现证书列表与批量状态**

  筛选包含赛事、draft/published、组别、赛项、姓名。每行 checkbox，批量发布请求：

  ```js
  await api("/api/admin/certificates/bulk-status", {
    method: "POST",
    body: JSON.stringify({ ids: selectedIds.value, status: "published" })
  });
  ```

  图片在对话框预览，PDF 使用浏览器嵌入预览或新标签；被清理文件显示不可下载状态。

- [ ] **Step 4: 实现报名行的两个证书编辑器**

  每个 slot 支持标题、文件、上传/替换、发布/撤回和删除。删除使用页面内确认对话框。成绩编辑保持独立三个字段并在保存后刷新证书列表。任何位置都不渲染 certificate number。

- [ ] **Step 5: 运行测试、构建并提交**

  Run: `npm test -w apps/admin`

  Run: `npm test -w apps/api`

  Run: `npm run build`

  Expected: 全部 PASS。

  ```bash
  git add apps/admin/src
  git commit -m "feat: add certificate import and management UI"
  ```

## 阶段三完成检查

Run: `npm test -w apps/api`

Run: `npm test -w apps/admin`

Run: `npm run build`

Expected: 同一报名可保存两个证书；Excel 内嵌两张图片可预检查并导入为 draft；管理员可手动上传 PDF/图片、修改、替换、删除、批量发布；ZIP 和证书编号入口完全消失。
