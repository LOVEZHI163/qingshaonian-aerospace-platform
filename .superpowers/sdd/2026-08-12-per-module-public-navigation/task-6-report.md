# Task 6 local verification report

Date: 2026-08-12 (Asia/Shanghai)

Verified source commit: `274f9889f7afa01272cfa2c8985fa3a8d1d345ee`

Scope: Task 6 steps 1-3 only. No SSH connection, server mutation, or deployment was performed.

## Fresh automated evidence

- Web: `10` files, `196/196` tests passed on the unmodified verified commit.
- Admin: `50` files, `581/581` tests passed.
- API: `610/610` tests passed.
- Root production build exited `0` (web `55` modules, admin `122` modules).
- `git diff --check` exited `0` with no diff errors.

The web build emitted the pre-existing dynamic/static import notices for the three preview page dependencies. The admin build also retained the existing chunk-size notice. Neither warning failed the build.

## Local production browser evidence

The production web build was served locally and checked in a real Chromium browser.

- 1440 x 1000: header content width was 1200 px with equal 120 px page gutters; logo, central navigation, login, and registration controls stayed on the same header line; document scroll width equaled viewport width.
- All three desktop groups opened independently and exposed only their own approved children. Opening another group closed the former group. The two direct entries remained plain links, and account actions remained visible at the right.
- Clicking outside closed the active drawer. The pointer crossed the trigger-to-panel hover bridge without closing; leaving the group closed it after the configured delay.
- The automated interaction suite verifies click/Enter focus enters the first drawer child, Tab remains operable, Escape closes the active drawer, and focus returns to its trigger. The real-browser run additionally confirmed Escape closed the drawer and restored the correct trigger focus.
- 1024 x 800 and 768 x 800: desktop navigation was hidden, mobile brand/hamburger were visible, and document scroll width equaled viewport width.
- 390 x 844: the full approved information architecture was present in stable order; only one accordion group stayed expanded; direct links were preserved; login preceded registration; every mobile button/link measured at least 44 px high; the panel allowed vertical scrolling; document scroll width remained exactly 390 px; Escape closed the panel and restored the hamburger focus.
- Visual inspection at desktop and mobile showed the approved blue-white header, bounded desktop panel, grouped mobile accordion, and distinct secondary/primary account actions.

## Accepted limitations

- The local standalone web preview cannot reach the colocated API, so the homepage content body displayed the designed load-error fallback. Navigation behavior and layout remained fully testable and were the scope of this iteration.
- Browser automation's synthetic click focus reporting was inconsistent with the component interaction test environment (BODY/trigger versus child link). No speculative production change was retained. The committed suite remains the authoritative repeatable evidence for the click/Enter first-child focus contract, while real-browser evidence covers open/close, Escape restoration, hover, viewport, overflow, and visual behavior.

## Result

No confirmed product regression was found. The feature is locally verified for release preparation; deployment remains a separate root-agent step after review.

## Final review fix round 1

Review date: 2026-08-12 (Asia/Shanghai)

Verified base: `e9734f9face808611d2eaf0c39b761d053a10e19`. Scope remained local-only; no SSH, remote server, DNS, container, or deployment action was performed.

### Root causes and minimal fixes

1. The approved `/#services` link had no matching DOM target because `ServiceGrid` only exposed an accessible heading. The root section now owns `id="services"`, covered by an anchor/accessibility contract test.
2. The primary model still carried the superseded label “赛事简介”. The single primary navigation source now uses the approved “赛事简章” label.
3. `ABOUT_ROUTES` incorrectly grouped both `/registration-guide` and `/contact` under “关于大赛”, and direct links did not render current-page semantics. Home-flow routes now map to “首页”; `/contact` maps to the direct “联系我们” entry; desktop and mobile direct links receive `aria-current` from the same model.
4. `SiteHeader` tried to focus a drawer child in a parent layout effect before a newly opened `PublicMegaDrawer` had mounted its content. The parent timing guess was removed. The drawer now reports deterministic readiness through `focusFirstChild`/`onFocusComplete` only after its mounted DOM exists, while hover still never steals focus and Escape still restores the owning trigger.
5. `PUBLIC_NAVIGATION_GROUPS` was an unreferenced legacy export parallel to `PUBLIC_PRIMARY_NAVIGATION`. It was deleted; production source has no remaining reference and a namespace contract prevents reintroduction of the second source.

### TDD evidence

- RED: the focused command ran `49` tests with `6` intentional failures: missing services target, stale label, two incorrect route mappings/render semantics, legacy export, and newly mounted drawer focus.
- GREEN: the same focused command passed `49/49`; the dedicated drawer suite passed `17/17`, including click on a never-mounted group and Enter on a different never-mounted group, Escape, and exact trigger focus restoration.
- Fresh web full suite: `10` files, `200/200` tests passed.
- Fresh root production build: exit `0`; web transformed `55` modules and admin transformed `122` modules. Only the previously accepted mixed-import and admin chunk-size warnings remained.
- Fresh `git diff --check`: exit `0`.
- Production-source search found no `PUBLIC_NAVIGATION_GROUPS` reference; the name remains only in its negative export-contract test and historical plan text.
- Admin `581/581` and API `610/610` results from the immediately preceding local verification remain applicable because this review round changed only web source/tests and this report.

### Browser acceptance status

The earlier local production browser pass remains valid for the unchanged 1440/1024/768/390 layout, hover bridge, outside close, breakpoints, mobile accordion/order/scroll/overflow, and Escape restoration. During this review round the connected browser surface was no longer available after tab cleanup, so a fresh real-browser replay of the corrected first-child focus handshake could not be captured. No alternative browser backend was substituted. The strengthened real-behavior component test now specifically covers both fresh click and fresh Enter mount paths, rather than relying on a drawer pre-mounted by hover.
