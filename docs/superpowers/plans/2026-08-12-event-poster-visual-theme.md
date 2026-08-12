# Event Poster Visual Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the supplied 2026 event poster as the current event hero, preserve its full composition, reveal registration actions on desktop hover/focus, keep actions visible below the poster on mobile, and align the public-site palette with the poster.

**Architecture:** Keep the poster in the existing event public-profile media pipeline so future administrators can replace it without a code deployment. Refactor only the public `FeaturedEvent` presentation and shared CSS tokens; event selection, registration permissions, public APIs, and admin information architecture remain unchanged.

**Tech Stack:** React 18, CSS custom properties and media queries, Vitest/Testing Library, existing Node/Express media API, Docker Compose/Caddy deployment.

## Global Constraints

- Preserve the complete 1549 × 466 poster with `object-fit: contain`; do not crop or stretch it.
- Desktop reveals the action layer on hover and `:focus-within`; mobile always shows the copy and actions below the poster.
- Use `#07185E`, `#155ADD`, `#6E35E7`, and restrained `#E84ED1`; retain white and pale-blue reading surfaces.
- Keep all touch targets at least 44 pixels high and remove transitions for `prefers-reduced-motion: reduce`.
- Do not change event visibility, multi-event selection, registration authorization, or the admin theme.
- Store the supplied image through the existing event-hero media API, not as a temporary filesystem reference in application code.

---

### Task 1: Accessible poster-first featured event

**Files:**
- Modify: `apps/web/src/components/FeaturedEvent.jsx`
- Test: `apps/web/src/__tests__/HomePage.test.jsx`

**Interfaces:**
- Consumes: existing public event shape `{ id, slug, name, theme, slogan, hero, registrationWindow }`.
- Produces: `.featured-event-poster`, `.featured-event-interaction`, `.featured-event-mobile-copy`, and unchanged registration/detail href behavior.

- [ ] **Step 1: Write the failing component tests**

Add assertions to the active-event homepage test:

```jsx
const poster = screen.getByRole("group", { name: "E1 动态赛事名称赛事操作" });
expect(poster).toHaveClass("featured-event-poster");
expect(within(poster).getByRole("link", { name: "立即报名" })).toHaveAttribute(
  "href", "/admin/?view=registration&eventId=E1"
);
expect(within(poster).getByRole("link", { name: "了解赛事" })).toHaveAttribute(
  "href", "/events/event-e1"
);
expect(screen.getByTestId("featured-event-mobile-copy")).toBeInTheDocument();
```

Retain existing tests for responsive `<picture>`, missing media, history mode, and protected preview media.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -w apps/web -- --run src/__tests__/HomePage.test.jsx`

Expected: FAIL because the poster group and mobile copy do not exist.

- [ ] **Step 3: Implement the poster-first structure**

Refactor `FeaturedEvent` so the media and desktop interaction copy share a focusable group, while the mobile copy repeats the actionable content outside the image container. Keep a single helper for action links so labels and hrefs cannot diverge. Do not render duplicate element IDs.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -w apps/web -- --run src/__tests__/HomePage.test.jsx`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/FeaturedEvent.jsx apps/web/src/__tests__/HomePage.test.jsx
git commit -m "feat(web): add accessible poster hero interactions"
```

### Task 2: Poster-matched public visual system

**Files:**
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/src/styles/home.css`
- Modify: `apps/web/src/styles/navigation.css`
- Modify: `apps/web/src/styles/content.css`
- Modify: `apps/web/src/styles/event-information.css`
- Test: `apps/web/src/__tests__/Accessibility.test.jsx`
- Test: `apps/web/src/__tests__/BuildClean.test.js`

**Interfaces:**
- Consumes: Task 1 class names.
- Produces: shared public tokens `--color-brand`, `--color-brand-deep`, `--color-brand-accent`, and responsive hero layout.

- [ ] **Step 1: Write failing style-contract tests**

Read the CSS files in the existing static style tests and assert:

```js
expect(tokens).toMatch(/--color-brand:\s*#155add/i);
expect(tokens).toMatch(/--color-brand-deep:\s*#07185e/i);
expect(tokens).toMatch(/--color-brand-accent:\s*#6e35e7/i);
expect(homeStyles).toMatch(/\.featured-event-media img\s*\{[^}]*object-fit:\s*contain/);
expect(homeStyles).toMatch(/\.featured-event-poster:hover[\s\S]*\.featured-event-interaction/);
expect(homeStyles).toMatch(/\.featured-event-poster:focus-within[\s\S]*\.featured-event-interaction/);
expect(homeStyles).toMatch(/@media\s*\(hover:\s*none\)[\s\S]*\.featured-event-mobile-copy/);
expect(homeStyles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*transition:\s*none/);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -w apps/web -- --run src/__tests__/Accessibility.test.jsx src/__tests__/BuildClean.test.js`

Expected: FAIL on old tokens, cover cropping, and absent interaction/mobile contracts.

- [ ] **Step 3: Implement the visual system**

Update public tokens and gradients. Make the homepage hero height follow the poster aspect ratio, use contain rendering, hide the desktop interaction layer until hover/focus, and display fixed mobile copy at `max-width: 640px` or `hover: none`. Add a restrained purple accent to navigation and public page heroes, keeping body/card surfaces pale or white.

- [ ] **Step 4: Run focused and full web tests**

Run:

```bash
npm test -w apps/web -- --run src/__tests__/Accessibility.test.jsx src/__tests__/BuildClean.test.js
npm test -w apps/web -- --run
```

Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/styles apps/web/src/__tests__/Accessibility.test.jsx apps/web/src/__tests__/BuildClean.test.js
git commit -m "style(web): align public theme with event poster"
```

### Task 3: Production build and responsive verification

**Files:**
- Modify only if a verified regression requires it: files from Tasks 1–2 and their tests.
- Document evidence in the deployment handoff; no new production interface.

**Interfaces:**
- Consumes: completed poster component and CSS contracts.
- Produces: verified production bundle for desktop, tablet, and mobile.

- [ ] **Step 1: Run production verification**

Run:

```bash
npm test -w apps/web -- --run
npm run build -w apps/web
git diff --check
```

Expected: tests pass, Vite exits 0, and diff check is clean.

- [ ] **Step 2: Verify real browser behavior**

At 1440, 1024, 768, and 390 pixels verify: full uncropped poster; hover/focus layer on desktop; always-visible mobile copy; 44-pixel buttons; no horizontal overflow; registration/detail hrefs; reduced-motion compatibility.

- [ ] **Step 3: Fix any verified regression with a new RED/GREEN cycle**

For each regression, first add a failing assertion to the nearest existing test, run it to confirm RED, apply the smallest fix, and rerun the focused and full web suites.

- [ ] **Step 4: Commit verification-only fixes if present**

```bash
git add apps/web
git commit -m "fix(web): harden responsive poster presentation"
```

### Task 4: Upload poster, bind current event, and deploy

**Files:**
- Runtime media input: `C:/Users/xiang/AppData/Local/Temp/codex-clipboard-80bccbcd-9ebf-4dbb-94d2-37292160a56e.png`
- Runtime deployment: `/opt/aerogp`

**Interfaces:**
- Consumes: admin login endpoint, `POST /api/admin/site-media` with purpose `event-hero`, and `PUT /api/admin/event-public-profiles/:eventId`.
- Produces: current event profile referencing the uploaded poster media ID and deployed release SHA.

- [ ] **Step 1: Back up production**

Create fresh database, uploads, and source backups using existing deployment scripts. Record rollback paths before mutation.

- [ ] **Step 2: Upload and bind the poster**

Authenticate as the platform administrator, upload the PNG with `purpose=event-hero`, read the current `wz-aerospace-2026` public profile, and update only `heroMediaId` plus the required current `version`. Confirm the response retains slug, visibility, display order, slogan, and summary.

- [ ] **Step 3: Deploy the exact Git archive**

Archive the verified commit, copy it to the server, preserve `.env` and backups, set `RELEASE_SHA`, build/recreate web and API for version consistency, and wait for healthy containers.

- [ ] **Step 4: Verify production**

Run release consistency, HTTPS health, public bootstrap media URL, container health, and live browser checks. Confirm the poster is complete and the desktop/mobile interactions match the approved design.

- [ ] **Step 5: Write `.release` and retain rollback references**

Write the release SHA only after every production check passes. Do not delete the previous media or backups.

