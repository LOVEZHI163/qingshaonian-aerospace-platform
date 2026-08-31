# Task 8 pre-deployment report

Date: 2026-09-01 (Asia/Shanghai)

Scope: reviewed pre-deployment code and local verification only. This slice did not connect to `server115`, deploy an application release, create production backups, change production data, or create the final team-registration release note.

## Source state

- Worktree: `D:\少年航校\.worktrees\aliyun-sms-auth-expansion`
- Branch: `codex/aliyun-sms-auth-expansion`
- Base commit: `898bb723655550f4e39bf3fe7fd478c85afa0e6a`
- Base worktree state: clean
- Planned commit message: `test: verify team migration restart`

## TDD evidence

The production change that each new test protects is explicit:

- querying the wrong migration or recording migration 019 more than once;
- omitting either normalized participant table;
- omitting either project-bound column or losing valid runtime bounds after restart;
- rewriting any field of a legacy personal registration during the second initialization;
- rewriting any field of its encrypted identity row during the second initialization.

RED command:

```text
npm.cmd test --prefix apps/api -- --test-name-pattern="migration restart smoke|upgrade preflight runs" test/deployment.test.js test/deployment-paths.test.js
```

RED result: exit 1, 5 tests observed, 1 passed and 4 failed for the expected missing behavior. The runbook test reported the missing `019-team-registration.sql` contract, and the three restart-state tests reported that `assertTeamMigrationRestartState` was not implemented. The pre-change CLI also attempted its import-time entry point and failed the isolated-database safety check, demonstrating the need for an import-safe direct-execution guard.

GREEN command: the same focused command after the minimal implementation.

GREEN result: exit 0, 10/10 checks passed, including the nested mutation cases for migration count, table presence, bound presence/runtime values, registration preservation, and identity preservation.

## Implementation summary

- The restart smoke now selects a seeded legacy personal/individual registration, inserts one encrypted legacy identity row, captures both full rows, closes the first store, and opens a second initialized store.
- The second initialization must record `019-team-registration.sql` exactly once, expose `registration_participants` and `registration_participant_identities`, expose `team_min_members` and `team_max_members`, and return valid 1–8 project bounds.
- The full legacy registration aggregate and full encrypted identity row must be deep-equal before and after restart. Error messages contain no identity plaintext or connection credentials.
- Direct CLI execution prints `team-registration-migration-019=applied-once` followed by `PostgreSQL migration/restart smoke passed.`; importing the module for tests does not start a database connection.
- The disposable-preflight paragraph in `docs/deployment/aliyun-test.md` now documents migration 019, both participant tables, both bound columns, legacy-row preservation, expected output, and unconditional temporary-database cleanup.

## Verification evidence

Focused deployment files:

```text
npm.cmd test --prefix apps/api -- test/deployment.test.js test/deployment-paths.test.js
```

Result: exit 0, 55/55 passed.

Full API:

```text
npm.cmd test --prefix apps/api
```

Result: exit 0, 782/782 passed in 130,379.5595 ms.

Full Admin:

```text
npm.cmd test --prefix apps/admin
```

Result: exit 0, 57/57 test files and 653/653 tests passed in 27.30 s. jsdom printed its existing `Not implemented: navigation to another Document` notices; they did not fail the suite.

Production build:

```text
npm.cmd run build
```

Result: exit 0. Web built 55 modules and Admin built 128 modules. Vite reported the existing mixed dynamic/static import notices for three public pages and the existing Admin chunk-size advisory; neither blocked the build.

## Disposable PostgreSQL preflight

The repository preflight was not run twice because this local host has no safely available PostgreSQL runtime:

- `docker`: unavailable on Windows `PATH`;
- `psql`: unavailable;
- `createdb`: unavailable;
- `dropdb`: unavailable;
- repository deployment `.env`: absent;
- repository `backups` directory: absent;
- `wsl.exe` exists, but reports that no Linux distribution is installed and offers `wsl.exe --install`.

No packages, WSL distribution, Docker image, service, environment file, or backup fixture was installed or created. Therefore there is no claim that a real PostgreSQL migration preflight passed on this host. When suitable local tooling is provided, each run must create a fresh database named exactly `aerogp_migration_smoke_[0-9a-f]{32}`, run the repository restart smoke, observe both success lines, and remove the database on every exit path.

## Concerns and release boundary

- The focused tests and full suites cover the assertion logic and pg-mem storage path, but they do not replace the two required real PostgreSQL preflight runs. That remains the only pre-deployment evidence gap in this slice.
- No actual deployed SHA, production backup directory, production health result, or controlled production smoke result exists yet. `docs/deployment/releases/2026-08-31-team-registration.md` was intentionally not created.
- Production release steps, remote access, backups, deployment, cleanup, and rollback evidence remain owned by the later release slice.
- This report is committed with `test: verify team migration restart`; the final commit hash is reported after Git creates the commit.
