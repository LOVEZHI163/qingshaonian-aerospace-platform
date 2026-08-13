# Rules Document Position Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the rules document card directly below the event hero without changing its links or styling.

**Architecture:** Keep the existing `model.document` data and document card component markup. Change only the render order in `EventInformationPage`, guarded by a DOM-order regression test.

**Tech Stack:** React, Vitest, Testing Library, Vite.

## Global Constraints

- The document card remains rules-only.
- PDF/DOC URLs and download filename remain unchanged.
- No visual restyling or unrelated refactoring.

---

### Task 1: Move the document card below the hero

**Files:**
- Modify: `apps/web/src/__tests__/PublicPages.test.jsx`
- Modify: `apps/web/src/pages/EventInformationPage.jsx`

**Interfaces:**
- Consumes: existing `model.document` object.
- Produces: `.event-information-document` immediately after `.event-information-hero` in DOM order.

- [ ] **Step 1: Write the failing DOM-order test**

Add an assertion that compares `Node.DOCUMENT_POSITION_FOLLOWING` between the hero, document card, and facts block.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -w apps/web -- --run src/__tests__/PublicPages.test.jsx`

Expected: FAIL because the document card currently follows the facts and section content.

- [ ] **Step 3: Move the existing document markup**

Render the unchanged `model.document` section immediately after the closing `</header>` and remove its former position below `.event-information-sections`.

- [ ] **Step 4: Run focused and full verification**

Run:

```powershell
npm test -w apps/web -- --run src/__tests__/PublicPages.test.jsx
npm test -w apps/web -- --run
npm run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit and deploy**

Commit the spec, plan, test, and component change; deploy through the existing ECS backup, release verification, and smoke-test workflow.

