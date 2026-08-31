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

## Fix Round 1

### RED

- Added lifecycle tests after certificates were issued to team participants. The initial focused run reproduced ID swapping on reorder and an accepted removal of a certificate-owning participant.
- Added a precise removal regression with the removed participant first and the remaining certificate owner second. Temporarily restoring the original index-based assignment made it fail with `409 !== 200`, proving that index reuse incorrectly treated the real certificate owner as removed.
- Added import preview tests for two participant rows with conflicting and identical registration-level result triples. The conflicting workbook initially remained valid with `2 !== 0`; the identical workbook already established the allowed control case.
- Added historical zero-participant team tests. The template initially returned 0 rows instead of 1, and manual issuance returned 422 instead of 201.
- Combined RED command reported 5 intended failures; the identical-result control passed.

### GREEN

- Team roster edits now resolve existing participant IDs by a verified identity fingerprint: stored ciphertext is decrypted, re-fingerprinted, and required to match its persisted fingerprint before its ID can be reused. Roster order no longer determines certificate ownership.
- Removing a participant who owns a certificate is rejected with `TEAM_PARTICIPANT_CERTIFICATES_EXIST`; this prevents silent relational cascades, dangling JSON references, orphaned private files, and certificate reassignment. Removing a certificate-free teammate still succeeds while preserving the remaining certificate owner's ID.
- Certificate import validation groups result triples by registration and invalidates every participant row when award, rank, or score disagrees. Identical participant result triples remain valid, eliminating last-row-wins behavior.
- A historical team with zero stored participants now produces one legacy registration-level template target and may receive a manual legacy certificate without `participantId`. A team with participants still requires an owned participant ID.

### Tests

- Focused RED/GREEN: `npm test --prefix apps/api -- --test-name-pattern="team roster reorder|team roster removal|conflicting registration-level results|identical registration-level results|historical team certificate target|legacy target for a historical team"` — initial 5 intended failures, then green.
- Precise removal mutation check: `npm test --prefix apps/api -- --test-name-pattern="remaining certificate owner ID"` — failed with index assignment restored, then 90 passed and 0 failed after restoring fingerprint assignment.
- Combined focused regression: `npm test --prefix apps/api -- --test-name-pattern="team roster|team certificate|historical team|manual team certificate|certificate import.*registration-level"` — 101 passed, 0 failed.
- Certificate suite: `npm test --prefix apps/api -- --test-name-pattern="certificate"` — 172 passed, 0 failed.
- Registration lifecycle: `npm test --prefix apps/api -- test/registration-management.test.js test/team-registration-service.test.js` — 38 passed, 0 failed.
- Full API: `npm test --prefix apps/api` — 773 passed, 0 failed.
- Build: `npm run build` — passed for web and admin with only the previously documented Vite import/chunk warnings.

### Commit

- Subject: `fix: preserve team certificate targets`
- Hash: reported in the task handoff because a commit cannot contain its own final hash.

### Concerns

- None blocking. Participant removal is intentionally refused while that participant owns any certificate; operators must explicitly handle the certificate before changing the roster, keeping file and database behavior consistent across file and PostgreSQL stores.
