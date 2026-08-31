# Task 7 Report: Issue Certificates to Team Participants

## RED

- Added API workbook, parser, service, import, manual-upload, and organization-history tests before production changes.
- Ran `npm test --prefix apps/api -- --test-name-pattern="certificate.*participant|team certificate"`.
- Observed 6 intended failures: team registrations did not flatten into participant targets, parser targeting was registration-only, the second participant replaced the first participant's slot 1, imports rejected two participant rows as duplicate registrations, manual team upload accepted a missing/foreign participant, and organization history omitted participant metadata.
- Added UI tests before UI changes and ran `npm test --prefix apps/admin -- Certificate` plus the focused manual-upload API test. Observed the intended failures: no participant selector, multipart upload omitted `participantId`, organization history omitted team/participant display, import preview showed only the legacy athlete, and participant-filtered certificate listing returned both participants.

## GREEN

- Approved team registrations now expand to one certificate target per stored participant, while personal registrations keep one legacy target.
- The workbook adds read-only `证书对象编号`; parsing keys rows by `registrationId:participantId-or-legacy`, validates participant ownership, and scopes replacement checks to participant plus slot.
- Manual and imported certificates persist `participantId`, permit slot 1 independently for each team participant, and keep award/rank/score propagation at registration level.
- New files use participant-safe private paths under `certificates/<registration>/<participant-or-registration>/<slot>`; persisted legacy paths remain readable without migration.
- Admin manual entry selects a team participant before showing slots and sends `participantId`; import preview and certificate lists show team/participant identity.
- Organization history shows `teamCode` and `participantName` and continues to use the existing authorized file endpoint. No participant login or self-service flow was added.
- Historical team certificates with no stored participant rows remain compatible as legacy targets; teams with participant rows must use a valid participant ID.

## Tests

- API GREEN focused: `npm test --prefix apps/api -- --test-name-pattern="certificate.*participant|team certificate"` — 91 passed, 0 failed.
- UI focused: `npm test --prefix apps/admin -- Certificate` — 63 passed, 0 failed across 6 files.
- Manual team-upload focused API: 90 passed, 0 failed.
- Compatibility regression focused API: 93 passed, 0 failed after preserving historical zero-participant team imports, participant-scoped authorization fixtures, participant-safe storage checks, and registration-level result propagation.
- Certificate suite: `npm test --prefix apps/api -- --test-name-pattern="certificate"` — 166 passed, 0 failed.
- Full admin: `npm test --prefix apps/admin` — 652 passed, 0 failed across 57 files.
- Full API: `npm test --prefix apps/api` — 766 passed, 0 failed.
- Diff hygiene: `git diff --check` — passed.

## Build

- `npm run build` — passed for web and admin.
- Existing non-blocking warnings remain: jsdom reports unsupported cross-document navigation in established tests; Vite reports existing mixed static/dynamic imports and an admin chunk above 500 kB.

## Commit

- Subject: `feat: issue certificates to team participants`
- Hash: reported in the task handoff because a commit cannot contain its own final hash.

## Changed Files and Necessary Deviations

- In addition to the plan's production files, `apps/api/src/routes/registrations.js` was necessarily updated because it owns certificate-template row selection and participant flattening.
- `apps/admin/src/components/ManualCertificateEntryPanel.vue` and `CertificateSlotEditor.vue` were necessarily updated because they own participant selection, participant-scoped slot loading, and multipart upload construction; focused component tests were added beside them instead of source-text assertions in `App.test.js`.
- `apps/api/test/certificate-management.test.js` and `certificates.test.js` cover the actual route/service boundaries for manual upload and independent participant slots.
- `authorization.test.js` updates an existing team fixture to the now-required participant contract; `registration-export.test.js` updates workbook column expectations after the new read-only column.
- `apps/api/src/files/storage.js` received a component-by-component managed-directory check because participant subdirectories exposed a linked-parent traversal case during the full certificate suite.

## Concerns

- None blocking. Compatibility intentionally permits a legacy team workbook target only when that historical registration has no stored participants; once participants exist, all new team certificate writes require a valid participant ID.
