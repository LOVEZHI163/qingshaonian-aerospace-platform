# Task 8：平台审核与私有作品播放交付报告

## 交付内容

- 新增管理员作品审核抽屉：通过同源 Cookie 的管理员私有 URL 预览图片和支持 Range 的视频；视频使用 `controls` 与 `preload="metadata"`。
- 审核抽屉展示文件名、大小、尺寸、时长、上传时间与建议警告；已清理或读取失败的材料明确显示状态，并移除播放和下载控件。
- 下载统一使用 `apiBlob`；管理员替换使用专属上传会话、保留部分替换后的续传能力，并通过请求代次防止关闭/切换后的迟到响应继续写入界面。
- 报名管理增加“作品材料”列和审核抽屉入口，覆盖无需作品、待上传、已齐全、有警告、已清理、文件缺失状态。
- 必传材料未齐全、已清理或缺失时，前端和服务端均拒绝直接通过报名；已清理且原本已经通过的记录仅可由管理员明确确认保留历史审核状态，不会发起新的通过请求。
- 补齐管理员上传会话端点，且上传会话由创建它的管理员使用；保留现有私有读取、替换审计和状态回退模型。
- 补充 Task 5 Minor 覆盖：普通待审核报名可替换、普通已通过报名被拒绝替换、管理员列表材料摘要不泄露 `filePath` / `storedName`。

## TDD 记录

1. `SubmissionAssetReview` 缺失时，组件测试按预期解析失败。
2. 管理员上传会话端点缺失时，API 测试按预期返回 404。
3. 必传且已清理/缺失的材料可直接通过时，API 测试按预期返回 200（RED）；实现服务端拦截后变为 422（GREEN）。

## 验证

- `npm test -w apps/admin -- src/components/__tests__/SubmissionAssetReview.test.js`：6/6 通过。
- `npm test -w apps/admin`：39 个测试文件、379 个测试通过。
- `npm test -w apps/api`：393 个测试通过。
- `npm run build -w apps/admin`：通过；Vite 仍报告既有主 bundle 大于 500 kB 的体积提示，不影响构建成功。
- `git diff --check`：通过。

## 修复轮次 1：安全审查补强

- 上传会话增加持久化 `channel`；管理员替换仅接受当前管理员本人创建、`channel=admin` 且未关联组织的活跃会话，个人、组织和其他管理员会话均不会被消费。
- 管理员列表和审批前都会验证当前未清理素材实体对应的受控文件：必须位于 `submission-assets/<assetId>/<storedName>`、为普通文件且不经过符号链接；实际缺失时返回安全摘要和 `422`，不泄露存储路径。
- 审核抽屉替换成功后将响应中的报名记录按 ID 同步回父列表和已打开抽屉，立即更新状态、元数据和警告，随后后台刷新列表。
- 新旧 PostgreSQL 数据库均兼容 009 迁移：新 schema 跳过已存在列，旧 schema 正常补列。

### TDD 记录

1. 管理员能盗用个人、组织及其他管理员上传会话的新增测试先失败（错误返回 200）；补齐 `channel` 持久化和严格来源校验后均为 403，来源未被消费。
2. 实体存在但磁盘文件不存在时，列表仍显示 `complete: true`、审批返回 200；补齐受控路径、常规文件和符号链接检查后，列表标记缺失且审批返回 422。
3. 审核抽屉替换后，父页面测试中的已打开记录不更新；向 `refresh` 传递响应报名记录并按 ID 替换后，抽屉立刻呈现新状态和警告。

### 验证

- `node --test apps/api/test/submission-storage.test.js apps/api/test/submission-assets.test.js apps/api/test/submission-authorization.test.js apps/api/test/postgres-store.test.js`：通过。
- `npm test -w apps/api`：397/397 通过。
- `npm test -w apps/admin`：39 个测试文件、380 个测试通过。
- `npm run build -w apps/admin`：通过；仍有既有主 bundle 超过 500 kB 的 Vite 提示。
