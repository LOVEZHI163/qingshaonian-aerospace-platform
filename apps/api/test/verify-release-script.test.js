import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const expectedRelease = "3ad0feb535269b67d3d88b6ed3eaadd29dfe3672";

test("organization lifecycle operations preserve release backups and fail closed while updating secrets", async () => {
  const guide = await readFile(path.join(root, "docs/operations/organization-account-lifecycle.md"), "utf8");

  assert.match(guide, /test -r \.env/);
  assert.doesNotMatch(guide, /grep -v '\^TEMP_PASSWORD_ENCRYPTION_KEY=' \.env > "\$tmp" \|\| true/);
  assert.match(guide, /backups\/release-archives\/pre-org-lifecycle-/);
  assert.match(guide, /cp -- "\$latest" "\$release_archive\/postgres\.dump"/);
  assert.match(guide, /cp -- "\$latest_uploads" "\$release_archive\/uploads\.tar\.gz"/);
  assert.match(guide, /自动备份文件仍按 7 天策略清理/);
  assert.ok((guide.match(/^set -eu$/gm) || []).length >= 2, "secret rotation and backup snippets must fail closed");
  assert.match(guide, /trap cleanup_key_update EXIT HUP INT TERM/);
  assert.match(guide, /database_container_path="\$\(/);
  assert.match(guide, /uploads_container_path="\$\(/);
  assert.doesNotMatch(guide, /latest="\$\(find backups /);
});

test("remote smoke keeps organization records scoped and validates the organization workspace release contract", async () => {
  const smoke = await readFile(path.join(root, "deploy/remote-smoke-test.sh"), "utf8");

  for (const label of [
    "organization-records-shell",
    "organization-records",
    "organization-records-foreign-isolated",
    "organization-workspace"
  ]) {
    assert.match(smoke, new RegExp(`assert_status \\\"${label}\\\" 200`));
  }
  assert.match(smoke, /\/admin\/\?view=organizationRecords/);
  assert.match(smoke, /\/api\/organization\/registrations/);
  assert.match(smoke, /foreign_registration_id/);
  assert.match(smoke, /smoke_organization_user_id=/);
  assert.match(smoke, /smoke_foreign_organization_user_id=/);
  assert.match(smoke, /data\.user\.id/);
  assert.match(smoke, /data\.user\.phone/);
  assert.match(smoke, /data\.organization\.name/);
  assert.match(smoke, /registered_organization_name.*smoke_organization_name/);
  assert.match(smoke, /registered_foreign_organization_name.*smoke_foreign_organization_name/);
  assert.match(smoke, /data\.organization\.id/);
  assert.match(smoke, /data\.grades/);
  assert.match(smoke, /smoke_organization_token=/);
  assert.match(smoke, /smoke_event_cleanup_pending=0/);
  assert.match(smoke, /smoke_user_cleanup_pending=0/);
  assert.match(smoke, /smoke_organization_cleanup_pending=0/);
  assert.match(smoke, /smoke_foreign_organization_cleanup_pending=0/);
  assert.match(smoke, /credential-cleanup/);
  assert.match(smoke, /DELETE "\$base_url\/api\/admin\/users\/\$organization_user_id"/);
  assert.match(smoke, /recover_organization_smoke_ids\(\)/);
  assert.match(smoke, /organization_expected_grades=/);
  assert.match(smoke, /\["一年级","二年级","三年级","四年级","五年级","六年级","初一","初二","初三","高一","高二","高三","职高一年级","职高二年级","职高三年级"\]/);
  assert.match(smoke, /-F "password=<\$smoke_organization_password_file"/);
  assert.match(smoke, /-F "password=<\$smoke_foreign_organization_password_file"/);
  assert.doesNotMatch(smoke, /-F "password=\$smoke_(?:foreign_)?organization_password"/);
  const cleanupBody = smoke.match(/cleanup\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.ok(cleanupBody.indexOf("cleanup_submission_smoke") < cleanupBody.indexOf("cleanup_organization_smoke"));
  assert.doesNotMatch(cleanupBody, /\|\| true/);
  assert.match(smoke, /trap 'handle_exit' 0/);
  assert.match(smoke, /cleanup failed after exit status/);
  assert.match(smoke, /if \[ "\$status" -eq 0 \]; then\s*status=1/);
  for (const [label, pending] of [
    ["organization-owner-register", "smoke_organization_cleanup_pending=1"],
    ["organization-foreign-register", "smoke_foreign_organization_cleanup_pending=1"]
  ]) {
    const status = smoke.indexOf(`assert_status "${label}" 201`);
    const pendingAt = smoke.lastIndexOf(pending, status);
    const json = smoke.indexOf(`assert_json_response "${label}"`, status);
    assert.ok(status >= 0 && pendingAt >= 0 && pendingAt < status && json > status,
      `${label} must lock cleanup intent before its request can create a fixture`);
  }
  const eventCopy = smoke.indexOf('assert_status "submission-event-copy" 201');
  const eventPending = smoke.lastIndexOf("smoke_event_cleanup_pending=1", eventCopy);
  const eventJson = smoke.indexOf('assert_json_response "submission-event-copy"', eventCopy);
  assert.ok(eventPending >= 0 && eventPending < eventCopy && eventJson > eventCopy,
    "event-copy must lock cleanup intent before its request can create a fixture");
  assert.match(smoke, /recover_submission_smoke_event_id\(\)/);
  assert.match(smoke, /verify_submission_smoke_event_target\(\)/);
  assert.match(smoke, /project\.eventId !== event\.id/);
  assert.match(smoke, /cleanup-events\.json/);
  assert.match(smoke, /event\.name === expectedName/);
  assert.match(smoke, /event\.name\.includes\(expectedToken\)/);
  assert.match(smoke, /event\.id !== sourceEventId/);
  assert.match(smoke, /organization\.name === process\.env\.EXPECTED_NAME/);
  assert.match(smoke, /organization\.name\.includes\(process\.env\.EXPECTED_TOKEN\)/);
  assert.match(smoke, /if test -z "\$recovered_event_id"; then\s*smoke_event_cleanup_pending=0/);
  assert.match(smoke, /2\) smoke_organization_cleanup_pending=0/);
  assert.match(smoke, /2\) smoke_foreign_organization_cleanup_pending=0/);
  const submissionCleanup = smoke.match(/cleanup_submission_event_smoke\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  const archive = submissionCleanup.indexOf('/archive"');
  const deletion = submissionCleanup.indexOf('-X DELETE "$base_url/api/admin/events/$smoke_event_id"');
  assert.ok(
    submissionCleanup.indexOf('verify_submission_smoke_event_target "$smoke_event_id" 0') < archive
      && submissionCleanup.lastIndexOf('verify_submission_smoke_event_target "$smoke_event_id" 1') < deletion,
    "event cleanup must verify the recovered fixture before archive and delete"
  );
  const organizationCleanup = smoke.match(/cleanup_organization_target\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.ok(
    organizationCleanup.split('verify_organization_cleanup_target').length - 1 >= 3,
    "organization cleanup must refresh and verify identity before each destructive request"
  );
  const copiedFixtureVerification = smoke.indexOf('verify_submission_smoke_event_target "$smoke_event_id" 0', eventJson);
  const copiedFixtureRefresh = smoke.lastIndexOf('refresh_submission_cleanup_events', copiedFixtureVerification);
  const firstCopiedFixtureWrite = smoke.indexOf('assert_status "submission-event-registration-open" 200', eventJson);
  assert.ok(
    copiedFixtureRefresh > eventJson && copiedFixtureVerification > copiedFixtureRefresh
      && copiedFixtureVerification < firstCopiedFixtureWrite,
    "copied event and project must be refreshed and verified before the first fixture write"
  );
  const userCreate = smoke.indexOf('assert_status "submission-user-create" 201');
  const userPending = smoke.lastIndexOf('smoke_user_cleanup_pending=1', userCreate);
  assert.ok(userPending >= 0 && userPending < userCreate,
    "ordinary user cleanup intent must be locked before creating the user");
  assert.match(smoke, /recover_submission_smoke_user_id\(\)/);
  assert.match(smoke, /verify_submission_smoke_user_target\(\)/);
  const userCleanup = smoke.match(/cleanup_submission_user_smoke\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.ok(
    userCleanup.indexOf('verify_submission_smoke_user_target')
      < userCleanup.indexOf('-X DELETE'),
    "ordinary user cleanup must verify its exact identity before deletion"
  );
  assert.doesNotMatch(smoke, /\bsmoke_password=/);
  assert.match(smoke, /\. "\$script_dir\/smoke-credentials\.sh"/);
  assert.match(smoke, /smoke_extract_temporary_password "\$response_file" "\$smoke_user_temporary_password_file"/);
  assert.doesNotMatch(smoke, /echo[^\r\n]*(?:password|token|cookie)/i);
  assert.doesNotMatch(smoke, /\/api\/admin\/events\/\$smoke_event_id\/current/);
  assert.doesNotMatch(smoke, /\/api\/admin\/events\/\$original_current_event_id\/current/);
  assert.doesNotMatch(smoke, /submission-event-current/);
  assert.match(smoke, /"registrationMode":"force_open"/);
});

test("remote smoke verifies organization approval, registration eligibility, temporary passwords, and event removal", async () => {
  const smoke = await readFile(path.join(root, "deploy/remote-smoke-test.sh"), "utf8");

  assert.match(smoke, /assert_json_error_code\(\)/);
  assert.match(smoke, /assert_status "organization-pending-workspace" 403/);
  assert.match(smoke, /assert_json_error_code "organization-pending-workspace" "ORGANIZATION_REVIEW_PENDING"/);
  assert.match(smoke, /assert_status "submission-registration-unaffiliated" 403/);
  assert.match(smoke, /assert_json_error_code "submission-registration-unaffiliated" "ACTIVE_ORGANIZATION_REQUIRED"/);

  const pendingWorkspace = smoke.indexOf('assert_status "organization-pending-workspace" 403');
  const ownerApproval = smoke.indexOf('assert_status "organization-owner-review" 200');
  assert.ok(pendingWorkspace >= 0 && ownerApproval > pendingWorkspace,
    "pending organization access must be checked before administrator approval");

  const unaffiliatedRegistration = smoke.indexOf('assert_status "submission-registration-unaffiliated" 403');
  const membershipInvitation = smoke.indexOf('assert_status "submission-user-invitation" 201');
  assert.ok(unaffiliatedRegistration >= 0 && membershipInvitation > unaffiliatedRegistration,
    "ordinary registration must be rejected before the smoke user joins an organization");

  assert.match(smoke, /assert_status "submission-user-password-reset" 200/);
  assert.match(smoke, /data\.user\.mustChangePassword !== true/);
  assert.match(smoke, /assert_status "submission-user-password-repeat-view" 200/);
  assert.match(smoke, /cmp "\$smoke_reset_password_file" "\$smoke_repeat_password_file"/);
  assert.match(smoke, /smoke_user_phone="1\$\(printf '%s' "user-\$submission_token" \| cksum/);
  assert.doesNotMatch(smoke, /smoke_user_phone="1\$\(date \+%s\)"/);

  const eventCleanup = smoke.match(/cleanup_submission_event_smoke\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  const deletion = eventCleanup.indexOf('-X DELETE "$base_url/api/admin/events/$smoke_event_id"');
  const absenceCheck = eventCleanup.indexOf('verify_submission_smoke_event_absent "$smoke_event_id"');
  const cleanupComplete = eventCleanup.indexOf("smoke_event_cleanup_pending=0");
  assert.ok(deletion >= 0 && absenceCheck > deletion && cleanupComplete > absenceCheck,
    "event cleanup must verify the deleted id is absent before releasing cleanup intent");

  assert.doesNotMatch(smoke, /set -[^\r\n]*x/);
  assert.doesNotMatch(smoke, /echo[^\r\n]*(?:password|secret|key|token)/i);
});

function shellCommand() {
  if (process.platform !== "win32") return "sh";
  const candidates = [
    "C:\\Program Files\\Git\\bin\\sh.exe",
    "C:\\Program Files\\Git\\usr\\bin\\sh.exe"
  ];
  const shell = candidates.find((candidate) => existsSync(candidate));
  assert.ok(shell, "Git Bash sh is required to run the release script contract on Windows");
  return shell;
}

function runVerifier({ baseUrl, includeRelease = true, release = expectedRelease }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, BASE_URL: baseUrl };
    if (includeRelease) env.EXPECTED_RELEASE = release;
    else delete env.EXPECTED_RELEASE;
    const child = spawn(shellCommand(), ["deploy/verify-release.sh"], {
      cwd: root,
      env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("verify-release.sh timed out"));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("verify-release enforces the runtime API and hashed admin asset contract", async (t) => {
  const requests = [];
  const quote = String.fromCharCode(34);
  const oneEntry = `<script type=${quote}module${quote} src=${quote}/admin/assets/index-Ab_cd-12.js${quote}></script>`;
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const segments = requestUrl.pathname.split("/").filter(Boolean);
    const mode = segments.shift();
    const route = `/${segments.join("/")}`;
    requests.push({
      mode,
      route,
      query: requestUrl.search,
      cacheControl: request.headers["cache-control"]
    });

    if (route === "/api/system/version") {
      response.setHeader("Content-Type", "application/json");
      if (mode === "transport-error") {
        response.socket.destroy();
        return;
      }
      if (mode === "api-status") {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      if (mode === "malformed-json") {
        response.end(`{"releaseSha":"${expectedRelease}","apiVersion":1} trailing`);
        return;
      }
      response.end(JSON.stringify({
        releaseSha: mode === "wrong-release" ? "4".repeat(40) : expectedRelease,
        apiVersion: 1
      }));
      return;
    }
    if (route === "/api/public/features") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        smsLoginEnabled: false,
        smsPasswordResetEnabled: false,
        emailPasswordResetEnabled: true,
        captcha: { enabled: false, region: "cn", prefix: "", scenes: {} }
      }));
      return;
    }
    if (route === "/admin/index.html") {
      response.setHeader("Content-Type", "text/html");
      response.end(mode === "duplicate-asset" ? oneEntry + oneEntry : oneEntry);
      return;
    }
    if (route === "/admin/assets/index-Ab_cd-12.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(
        mode === "legacy-literal"
          ? `${expectedRelease} "/api/admin/registrations?pageSize=100"`
          : mode === "missing-account-lifecycle-contract"
            ? expectedRelease
            : `${expectedRelease} ORGANIZATION_REVIEW_PENDING ACTIVE_ORGANIZATION_REQUIRED temporary-password`
      );
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  await t.test("accepts matching API and admin releases", async () => {
    const result = await runVerifier({ baseUrl: `${origin}/success` });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stdout, new RegExp(`release-consistency=${expectedRelease}`));
    const successRequests = requests.filter(({ mode }) => mode === "success");
    assert.deepEqual(
      successRequests.map(({ route }) => route),
      ["/api/system/version", "/api/public/features", "/admin/index.html", "/admin/assets/index-Ab_cd-12.js"]
    );
    assert.equal(successRequests[0].cacheControl, "no-cache");
    assert.equal(successRequests[2].query, `?release-check=${expectedRelease}`);
  });

  await t.test("rejects a wrong API release before requesting admin HTML", async () => {
    const result = await runVerifier({ baseUrl: `${origin}/wrong-release` });
    assert.notEqual(result.code, 0);
    assert.deepEqual(
      requests.filter(({ mode }) => mode === "wrong-release").map(({ route }) => route),
      ["/api/system/version"]
    );
  });

  await t.test("rejects duplicate admin asset entries", async () => {
    const result = await runVerifier({ baseUrl: `${origin}/duplicate-asset` });
    assert.notEqual(result.code, 0);
  });

  await t.test("rejects the legacy registrations literal", async () => {
    const result = await runVerifier({ baseUrl: `${origin}/legacy-literal` });
    assert.notEqual(result.code, 0);
  });

  await t.test("rejects an admin asset without the organization account lifecycle contract", async () => {
    const result = await runVerifier({ baseUrl: `${origin}/missing-account-lifecycle-contract` });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /admin asset is missing organization account lifecycle contract/);
  });

  await t.test("rejects malformed version JSON before requesting admin HTML", async () => {
    const result = await runVerifier({ baseUrl: `${origin}/malformed-json` });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /system-version response was not the expected JSON/);
    assert.deepEqual(
      requests.filter(({ mode }) => mode === "malformed-json").map(({ route }) => route),
      ["/api/system/version"]
    );
  });

  await t.test("reports an HTTP status instead of letting curl hide it", async () => {
    const result = await runVerifier({ baseUrl: `${origin}/api-status` });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /system-version expected 200 but received 503/);
  });

  await t.test("reports a curl transport failure explicitly", async () => {
    const result = await runVerifier({ baseUrl: `${origin}/transport-error` });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /system-version request failed \(curl exit [1-9][0-9]*\)/);
  });

  await t.test("requires EXPECTED_RELEASE before making a request", async () => {
    const requestCount = requests.length;
    const result = await runVerifier({
      baseUrl: `${origin}/missing-expected-release`,
      includeRelease: false
    });
    assert.notEqual(result.code, 0);
    assert.equal(requests.length, requestCount);
  });

  for (const invalidRelease of ["abc", "g".repeat(40), `${"a".repeat(40)}0`]) {
    await t.test(`rejects invalid EXPECTED_RELEASE ${invalidRelease.length}/${invalidRelease[0]}`, async () => {
      const requestCount = requests.length;
      const result = await runVerifier({
        baseUrl: `${origin}/invalid-expected-release`,
        release: invalidRelease
      });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /EXPECTED_RELEASE must be exactly 40 hexadecimal characters/);
      assert.equal(requests.length, requestCount);
    });
  }
});
