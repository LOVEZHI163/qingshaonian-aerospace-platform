# Registration Guide Document Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy illustrated registration-flow HTML with the complete responsive content of `注册指南(1).docx` and publish `注册指南(1).pptx` as a direct download.

**Architecture:** Keep the existing public `/registration-guide` React page and its same-origin `/registration-flow/?embed=1` iframe contract. Replace only the static registration-flow document and assets: semantic HTML derived from DOCX, 10 ordered PNG images extracted from the DOCX relationships, and one downloadable PPTX file. Preserve the existing embed height synchronization through `embed.js`.

**Tech Stack:** React 18/Vite public site shell, static HTML/CSS/JavaScript in `apps/web/public`, Node.js built-in test runner, Docker Compose deployment to the existing ECS host.

## Global Constraints

- The webpage body source is `注册指南(1).docx`; do not mix in legacy guide copy.
- Preserve all non-empty source paragraphs and all 10 document images in document order.
- Do not render the Word automatic table-of-contents dot leaders, page numbers, isolated page number `0`, or layout placeholders.
- Publish the PPTX with download name `温州市青少年航空航天创新比赛注册指南.pptx`.
- Keep `/registration-guide?event=...` and `/registration-flow/?embed=1` URLs compatible.
- Do not change registration, login, organization review, permissions, SMS, or submission business logic.
- Desktop and mobile must not show horizontal overflow or nested iframe scrollbars.
- Do not stage or modify the user's unrelated deleted QA screenshots or untracked `大赛介绍.rtf`.

---

## File Structure

- Modify `apps/api/test/public-site-deployment.test.js`: define the production contract for the new guide HTML, 10 images, PPTX download, and legacy asset removal.
- Modify `apps/web/public/registration-flow/index.html`: render the semantic document, table of contents, responsive styles, ordered figures, and PPT download action.
- Keep `apps/web/public/registration-flow/embed.js`: retain embedded-mode detection and parent-frame height compatibility.
- Create `apps/web/public/registration-flow/registration-guide-01.png` through `registration-guide-10.png`: ordered DOCX image assets.
- Create `apps/web/public/registration-flow/温州市青少年航空航天创新比赛注册指南.pptx`: direct download resource.
- Delete the six legacy assets `00-registration-flow-overview.png`, `01-entry.png`, `02-register-account.png`, `03-login.png`, `04-submit-registration.png`, and `05-registration-records.png` after the new contract is green.

---

### Task 1: Lock the New Static Guide Contract

**Files:**
- Modify: `apps/api/test/public-site-deployment.test.js:98-122`
- Test: `apps/api/test/public-site-deployment.test.js`

**Interfaces:**
- Consumes: the existing `read(relativePath)` helper and `root` path in the deployment test.
- Produces: an automated contract requiring semantic guide headings, 10 ordered image files, one PPTX download, and no legacy flow copy.

- [ ] **Step 1: Replace the legacy registration-guide assertions with a failing new contract**

Use this test body in place of the current registration-guide test:

```js
test("registration guide embeds the complete document and publishes its PPT download", async () => {
  const nginx = await read("deploy/nginx.conf");
  const guideDir = path.join(root, "apps/web/public/registration-flow");
  const guideHtml = await fs.readFile(path.join(guideDir, "index.html"), "utf8");
  const embedScript = await fs.readFile(path.join(guideDir, "embed.js"), "utf8");
  const imageNames = Array.from(
    { length: 10 },
    (_, index) => `registration-guide-${String(index + 1).padStart(2, "0")}.png`
  );
  const pptName = "温州市青少年航空航天创新比赛注册指南.pptx";

  assert.doesNotMatch(nginx, /location = \/registration-guide\s*\{/);
  assert.match(guideHtml, /<script src="embed\.js" defer><\/script>/);
  assert.match(guideHtml, /body\.embedded > header[\s\S]*display: none/);
  assert.match(guideHtml, /body\.embedded main[\s\S]*width: 100%/);
  assert.match(embedScript, /URLSearchParams\(window\.location\.search\)/);
  assert.match(embedScript, /classList\.add\("embedded"\)/);

  for (const heading of [
    "赛事用户管理系统",
    "阅读前提示",
    "一、名词概念介绍",
    "二、操作前注意事项",
    "三、账号注册流程操作说明"
  ]) {
    assert.match(guideHtml, new RegExp(heading));
  }
  assert.doesNotMatch(guideHtml, /第一块：注册登录流程/);
  assert.doesNotMatch(guideHtml, /第二块：正式报名流程/);
  assert.match(
    guideHtml,
    new RegExp(`href="${pptName}"[\\s\\S]*download="${pptName}"`)
  );

  let previousIndex = -1;
  for (const imageName of imageNames) {
    const token = `src="${imageName}"`;
    const currentIndex = guideHtml.indexOf(token);
    assert.ok(currentIndex > previousIndex, `${imageName} must occur in document order`);
    assert.equal(
      guideHtml.split(token).length - 1,
      1,
      `${imageName} must occur exactly once`
    );
    previousIndex = currentIndex;
  }

  await Promise.all([
    ...imageNames.map((name) => fs.access(path.join(guideDir, name))),
    fs.access(path.join(guideDir, pptName))
  ]);

  for (const legacyName of [
    "00-registration-flow-overview.png",
    "01-entry.png",
    "02-register-account.png",
    "03-login.png",
    "04-submit-registration.png",
    "05-registration-records.png"
  ]) {
    await assert.rejects(fs.access(path.join(guideDir, legacyName)));
  }
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run:

```powershell
node --test --test-name-pattern="registration guide embeds" apps/api/test/public-site-deployment.test.js
```

Expected: FAIL because the new document headings, ordered `registration-guide-*.png` files, and PPTX download do not exist yet.

---

### Task 2: Extract and Publish the Approved Document Assets

**Files:**
- Create: `apps/web/public/registration-flow/registration-guide-01.png`
- Create: `apps/web/public/registration-flow/registration-guide-02.png`
- Create: `apps/web/public/registration-flow/registration-guide-03.png`
- Create: `apps/web/public/registration-flow/registration-guide-04.png`
- Create: `apps/web/public/registration-flow/registration-guide-05.png`
- Create: `apps/web/public/registration-flow/registration-guide-06.png`
- Create: `apps/web/public/registration-flow/registration-guide-07.png`
- Create: `apps/web/public/registration-flow/registration-guide-08.png`
- Create: `apps/web/public/registration-flow/registration-guide-09.png`
- Create: `apps/web/public/registration-flow/registration-guide-10.png`
- Create: `apps/web/public/registration-flow/温州市青少年航空航天创新比赛注册指南.pptx`

**Interfaces:**
- Consumes: DOCX relationship order `rId10`, `rId12`, `rId13`, `rId14`, `rId15`, `rId16`, `rId17`, `rId19`, `rId20`, `rId21` from `注册指南(1).docx`.
- Produces: ten sequential PNG URLs and one same-origin PPTX download URL for Task 3.

- [ ] **Step 1: Extract the ten DOCX media relationships in document order**

Run the following with the bundled Python runtime. It resolves image relationships instead of trusting ZIP filename order:

```powershell
$env:PYTHONIOENCODING = "utf-8"
& "C:\Users\xiang\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -c 'from pathlib import Path; from docx import Document; source=Document("注册指南(1).docx"); target=Path("apps/web/public/registration-flow"); images=[]
for paragraph in source.paragraphs:
    for run in paragraph.runs:
        for blip in run._element.xpath(".//a:blip"):
            rid=blip.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed")
            images.append(source.part.related_parts[rid].blob)
assert len(images)==10, f"expected 10 DOCX images, found {len(images)}"
for index, blob in enumerate(images, 1):
    (target / f"registration-guide-{index:02d}.png").write_bytes(blob)'
```

Expected: ten PNG files are created, each non-empty and ordered by appearance in the document XML.

- [ ] **Step 2: Copy the PPTX to its public download name**

Run:

```powershell
Copy-Item -LiteralPath "注册指南(1).pptx" -Destination "apps\web\public\registration-flow\温州市青少年航空航天创新比赛注册指南.pptx"
```

Expected: the public PPTX exists and its byte length matches the source file.

- [ ] **Step 3: Verify the asset counts and file sizes**

Run:

```powershell
Get-ChildItem "apps\web\public\registration-flow\registration-guide-*.png" | Select-Object Name,Length
Get-Item "注册指南(1).pptx","apps\web\public\registration-flow\温州市青少年航空航天创新比赛注册指南.pptx" | Select-Object Name,Length
```

Expected: exactly ten non-empty PNGs; source and published PPTX lengths are both `3687080` bytes.

---

### Task 3: Replace the Legacy Flow with Responsive Document HTML

**Files:**
- Modify: `apps/web/public/registration-flow/index.html`
- Keep: `apps/web/public/registration-flow/embed.js`
- Delete: `apps/web/public/registration-flow/00-registration-flow-overview.png`
- Delete: `apps/web/public/registration-flow/01-entry.png`
- Delete: `apps/web/public/registration-flow/02-register-account.png`
- Delete: `apps/web/public/registration-flow/03-login.png`
- Delete: `apps/web/public/registration-flow/04-submit-registration.png`
- Delete: `apps/web/public/registration-flow/05-registration-records.png`
- Test: `apps/api/test/public-site-deployment.test.js`

**Interfaces:**
- Consumes: `/registration-flow/registration-guide-01.png` through `registration-guide-10.png`, and `/registration-flow/温州市青少年航空航天创新比赛注册指南.pptx`.
- Produces: the same-origin embeddable document consumed by `EventInformationPage` at `/registration-flow/?embed=1`.

- [ ] **Step 1: Replace the HTML shell and migrate every approved DOCX block**

Keep `<script src="embed.js" defer></script>`. Build one `article.guide-document` containing, in this exact top-level order:

1. `header.guide-cover` with the source title `2026年温州市青少年航空航天创新比赛`, document name `赛事用户管理系统`, subtitle `使用说明文档（市级选拔赛报名阶段）`, source compilation unit/date/login URL, and the PPT download link.
2. `nav.guide-toc[aria-label="注册指南目录"]` linking to `#reading-note`, `#terms`, `#before-you-start`, and `#account-registration`.
3. `section#reading-note.guide-section` beginning with `阅读前提示` and containing every following non-empty source paragraph up to the next major heading.
4. `section#terms.guide-section` beginning with `一、名词概念介绍` and containing every following non-empty source paragraph up to the next major heading.
5. `section#before-you-start.guide-section` beginning with `二、操作前注意事项` and containing every following non-empty source paragraph up to the next major heading.
6. `section#account-registration.guide-section` beginning with `三、账号注册流程操作说明`; preserve the source subheadings `（一）负责人账号注册流程` and `（二）个人账号注册`, all their numbered steps, cautions, and explanatory paragraphs.

Transcribe the paragraphs verbatim from `注册指南(1).docx`; do not summarize, rewrite, or reuse any sentence from the legacy HTML. Ignore only Word's generated directory entries, dot leaders/page numbers, isolated page number `0`, and empty layout paragraphs. Insert the ten figures at the paragraph anchors defined in Step 2.

The cover download action must be exactly:

```html
<a
  class="download-guide"
  href="温州市青少年航空航天创新比赛注册指南.pptx"
  download="温州市青少年航空航天创新比赛注册指南.pptx"
>下载 PPT 图文指南</a>
```

Use a valid document shell with `lang="zh-CN"`, UTF-8 metadata, viewport metadata, the existing `embed.js`, and no external stylesheet or script dependency.

Use CSS with these exact behavior contracts:

```css
body { margin: 0; overflow-x: hidden; color: #102445; background: transparent; }
body.embedded > .standalone-header { display: none; }
body.embedded main { width: 100%; margin: 0; }
.guide-document { display: grid; gap: 1.25rem; width: min(100%, 72rem); margin: 0 auto; }
.guide-cover, .guide-toc, .guide-section { border: 1px solid #d9e5f5; border-radius: 1rem; background: #fff; }
.guide-cover, .guide-section { padding: clamp(1.1rem, 3vw, 2rem); }
.guide-toc { display: flex; flex-wrap: wrap; gap: .75rem; padding: 1rem; }
.guide-figure { margin: 1.25rem 0; }
.guide-figure img { display: block; width: 100%; height: auto; border-radius: .75rem; }
.download-guide { display: inline-flex; min-height: 2.75rem; align-items: center; }
@media (max-width: 760px) {
  .guide-document { gap: .9rem; }
  .guide-toc { display: grid; grid-template-columns: 1fr; }
  .guide-cover, .guide-section { padding: 1rem; border-radius: .8rem; }
}
```

- [ ] **Step 2: Place all ten figures at their DOCX anchor positions**

Use this sequential figure contract; do not group the images into a gallery:

```html
<figure class="guide-figure"><img src="registration-guide-01.png" alt="负责人账号注册流程示意图 1" /></figure>
<figure class="guide-figure"><img src="registration-guide-02.png" alt="负责人账号注册流程示意图 2" /></figure>
<figure class="guide-figure"><img src="registration-guide-03.png" alt="负责人账号注册流程示意图 3" /></figure>
<figure class="guide-figure"><img src="registration-guide-04.png" alt="负责人账号注册流程示意图 4" /></figure>
<figure class="guide-figure"><img src="registration-guide-05.png" alt="负责人账号注册流程示意图 5" /></figure>
<figure class="guide-figure"><img src="registration-guide-06.png" alt="负责人账号注册流程示意图 6" /></figure>
<figure class="guide-figure"><img src="registration-guide-07.png" alt="个人账号注册流程示意图 1" /></figure>
<figure class="guide-figure"><img src="registration-guide-08.png" alt="个人账号注册流程示意图 2" /></figure>
<figure class="guide-figure"><img src="registration-guide-09.png" alt="个人账号注册流程示意图 3" /></figure>
<figure class="guide-figure"><img src="registration-guide-10.png" alt="个人账号注册流程示意图 4" /></figure>
```

- [ ] **Step 3: Delete all six legacy flow images**

Run with literal paths:

```powershell
Remove-Item -LiteralPath @(
  "apps\web\public\registration-flow\00-registration-flow-overview.png",
  "apps\web\public\registration-flow\01-entry.png",
  "apps\web\public\registration-flow\02-register-account.png",
  "apps\web\public\registration-flow\03-login.png",
  "apps\web\public\registration-flow\04-submit-registration.png",
  "apps\web\public\registration-flow\05-registration-records.png"
)
```

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="registration guide embeds" apps/api/test/public-site-deployment.test.js
```

Expected: PASS with zero failures.

- [ ] **Step 5: Review the document order against the source**

Run a DOCX paragraph/image relationship dump and compare it with the HTML source order:

```powershell
$env:PYTHONIOENCODING = "utf-8"
& "C:\Users\xiang\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -c 'from docx import Document; d=Document("注册指南(1).docx");
for p in d.paragraphs:
    if p.text.strip(): print("TEXT", p.text.strip())
    for run in p.runs:
        for blip in run._element.xpath(".//a:blip"): print("IMAGE", blip.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed"))'
```

Expected: all meaningful `TEXT` rows occur in the HTML under the same major section; all 10 `IMAGE` rows occur once in the same relative order.

- [ ] **Step 6: Commit the guide implementation**

Stage only the test and registration-flow assets:

```powershell
git add -- "apps/api/test/public-site-deployment.test.js" "apps/web/public/registration-flow"
git commit -m "feat: publish document-based registration guide"
```

---

### Task 4: Full Verification and Responsive Browser Check

**Files:**
- Verify: `apps/api/test/public-site-deployment.test.js`
- Verify: `apps/web/src/__tests__/PublicPages.test.jsx`
- Verify: `apps/web/public/registration-flow/index.html`

**Interfaces:**
- Consumes: the completed static guide and existing public-page iframe.
- Produces: evidence that the full project, desktop rendering, mobile rendering, and download resource work before deployment.

- [ ] **Step 1: Run the API test suite**

```powershell
npm test -w apps/api
```

Expected: all API tests pass with zero failures.

- [ ] **Step 2: Run the Web test suite**

```powershell
npm test -w apps/web -- --run
```

Expected: all Web tests pass with zero failures.

- [ ] **Step 3: Run the production Web build**

```powershell
npm run build -w apps/web
```

Expected: Vite exits `0`, and `apps/web/dist/registration-flow/` contains the HTML, ten PNGs, `embed.js`, and the PPTX.

- [ ] **Step 4: Verify desktop rendering in the in-app browser**

Open the local or deployed `/registration-guide?event=wz-aerospace-2026`, then verify:

- the existing event hero remains above the iframe;
- the guide cover, four table-of-contents links, complete text, and ten images are visible;
- the PPT download link has the expected filename;
- the iframe has no internal vertical scrollbar.

- [ ] **Step 5: Verify mobile rendering at 653 × 912**

Use the browser viewport capability and verify:

- the guide is one column;
- no horizontal overflow exists (`document.documentElement.scrollWidth === document.documentElement.clientWidth`);
- all document images fit within their section;
- table-of-contents links and the download button remain usable.

Reset the viewport override after verification.

---

### Task 5: Deploy and Verify the ECS Release

**Files:**
- Deploy: the committed paths from Task 3
- Verify: `/opt/aerogp/.release`, `/api/system/version`, Docker Compose health

**Interfaces:**
- Consumes: the committed guide implementation and existing SSH alias `aerogp`.
- Produces: a healthy production release at `https://aerogp.cn/registration-guide?event=wz-aerospace-2026`.

- [ ] **Step 1: Record the release SHA and create a scoped archive**

```powershell
$releaseSha = (git rev-parse HEAD).Trim()
New-Item -ItemType Directory -Force ".codex-tmp" | Out-Null
tar -czf ".codex-tmp\registration-guide-$($releaseSha.Substring(0,7)).tar.gz" `
  "apps/api/test/public-site-deployment.test.js" `
  "apps/web/public/registration-flow"
```

- [ ] **Step 2: Transfer the archive and create a server backup**

```powershell
$archive = ".codex-tmp\registration-guide-$($releaseSha.Substring(0,7)).tar.gz"
scp $archive "aerogp:/tmp/registration-guide.tar.gz"
ssh aerogp "set -eu; stamp=\$(date +%Y%m%d-%H%M%S); mkdir -p /opt/aerogp-backups/\$stamp-registration-guide; cp -a /opt/aerogp/apps/web/public/registration-flow /opt/aerogp-backups/\$stamp-registration-guide/; cp /opt/aerogp/.env /opt/aerogp-backups/\$stamp-registration-guide/.env"
```

- [ ] **Step 3: Extract files, update `RELEASE_SHA`, and rebuild API/Web**

```powershell
ssh aerogp "set -eu; cd /opt/aerogp; tar -xzf /tmp/registration-guide.tar.gz; sed -i 's/^RELEASE_SHA=.*/RELEASE_SHA=$releaseSha/' .env; docker compose build api web; docker compose up -d --no-deps --wait --wait-timeout 240 api web; printf '%s\n' '$releaseSha' > .release; rm -f /tmp/registration-guide.tar.gz"
```

- [ ] **Step 4: Verify release consistency and health**

```powershell
ssh aerogp "cd /opt/aerogp && EXPECTED_RELEASE=$releaseSha BASE_URL=https://aerogp.cn bash ./deploy/verify-release.sh && curl -fsS https://aerogp.cn/api/system/version && docker compose ps"
```

Expected:

- `release-consistency=$releaseSha`;
- API JSON contains the same 40-character SHA;
- `api`, `web`, `postgres`, and `backup` are healthy;
- `caddy` is running.

- [ ] **Step 5: Verify the production page and download**

Use the in-app browser on the production registration-guide URL and repeat the desktop/mobile checks from Task 4. Confirm the PPT URL returns HTTP `200` and `Content-Length: 3687080`.

- [ ] **Step 6: Confirm repository scope**

```powershell
git status --short
git log -3 --oneline
```

Expected: only the user's pre-existing deleted QA screenshots and untracked source documents remain; no implementation file is left unstaged.
