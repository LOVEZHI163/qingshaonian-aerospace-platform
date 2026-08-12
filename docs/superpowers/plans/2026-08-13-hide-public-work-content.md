# Hide Public Work Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every public “优秀作品” entry and prevent public rendering of work-type content while preserving all admin and database functionality.

**Architecture:** Collapse the public news list to one `news` stream and normalize legacy list URLs to that stream. Add a presentation-layer guard to the public detail page so `work` rows use the existing not-found view; do not change the API schema or admin content model.

**Tech Stack:** React, Vitest, Testing Library, Vite, existing public-site API client.

## Global Constraints

- Keep the admin `work` type, filters, editing workflow, history, and database records unchanged.
- Do not migrate, delete, or unpublish existing content.
- Old `type=work`, duplicate, empty, and invalid public news query values must render news and must not request work data.
- Preserve valid `event` and pagination context when normalizing public list behavior.

---

### Task 1: Collapse the public news list to news only

**Files:**
- Modify: `apps/web/src/pages/ContentListPage.jsx`
- Modify: `apps/web/src/router.js`
- Test: `apps/web/src/__tests__/PublicPages.test.jsx`
- Test: `apps/web/src/__tests__/router.test.jsx`
- Test: `apps/web/src/__tests__/Accessibility.test.jsx`

**Interfaces:**
- Consumes: `parsePublicListLocation(location)` and `publicContentListPath(type, page, event)`.
- Produces: `/news` with one heading, one news request, no tabs, and legacy query normalization to news.

- [ ] **Step 1: Write failing tests**

Add assertions that `/news` has heading `新闻动态`, contains no `优秀作品` tab or copy, requests only `type=news`, and treats `?type=work&event=E1` as E1 news.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- --run src/__tests__/PublicPages.test.jsx src/__tests__/router.test.jsx src/__tests__/Accessibility.test.jsx`

Expected: FAIL because the current page renders a work tab, uses the combined heading, and requests `type=work`.

- [ ] **Step 3: Implement the minimal list change**

Make the news page use only `news`, remove tab state and keyboard switching code, update heading/SEO/empty copy, and ensure pagination propagates the normalized news type only where needed.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the focused command from Step 2 and expect all tests to pass.

- [ ] **Step 5: Commit**

Commit the list, router, copy, and test changes together as `fix(web): hide work content from public news`.

### Task 2: Block public work detail rendering

**Files:**
- Modify: `apps/web/src/pages/ContentDetailPage.jsx`
- Modify: `apps/web/src/App.jsx`
- Test: `apps/web/src/__tests__/PublicPages.test.jsx`
- Test: `apps/web/src/__tests__/Accessibility.test.jsx`

**Interfaces:**
- Consumes: public content detail payload `{ row: { type } }`.
- Produces: the existing `ContentNotFound` presentation for `row.type === "work"`.

- [ ] **Step 1: Write the failing detail test**

Add a public detail fixture with `type: "work"`; assert `内容不存在` is shown and the work title/body are absent. Update default public SEO copy expectations so they mention notifications and news only.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- --run src/__tests__/PublicPages.test.jsx src/__tests__/Accessibility.test.jsx`

Expected: FAIL because a published work row currently renders normally and old default copy still names work content.

- [ ] **Step 3: Implement the minimal detail guard and copy updates**

Return `ContentNotFound` when the successful public payload is a work row. Remove “优秀作品” from default home and detail descriptions without changing API or admin labels.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the focused command from Step 2 and expect all tests to pass.

- [ ] **Step 5: Commit**

Commit as `fix(web): block public work detail pages`.

### Task 3: Verify and deploy

**Files:**
- Verify only; no planned product edits.

**Interfaces:**
- Consumes: the completed public web build.
- Produces: a healthy production release with unchanged admin work management.

- [ ] **Step 1: Run full verification**

Run web full tests, repository build, and `git diff --check`. Confirm zero failures.

- [ ] **Step 2: Browser verification**

At desktop and mobile widths, verify `/`, `/news`, and `/news?type=work&event=wz-aerospace-2026`: no “优秀作品”, no horizontal overflow, and news remains usable. Verify a known work detail fixture through automated coverage.

- [ ] **Step 3: Verify admin preservation**

Run the focused admin content-type tests and confirm the “优秀作品” option remains present.

- [ ] **Step 4: Deploy safely**

Create database/uploads/source backups, build the web image, update services with health waiting, write the release marker, and retain rollback tags.

- [ ] **Step 5: Run remote smoke verification**

Run release consistency and remote smoke tests; verify home, public news, admin, API version, and container health before reporting completion.
