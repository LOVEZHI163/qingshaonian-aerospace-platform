# Registration Guide and Auth Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove obsolete registration-guide sections and make password/SMS login actions consistent, full-width, responsive, and regression-tested.

**Architecture:** Treat the static registration guide and Vue authentication layout as two independent presentation slices with no API or database change. Use structural component tests and public deployment tests to lock the requested content and control placement, then include the result in the combined team-registration production release.

**Tech Stack:** Static HTML/CSS, Vue 3, Vitest, Vue Test Utils, Node test runner, Vite.

**Spec:** `docs/superpowers/specs/2026-08-31-registration-guide-auth-layout-design.md`

## Global Constraints

- Remove the complete guide table of contents, reading-note section, and terminology section.
- Renumber the remaining guide sections to start at one.
- Do not change registration availability, account permissions, SMS behavior, password recovery APIs, or other guide body content.
- Password and SMS login primary actions are full width and vertically consistent.
- “忘记密码？” sits below the password input and aligns right.
- Test-account credentials remain absent.
- This plan does not deploy independently; Task 8 of `docs/superpowers/plans/2026-08-31-team-registration.md` performs the combined release.

---

### Task 1: Remove obsolete guide blocks and renumber the remainder

**Files:**
- Modify: `apps/web/public/registration-flow/index.html`
- Modify: `apps/api/test/public-site-deployment.test.js`

**Interfaces:**
- Produces: embedded and standalone guide HTML with section IDs retained only for the two remaining sections.

- [ ] **Step 1: Replace positive obsolete-content assertions with the requested contract**

```js
assert.doesNotMatch(guide, /class="guide-toc"/);
assert.doesNotMatch(guide, /id="reading-note"/);
assert.doesNotMatch(guide, /id="terms"/);
assert.doesNotMatch(guide, /阅读前提示|名词概念介绍/);
assert.match(guide, /一、操作前注意事项/);
assert.match(guide, /二、账号注册流程操作说明/);
```

- [ ] **Step 2: Run the focused deployment test and observe obsolete content**

Run: `npm test --prefix apps/api -- --test-name-pattern="registration guide"`

Expected: FAIL because the current document still contains the TOC and both removed sections.

- [ ] **Step 3: Delete the requested HTML and unused CSS**

Remove the entire `<nav class="guide-toc">…</nav>`, `<section id="reading-note">…</section>`, and `<section id="terms">…</section>` blocks. Remove `.guide-toc` rules that have no remaining consumer. Change only the two remaining heading strings:

```html
<h2>一、操作前注意事项</h2>
<h2>二、账号注册流程操作说明</h2>
```

Keep download controls, embedding behavior, document metadata, and all content inside the remaining sections unchanged.

- [ ] **Step 4: Run public-site tests**

Run: `npm test --prefix apps/api -- --test-name-pattern="public site|registration guide"`

Expected: PASS.

- [ ] **Step 5: Commit the guide slice**

```bash
git add apps/web/public/registration-flow/index.html apps/api/test/public-site-deployment.test.js
git commit -m "fix: simplify registration guide"
```

---

### Task 2: Align password and SMS login actions

**Files:**
- Modify: `apps/admin/src/pages/AuthPage.vue`
- Modify: `apps/admin/src/styles/admin.css`
- Modify: `apps/admin/src/pages/__tests__/AuthPage.test.js`

**Interfaces:**
- Produces: `.auth-login-actions`, `.auth-login-primary`, and `.auth-forgot-row` layout hooks shared by both login modes.

- [ ] **Step 1: Write failing structural tests**

For password mode assert the password input is followed by a right-aligned forgot row and then a full-width submit action. Switch to SMS mode and assert the same `.auth-login-primary` class exists while the forgot row is absent.

```js
expect(wrapper.get("[data-testid='password-login-form'] .auth-forgot-row").text()).toContain("忘记密码？");
expect(wrapper.get("[data-testid='password-login-form'] .auth-login-primary").attributes("type")).toBe("submit");
await wrapper.get("[data-auth-mode='sms']").trigger("click");
expect(wrapper.get("[data-testid='sms-login-form'] .auth-login-primary").exists()).toBe(true);
expect(wrapper.find("[data-testid='sms-login-form'] .auth-forgot-row").exists()).toBe(false);
```

- [ ] **Step 2: Run the focused test and observe missing layout hooks**

Run: `npm test --prefix apps/admin -- AuthPage.test.js`

Expected: FAIL because current buttons and forgot-password control do not use the new structure.

- [ ] **Step 3: Refactor both forms without changing handlers**

Password form structure:

```vue
<label>密码<input v-model="loginForm.password" type="password" autocomplete="current-password" required /></label>
<div class="auth-forgot-row"><button type="button" class="link-button" @click="openPasswordReset">忘记密码？</button></div>
<div class="auth-login-actions"><button type="submit" class="primary auth-login-primary">登录</button></div>
```

SMS form retains its phone/code and code-request controls, then uses:

```vue
<div class="auth-login-actions"><button type="submit" class="primary auth-login-primary">登录</button></div>
```

Do not rename request handlers, state fields, data-test hooks used by SMS tests, or submit events.

- [ ] **Step 4: Add responsive styles**

```css
.auth-forgot-row { display: flex; justify-content: flex-end; margin-top: -.25rem; }
.auth-login-actions { display: grid; width: 100%; margin-top: .25rem; }
.auth-login-primary { width: 100%; min-height: 44px; margin: 0; }
@media (max-width: 640px) {
  .auth-login-actions, .auth-login-primary { width: 100%; }
}
```

Remove older selectors that impose a narrow intrinsic width or a conflicting margin on the login submit buttons.

- [ ] **Step 5: Run authentication and SMS UI tests**

Run: `npm test --prefix apps/admin -- AuthPage.test.js`

Run: `npm test --prefix apps/admin -- --runInBand`

Expected: PASS, including password login, SMS login, password reset and registration flows.

- [ ] **Step 6: Commit the auth layout slice**

```bash
git add apps/admin/src/pages/AuthPage.vue apps/admin/src/styles/admin.css apps/admin/src/pages/__tests__/AuthPage.test.js
git commit -m "fix: align authentication actions"
```

---

### Task 3: Build and prepare combined-release evidence

**Files:**
- Modify: `docs/deployment/releases/2026-08-31-team-registration.md` after the file is created by the companion plan.

**Interfaces:**
- Consumes: Tasks 1–2 and the team-registration plan.
- Produces: UI verification evidence for the combined release task.

- [ ] **Step 1: Run static and management regressions**

Run:

```bash
npm test --prefix apps/api -- --test-name-pattern="public site|registration guide"
npm test --prefix apps/admin
npm run build
```

Expected: all commands PASS.

- [ ] **Step 2: Perform local viewport checks**

Open the built registration guide in embedded and standalone forms and the auth page at desktop and 390px mobile widths. Verify the removed blocks are absent, headings start at one, password forgot action is right-aligned, both login buttons span the form, and SMS code controls do not overflow.

- [ ] **Step 3: Record evidence for the combined release**

Add a UI verification section to `docs/deployment/releases/2026-08-31-team-registration.md` containing the test commands, build result, four viewport cases, and the final reviewed commit SHA. Do not include screenshots containing phone numbers, passwords, SMS codes, or identity values.

- [ ] **Step 4: Commit the verification note with the companion release task**

The final release-document commit is owned by Task 8 of the team-registration plan so the repository records one deployment SHA and one backup path.

## Self-Review Result

- Spec coverage: all three removals, both renumbered headings, password forgot placement, consistent full-width login actions, responsive behavior, regression tests and combined release evidence map to explicit tasks.
- Placeholder scan: every edit, assertion, command and expected outcome is concrete.
- Type consistency: the shared CSS hooks `.auth-login-actions`, `.auth-login-primary`, and `.auth-forgot-row` are identical in plan steps and tests.
