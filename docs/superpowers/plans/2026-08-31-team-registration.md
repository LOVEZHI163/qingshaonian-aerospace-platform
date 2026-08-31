# Team Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add organization-only, one-team-per-submit registration with configurable 1–8 member rosters, one-individual-plus-one-team athlete limits, expanded exports, and per-participant certificates for unregistered team members.

**Architecture:** Keep `registrations` as the result/review aggregate and add normalized participant and participant-identity rows. Historical individual registrations remain readable through a compatibility projection; new team registrations write one main row plus 1–8 participant rows under the existing mutation lock and PostgreSQL transaction. Team results remain registration-level, while certificates may target a participant without requiring a `users` row.

**Tech Stack:** Node.js 22, Express, PostgreSQL, pg-mem, AES-GCM identity helpers, ExcelJS, Vue 3, Vitest, Node test runner, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-31-team-registration-design.md`

## Global Constraints

- Team projects default to 1–8 members; both bounds are integers within 1–8 and minimum cannot exceed maximum.
- One organization submission creates exactly one team; no multi-team batch form or roster import is introduced.
- Team projects are organization-proxy only; personal and member-registration channels must reject them server-side.
- Every athlete may hold at most one active individual registration and one active team registration per event.
- Athlete conflicts use encrypted-identity fingerprints, never names or phone numbers.
- Every team has at most one instructor.
- Team participants do not need `users` rows.
- Existing personal registrations and certificates remain readable without destructive backfill.
- Full identity values never appear in logs, audit summaries, or general list endpoints.
- The companion plan `docs/superpowers/plans/2026-08-31-registration-guide-auth-layout.md` must be complete before the combined production release.

---

### Task 1: Add additive roster and certificate-target schema

**Files:**
- Create: `apps/api/src/data/migrations/019-team-registration.sql`
- Modify: `apps/api/src/data/schema.sql`
- Modify: `apps/api/src/data/postgres-store.js`
- Modify: `apps/api/src/data/seed.js`
- Create: `apps/api/test/team-registration-schema.test.js`
- Modify: `apps/api/test/postgres-store.test.js`

**Interfaces:**
- Produces: project fields `teamMinMembers: number`, `teamMaxMembers: number`; registration field `teamCode: string`; arrays `registrationParticipants` and `registrationParticipantIdentities`; certificate field `participantId: string | null`.
- Produces: PostgreSQL tables `registration_participants` and `registration_participant_identities` plus participant-aware certificate uniqueness.

- [ ] **Step 1: Write the failing migration contract test**

```js
test("019 adds bounded team rosters and participant certificate targets", async () => {
  const sql = await readFile(new URL("../src/data/migrations/019-team-registration.sql", import.meta.url), "utf8");
  assert.match(sql, /team_min_members SMALLINT NOT NULL DEFAULT 1/);
  assert.match(sql, /team_max_members SMALLINT NOT NULL DEFAULT 8/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS registration_participants/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS registration_participant_identities/);
  assert.match(sql, /participant_id TEXT/);
  assert.match(sql, /certificates_participant_slot_key/);
});
```

- [ ] **Step 2: Run the focused test and observe the missing migration failure**

Run: `npm test --prefix apps/api -- --test-name-pattern="019 adds bounded team rosters"`

Expected: FAIL because `019-team-registration.sql` does not exist.

- [ ] **Step 3: Add the additive SQL migration and mirror it in the base schema**

Use this final SQL shape in both migration and fresh-install schema:

```sql
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS team_min_members SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS team_max_members SMALLINT NOT NULL DEFAULT 8;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_team_member_bounds_check;
ALTER TABLE projects ADD CONSTRAINT projects_team_member_bounds_check
  CHECK (team_min_members BETWEEN 1 AND 8
    AND team_max_members BETWEEN 1 AND 8
    AND team_min_members <= team_max_members);

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS team_code TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS registration_participants (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  display_order SMALLINT NOT NULL CHECK (display_order BETWEEN 1 AND 8),
  name TEXT NOT NULL,
  school TEXT NOT NULL,
  grade TEXT NOT NULL,
  phone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (registration_id, display_order),
  UNIQUE (id, registration_id)
);

CREATE TABLE IF NOT EXISTS registration_participant_identities (
  participant_id TEXT PRIMARY KEY REFERENCES registration_participants(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  id_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS registration_participant_identity_fingerprint_idx
  ON registration_participant_identities(id_fingerprint);

ALTER TABLE certificates ADD COLUMN IF NOT EXISTS participant_id TEXT;
ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_registration_id_slot_key;
ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_participant_registration_fkey;
ALTER TABLE certificates ADD CONSTRAINT certificates_participant_registration_fkey
  FOREIGN KEY (participant_id, registration_id)
  REFERENCES registration_participants(id, registration_id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS certificates_registration_slot_legacy_key
  ON certificates(registration_id, slot) WHERE participant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS certificates_participant_slot_key
  ON certificates(registration_id, participant_id, slot) WHERE participant_id IS NOT NULL;
```

- [ ] **Step 4: Extend in-memory shape and PostgreSQL read/write mappings**

Add these defaults to `ensureDbShape`:

```js
db.registrationParticipants ||= [];
db.registrationParticipantIdentities ||= [];
for (const project of db.projects) {
  project.teamMinMembers = Number(project.teamMinMembers || 1);
  project.teamMaxMembers = Number(project.teamMaxMembers || 8);
}
for (const registration of db.registrations) registration.teamCode ||= "";
for (const certificate of db.certificates) certificate.participantId ||= null;
```

Add the two participant queries to `readDb()`, map snake_case to the published camelCase fields, and add upsert/deleteMissing loops. Project and registration SQL must include the new fields; certificate SQL must include `participant_id`.

- [ ] **Step 5: Add PostgreSQL round-trip assertions**

Create a team registration fixture with two participants and two encrypted identity fixture rows, persist it, reload it, and assert:

```js
assert.deepEqual(reloaded.projects[0].teamMinMembers, 1);
assert.deepEqual(reloaded.projects[0].teamMaxMembers, 8);
assert.equal(reloaded.registrations[0].teamCode, "ORG-PROJECT-01");
assert.equal(reloaded.registrationParticipants.length, 2);
assert.equal(reloaded.registrationParticipantIdentities.length, 2);
assert.equal(reloaded.certificates[0].participantId, reloaded.registrationParticipants[0].id);
```

- [ ] **Step 6: Run storage and migration tests**

Run: `npm test --prefix apps/api -- --test-name-pattern="019|PostgreSQL|shape"`

Expected: PASS, including a second initialization proving migration replay safety.

- [ ] **Step 7: Commit the schema slice**

```bash
git add apps/api/src/data/migrations/019-team-registration.sql apps/api/src/data/schema.sql apps/api/src/data/postgres-store.js apps/api/src/data/seed.js apps/api/test/team-registration-schema.test.js apps/api/test/postgres-store.test.js
git commit -m "feat: add team registration storage"
```

---

### Task 2: Add bounded team settings to event management

**Files:**
- Modify: `apps/api/src/services/events.js`
- Modify: `apps/api/src/services/site-preview.js`
- Modify: `apps/api/test/event-management.test.js`
- Modify: `apps/admin/src/pages/EventManagementPage.vue`
- Modify: `apps/admin/src/__tests__/App.test.js`

**Interfaces:**
- Consumes: `project.teamMinMembers` and `project.teamMaxMembers` from Task 1.
- Produces: `normalizeProjectFields()` validation and an admin form that only exposes bounds for `type === "team"`.

- [ ] **Step 1: Write failing service tests for defaults and validation**

```js
const team = createProject(db, "E1", {
  ...validProject, type: "team", teamMinMembers: 1, teamMaxMembers: 8
}, deps);
assert.equal(team.teamMinMembers, 1);
assert.equal(team.teamMaxMembers, 8);
assert.throws(() => updateProject(db, team.id, { ...team, teamMinMembers: 0 }), /1 至 8/);
assert.throws(() => updateProject(db, team.id, { ...team, teamMinMembers: 6, teamMaxMembers: 5 }), /最少人数不能大于最多人数/);
```

- [ ] **Step 2: Run the event tests and verify the new fields are ignored**

Run: `npm test --prefix apps/api -- --test-name-pattern="team member bounds|赛项人数"`

Expected: FAIL because the editable field list and validation do not contain the bounds.

- [ ] **Step 3: Implement project normalization**

Add both field names to `PROJECT_EDITABLE_FIELDS` and normalize with:

```js
function normalizeTeamMemberBounds(next) {
  if (next.type !== "team") return { teamMinMembers: 1, teamMaxMembers: 1 };
  const min = Number(next.teamMinMembers ?? 1);
  const max = Number(next.teamMaxMembers ?? 8);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 8) {
    throw businessError(422, "团队人数必须是 1 至 8 的整数");
  }
  if (min > max) throw businessError(422, "团队最少人数不能大于最多人数");
  return { teamMinMembers: min, teamMaxMembers: max };
}
```

Merge the result into `next`; add both fields to site preview project allowlists.

- [ ] **Step 4: Write the failing Vue form test**

Select `team`, set minimum to `2`, maximum to `6`, save, and assert the request body contains both numbers. Switch back to `individual` and assert the bounds container is absent.

- [ ] **Step 5: Add the conditional admin controls**

Extend `PROJECT_FIELDS`, `emptyProject()`, `editProject()` and `projectPayload()`. Render:

```vue
<div v-if="projectForm.type === 'team'" class="two" data-team-member-bounds>
  <label>最少队员人数<input v-model.number="projectForm.teamMinMembers" type="number" min="1" max="8" required /></label>
  <label>最多队员人数<input v-model.number="projectForm.teamMaxMembers" type="number" min="1" max="8" required /></label>
</div>
```

- [ ] **Step 6: Run API and admin focused tests**

Run: `npm test --prefix apps/api -- --test-name-pattern="project|赛项人数"`

Run: `npm test --prefix apps/admin -- --runInBand`

Expected: PASS.

- [ ] **Step 7: Commit settings support**

```bash
git add apps/api/src/services/events.js apps/api/src/services/site-preview.js apps/api/test/event-management.test.js apps/admin/src/pages/EventManagementPage.vue apps/admin/src/__tests__/App.test.js
git commit -m "feat: configure team roster limits"
```

---

### Task 3: Implement participant identity projection and per-type limits

**Files:**
- Create: `apps/api/src/services/registration-participants.js`
- Modify: `apps/api/src/services/registrations.js`
- Modify: `apps/api/src/security/registration-identities.js`
- Create: `apps/api/test/team-registration-service.test.js`
- Modify: `apps/api/test/registration-identities.test.js`

**Interfaces:**
- Produces: `participantsForRegistration(db, registration, actor): ParticipantDto[]`.
- Produces: `prepareTeamRoster(db, input, context): { participants, identities, group }`.
- Produces: `assertAthleteTypeAvailability(db, { eventId, projectType, fingerprints, ignoreRegistrationId }): void`.
- Produces: `createParticipantIdentity(participantId, studentIdNumber, timestamp): ParticipantIdentity`.

- [ ] **Step 1: Write failing rule tests**

Cover these exact cases with encrypted identity fixtures:

```js
assert.doesNotThrow(() => assertAthleteTypeAvailability(dbWithOneIndividual, {
  eventId: "E1", projectType: "team", fingerprints: [fingerprint], ignoreRegistrationId: null
}));
assert.throws(() => assertAthleteTypeAvailability(dbWithOneTeam, {
  eventId: "E1", projectType: "team", fingerprints: [fingerprint], ignoreRegistrationId: null
}), /最多报名一个团队赛/);
assert.throws(() => prepareTeamRoster(db, { participants: ninePeople }, context), /最多 8 人/);
```

Also assert two identical IDs inside one request fail before any row is added.

- [ ] **Step 2: Run focused tests and verify the module is missing**

Run: `npm test --prefix apps/api -- --test-name-pattern="team roster|每届最多"`

Expected: FAIL with module/function missing.

- [ ] **Step 3: Implement participant normalization and identity helpers**

Use one normalized input shape:

```js
export function normalizeParticipantInput(row, index) {
  const participant = {
    name: String(row?.name || "").trim(),
    school: String(row?.school || "").trim(),
    grade: String(row?.grade || "").trim(),
    phone: normalizePhone(row?.phone),
    studentIdNumber: normalizeStudentId(row?.studentIdNumber)
  };
  for (const [field, label] of [["name", "姓名"], ["school", "学校"], ["grade", "年级"], ["phone", "手机号"], ["studentIdNumber", "身份证号"]]) {
    if (!participant[field]) throw businessError(422, `第 ${index + 1} 名队员${label}不能为空`);
  }
  if (!/^1\d{10}$/.test(participant.phone)) throw businessError(422, `第 ${index + 1} 名队员手机号不合法`);
  return participant;
}
```

Encrypt each normalized ID with the existing AES-GCM helpers and keep plaintext only in the local prepared value until persistence is built.

- [ ] **Step 4: Implement compatibility projection**

`participantsForRegistration` returns normalized stored participants for team rows. For a historical row with no participants, return one compatibility participant built from `registration.athlete`; only authorized admin/owning organization projections attach decrypted identity.

- [ ] **Step 5: Replace exact-project-only validation with type-aware fingerprint validation**

Treat only `pending` and `approved` rows as occupying a slot. For every existing registration, gather its participant identity fingerprints; fall back to `registration_identities` for historical personal rows. Reject an incoming fingerprint when an active row in the same event has the same `projectType`, ignoring the edited registration ID.

- [ ] **Step 6: Run identity and service tests**

Run: `npm test --prefix apps/api -- --test-name-pattern="identity|team roster|每届最多"`

Expected: PASS without logging full IDs.

- [ ] **Step 7: Commit the domain slice**

```bash
git add apps/api/src/services/registration-participants.js apps/api/src/services/registrations.js apps/api/src/security/registration-identities.js apps/api/test/team-registration-service.test.js apps/api/test/registration-identities.test.js
git commit -m "feat: enforce team participant limits"
```

---

### Task 4: Add organization-only team creation and editing APIs

**Files:**
- Modify: `apps/api/src/services/registrations.js`
- Modify: `apps/api/src/routes/registrations.js`
- Modify: `apps/api/test/organization-registration-permissions.test.js`
- Modify: `apps/api/test/registration-management.test.js`
- Modify: `apps/admin/src/components/OrganizationAthleteRegistrationForm.vue`
- Create: `apps/admin/src/components/TeamRegistrationFields.vue`
- Create: `apps/admin/src/components/__tests__/TeamRegistrationFields.test.js`
- Modify: `apps/admin/src/pages/RegistrationPage.vue`

**Interfaces:**
- Consumes: roster preparation and type-limit functions from Task 3.
- Produces: organization POST/PATCH payload `{ projectId, participants, instructor, registrationSource: "organization_proxy" }` for team projects.
- Produces: team response `{ teamCode, participants, participantCount }`.

- [ ] **Step 1: Write failing API authorization and creation tests**

Assert:

```js
await personal.post("/api/me/events/E1/registrations").send(teamPayload).expect(422, {
  error: "团队赛只允许组织代报名",
  code: "TEAM_ORGANIZATION_PROXY_REQUIRED"
});
await organization.post("/api/organization/events/E1/registrations")
  .send({ ...teamPayload, registrationSource: "member_registration" })
  .expect(422);
const created = await organization.post("/api/organization/events/E1/registrations")
  .send({ ...teamPayload, registrationSource: "organization_proxy" }).expect(201);
assert.equal(created.body.row.participants.length, 2);
```

- [ ] **Step 2: Run focused route tests and confirm team payloads fail**

Run: `npm test --prefix apps/api -- --test-name-pattern="team organization proxy|团队赛只允许"`

Expected: FAIL because current creation always expects one `athlete`.

- [ ] **Step 3: Branch creation by trusted project type**

In `validateCreateForEvent`, load the project before parsing athlete data. For `team` require `channel === "organization"` and `registrationSource === "organization_proxy"`, then call `prepareTeamRoster`. For `individual`, reject a `participants` array and preserve the existing single-athlete path.

Generate a code without extra user input:

```js
function nextTeamCode(db, eventId, organizationId, projectId) {
  const sequence = db.registrations.filter((row) => row.eventId === eventId
    && row.organizationId === organizationId && row.projectId === projectId
    && row.projectType === "team").length + 1;
  return `${organizationId}-${projectId}-${String(sequence).padStart(2, "0")}`;
}
```

The existing mutation lock serializes generation and persistence. Store the first participant in legacy `athlete`/`athleteKey` only as a compatibility summary; all team logic must read `participants` and participant identities.

- [ ] **Step 4: Support roster-safe edits**

Organization/admin PATCH of a team registration accepts a complete replacement `participants` array, revalidates all type limits with `ignoreRegistrationId`, replaces participant rows and identities atomically, and preserves `projectId` and `teamCode`. Personal PATCH rejects team rows.

- [ ] **Step 5: Write the failing team form component test**

Mount with a team project `{ teamMinMembers: 1, teamMaxMembers: 8 }`; add a second person, fill all fields, submit, and assert one API call with two participants and no `memberUserId`. Add participants until eight and assert the add button is disabled.

- [ ] **Step 6: Implement a focused roster component**

`TeamRegistrationFields.vue` receives `modelValue`, `minMembers`, `maxMembers`, and `defaultSchool`; emits a full participant array. It renders repeated fields with stable keys, an add button, and delete buttons that never reduce below the configured minimum.

`OrganizationAthleteRegistrationForm.vue` selects the form by trusted selected project type. Team selection forces `registrationSource` to `organization_proxy` and hides the member/proxy radio group. `RegistrationPage.vue` filters `eligibleProjects` to `project.type === "individual"`.

- [ ] **Step 7: Run API and component tests**

Run: `npm test --prefix apps/api -- --test-name-pattern="organization registration|team"`

Run: `npm test --prefix apps/admin -- TeamRegistrationFields`

Expected: PASS.

- [ ] **Step 8: Commit the API/form slice**

```bash
git add apps/api/src/services/registrations.js apps/api/src/routes/registrations.js apps/api/test/organization-registration-permissions.test.js apps/api/test/registration-management.test.js apps/admin/src/components/OrganizationAthleteRegistrationForm.vue apps/admin/src/components/TeamRegistrationFields.vue apps/admin/src/components/__tests__/TeamRegistrationFields.test.js apps/admin/src/pages/RegistrationPage.vue
git commit -m "feat: add organization team registration"
```

---

### Task 5: Show complete rosters in organization and admin workflows

**Files:**
- Modify: `apps/api/src/services/registrations.js`
- Modify: `apps/admin/src/pages/OrganizationEventWorkspacePage.vue`
- Modify: `apps/admin/src/pages/OrganizationRegistrationRecordsPage.vue`
- Modify: `apps/admin/src/pages/RegistrationManagementPage.vue`
- Modify: `apps/admin/src/styles/forms.css`
- Modify: `apps/admin/src/styles/tables.css`
- Modify: `apps/admin/src/__tests__/App.test.js`

**Interfaces:**
- Consumes: `{ teamCode, participants, participantCount }` response fields from Task 4.
- Produces: expandable roster summaries and team-aware edit dialogs.

- [ ] **Step 1: Write failing rendering tests**

Use a two-person team fixture and assert organization/admin screens contain the team code, “2 名队员”, both names, one instructor, and one edit action for the team rather than one action per participant.

- [ ] **Step 2: Run admin tests and observe single-athlete rendering**

Run: `npm test --prefix apps/admin -- --runInBand`

Expected: FAIL because tables only read `row.athlete`.

- [ ] **Step 3: Add team-aware table cells**

Render the compact summary:

```vue
<template v-if="row.projectType === 'team'">
  <strong>{{ row.teamCode }}</strong>
  <button type="button" class="link-button" @click="toggleRoster(row.id)">{{ row.participantCount }} 名队员</button>
  <ul v-if="expandedId === row.id" class="team-roster-list">
    <li v-for="person in row.participants" :key="person.id">{{ person.name }} · {{ person.school }} · {{ person.grade }}</li>
  </ul>
</template>
<template v-else>{{ row.athlete?.name }}</template>
```

Only authorized admin and owning organization views render full phone/identity fields. General summaries stay masked.

- [ ] **Step 4: Make editing reuse the team roster form**

When `editRow.projectType === "team"`, pass the full roster and configured bounds to `TeamRegistrationFields`; keep the project disabled and the instructor singular. Submit the complete roster through the organization/admin PATCH endpoint.

- [ ] **Step 5: Run the management UI regression suite**

Run: `npm test --prefix apps/admin -- --runInBand`

Expected: PASS for personal and team fixtures.

- [ ] **Step 6: Commit roster management UI**

```bash
git add apps/api/src/services/registrations.js apps/admin/src/pages/OrganizationEventWorkspacePage.vue apps/admin/src/pages/OrganizationRegistrationRecordsPage.vue apps/admin/src/pages/RegistrationManagementPage.vue apps/admin/src/styles/forms.css apps/admin/src/styles/tables.css apps/admin/src/__tests__/App.test.js
git commit -m "feat: manage team rosters"
```

---

### Task 6: Expand registration workbooks by participant

**Files:**
- Modify: `apps/api/src/exports/registration-workbook.js`
- Modify: `apps/api/src/routes/registrations.js`
- Modify: `apps/api/src/routes/account-events.js`
- Modify: `apps/api/test/registration-export.test.js`

**Interfaces:**
- Consumes: participant projections from Task 3.
- Produces: `expandRegistrationRows(rows): RegistrationExportRow[]`; one output row per team participant and one row per personal registration.

- [ ] **Step 1: Write a failing two-member export test**

Build one team row with two participants and assert worksheet rows 2 and 3 share registration/team codes but contain different participant identity, phone, school and grade values.

- [ ] **Step 2: Run export tests and observe one output row**

Run: `npm test --prefix apps/api -- --test-name-pattern="registration export|团队名单"`

Expected: FAIL because `buildRegistrationWorkbook` adds one row per registration.

- [ ] **Step 3: Add deterministic expansion**

```js
export function expandRegistrationRows(rows) {
  return rows.flatMap((registration) => {
    const participants = registration.participants?.length
      ? registration.participants
      : [{ ...registration.athlete, studentIdNumber: registration.studentIdNumber }];
    return participants.map((participant, index) => ({
      ...registration,
      exportParticipant: participant,
      participantOrder: index + 1
    }));
  });
}
```

Add “队伍编号” and “队员序号” columns; change participant columns to read `exportParticipant`. Apply the 10,000-row cap after expansion, because the produced workbook row count is the relevant limit.

- [ ] **Step 4: Pass authorized participant projections into all export routes**

Admin and owning-organization exports attach full authorized identities before expansion. Personal history export remains one row. No public endpoint receives full team identity values.

- [ ] **Step 5: Run workbook tests**

Run: `npm test --prefix apps/api -- --test-name-pattern="workbook|export"`

Expected: PASS, including text formatting for all identity and phone columns.

- [ ] **Step 6: Commit workbook expansion**

```bash
git add apps/api/src/exports/registration-workbook.js apps/api/src/routes/registrations.js apps/api/src/routes/account-events.js apps/api/test/registration-export.test.js
git commit -m "feat: export team participants"
```

---

### Task 7: Bind certificates to unregistered participants

**Files:**
- Modify: `apps/api/src/routes/certificates.js`
- Modify: `apps/api/src/certificates/template.js`
- Modify: `apps/api/src/certificates/workbook-parser.js`
- Modify: `apps/api/src/services/certificate-imports.js`
- Modify: `apps/api/src/files/storage.js`
- Modify: `apps/api/src/services/certificates.js`
- Modify: `apps/api/test/certificate-workbook.test.js`
- Modify: `apps/api/test/certificate-imports.test.js`
- Modify: `apps/api/test/organization-certificate-history.test.js`
- Modify: `apps/admin/src/pages/CertificateManagementPage.vue`
- Modify: `apps/admin/src/pages/OrganizationCertificatesPage.vue`
- Modify: `apps/admin/src/components/CertificateImportPanel.vue`
- Modify: `apps/admin/src/__tests__/App.test.js`

**Interfaces:**
- Consumes: certificate `participantId` storage from Task 1 and participant projections from Task 3.
- Produces: participant certificate target `{ registrationId, participantId, participantName, teamCode }`.
- Produces: manual upload route body/query field `participantId`; import workbook column “证书对象编号”.

- [ ] **Step 1: Write failing service and workbook tests**

Assert one approved two-member team creates two template rows with the same registration ID and different participant IDs. Assert certificates for both participants may use slot 1 without a uniqueness conflict. Assert organization certificate history returns both participant names without requiring matching `users` rows.

- [ ] **Step 2: Run certificate tests and verify registration-only targeting fails**

Run: `npm test --prefix apps/api -- --test-name-pattern="certificate.*participant|team certificate"`

Expected: FAIL because parser and storage identify targets only by registration ID and slot.

- [ ] **Step 3: Flatten approved registrations into certificate targets**

Add a pure function:

```js
export function certificateTargets(registrations) {
  return registrations.flatMap((registration) => {
    if (registration.projectType !== "team") {
      return [{ ...registration, participantId: null, participantName: registration.athlete?.name || "" }];
    }
    return registration.participants.map((participant) => ({
      ...registration,
      participantId: participant.id,
      participantName: participant.name
    }));
  });
}
```

The template must include read-only “证书对象编号”; for a team it is `participantId`, and for a personal registration it is blank. The parser key becomes `${registrationId}:${participantId || "legacy"}` and rejects a participant not owned by the registration.

- [ ] **Step 4: Make file storage participant-safe**

Pass `participantId` into certificate storage and construct the private path with a safe target segment such as `${registrationId}/${participantId || "registration"}/${slot}`. Preserve existing legacy paths for old certificates.

- [ ] **Step 5: Update manual upload and import commit**

Manual team upload requires `participantId`; personal upload rejects an unrelated participant ID. Certificate objects store `participantId`, and result propagation still copies the registration-level award/rank/score to every certificate under that registration.

- [ ] **Step 6: Update administrator and organization certificate screens**

Team certificate management first selects a participant, then manages slots 1 and 2 for that participant. Organization history renders team code and participant name and uses the existing authorized download endpoint. Do not add participant self-service or a new login flow.

- [ ] **Step 7: Run certificate and UI tests**

Run: `npm test --prefix apps/api -- --test-name-pattern="certificate"`

Run: `npm test --prefix apps/admin -- --runInBand`

Expected: PASS for legacy personal certificates and new team participant certificates.

- [ ] **Step 8: Commit participant certificate support**

```bash
git add apps/api/src/routes/certificates.js apps/api/src/certificates/template.js apps/api/src/certificates/workbook-parser.js apps/api/src/services/certificate-imports.js apps/api/src/files/storage.js apps/api/src/services/certificates.js apps/api/test/certificate-workbook.test.js apps/api/test/certificate-imports.test.js apps/api/test/organization-certificate-history.test.js apps/admin/src/pages/CertificateManagementPage.vue apps/admin/src/pages/OrganizationCertificatesPage.vue apps/admin/src/components/CertificateImportPanel.vue apps/admin/src/__tests__/App.test.js
git commit -m "feat: issue certificates to team participants"
```

---

### Task 8: Complete regression, migration preflight, and production release

**Files:**
- Modify: `apps/api/src/cli/postgres-migration-restart-smoke.js`
- Modify: `apps/api/test/deployment.test.js`
- Modify: `apps/api/test/deployment-paths.test.js`
- Modify: `docs/deployment/aliyun-test.md`
- Create: `docs/deployment/releases/2026-08-31-team-registration.md`

**Interfaces:**
- Consumes: all prior tasks and completed companion UI plan.
- Produces: reviewed commit deployed to `server115:/opt/aerogp`, with backup paths and smoke evidence recorded in the release note.

- [ ] **Step 1: Extend migration restart smoke**

After isolated initialization, assert migration 019 exists exactly once, both participant tables exist, project bounds are present, and a legacy personal registration/identity remains unchanged after a second initialization.

- [ ] **Step 2: Run the complete local verification suite**

Run:

```bash
npm test --prefix apps/api
npm test --prefix apps/admin
npm run build
git status --short
```

Expected: all tests and builds PASS; only the intended release documentation may be uncommitted.

- [ ] **Step 3: Run isolated PostgreSQL migration preflight twice**

Use the repository’s existing disposable-database preflight from `docs/deployment/aliyun-test.md`. Expected output includes migration 019 applied once and the restart smoke passing. The disposable database name must satisfy `aerogp_migration_smoke_[0-9a-f]{32}`.

- [ ] **Step 4: Capture production backups before changing services**

On `server115`, create a timestamped directory below `/opt/aerogp/backups/release-archives/`, save a `pg_dump` of the production database, archive the currently deployed application files, and record the pre-release Git SHA. Do not copy `/opt/aerogp/.env` into repository artifacts or command output.

- [ ] **Step 5: Deploy the reviewed commit**

Follow `docs/deployment/aliyun-test.md`: transfer only the reviewed commit, rebuild containers, let the API migration runner apply 019, and wait for all services to become healthy. Do not run destructive schema rollback commands.

- [ ] **Step 6: Run production smoke checks**

Verify:

```text
/api/health returns healthy
personal registration context contains only usable individual projects in the personal UI
organization workspace shows team bounds and creates one test team in the approved test path
the same athlete cannot create a second active team registration
an athlete with one individual registration may create one team registration
admin review expands the complete roster
admin and organization exports contain one row per team participant
organization certificate view can download a participant certificate
registration guide and both login modes match the companion UI plan
```

Use controlled test records only; remove or cancel them through supported application operations after smoke verification.

- [ ] **Step 7: Record release evidence and rollback instructions**

The release note records deployed SHA, backup directory, migration result, test totals, build result, health result, and smoke cases. Rollback means redeploying the archived application release while leaving additive migration 019 tables/columns intact; restore the database dump only if data was corrupted and after explicitly stopping application writes.

- [ ] **Step 8: Commit release documentation**

```bash
git add apps/api/src/cli/postgres-migration-restart-smoke.js apps/api/test/deployment.test.js apps/api/test/deployment-paths.test.js docs/deployment/aliyun-test.md docs/deployment/releases/2026-08-31-team-registration.md
git commit -m "docs: verify team registration release"
```

## Self-Review Result

- Spec coverage: project bounds, one-team-per-submit, multiple teams per organization, organization-only authorization, 1+1 per-type limit, encrypted roster identities, single instructor, review/edit, expanded export, non-user certificates, regression and `server115` release each map to a task.
- Placeholder scan: the plan contains no deferred implementation markers or unspecified error-handling steps.
- Type consistency: `teamMinMembers`, `teamMaxMembers`, `teamCode`, `registrationParticipants`, `registrationParticipantIdentities`, `participants`, and `participantId` retain the same names across schema, services, APIs, UI, exports and certificates.
