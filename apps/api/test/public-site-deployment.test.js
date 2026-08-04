import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withTestServer } from "../test-support/server.js";
const root = path.resolve(import.meta.dirname, "../../..");

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

test("web Docker build injects the public origin into the real Vite bundle", async () => {
  const [dockerfile, compose] = await Promise.all([
    read("Dockerfile.web"),
    read("compose.yaml")
  ]);

  assert.match(dockerfile, /^ARG VITE_PUBLIC_SITE_URL$/m);
  assert.match(dockerfile, /^ENV VITE_PUBLIC_SITE_URL=\$VITE_PUBLIC_SITE_URL$/m);
  assert.match(compose, /args:\s*\r?\n\s*VITE_PUBLIC_SITE_URL:\s*https:\/\/aerogp\.cn/);
  assert.doesNotMatch(dockerfile, /POSTGRES_PASSWORD|SESSION_SECRET|ACCESS_KEY_SECRET/);

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-vite-contract-"));
  const previous = process.env.VITE_PUBLIC_SITE_URL;
  process.env.VITE_PUBLIC_SITE_URL = "https://aerogp.cn";
  try {
    const { build } = await import("vite");
    await build({
      root: path.join(root, "apps/web"),
      configFile: false,
      logLevel: "silent",
      build: { outDir, emptyOutDir: true }
    });
    const assets = await fs.readdir(path.join(outDir, "assets"));
    const scripts = await Promise.all(
      assets.filter((name) => name.endsWith(".js")).map((name) => fs.readFile(path.join(outDir, "assets", name), "utf8"))
    );
    assert.equal(scripts.some((source) => source.includes("https://aerogp.cn")), true);
  } finally {
    if (previous === undefined) delete process.env.VITE_PUBLIC_SITE_URL;
    else process.env.VITE_PUBLIC_SITE_URL = previous;
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("container contract keeps private ports private and ships runtime assets", async () => {
  const [apiDockerfile, webDockerfile, compose] = await Promise.all([
    read("Dockerfile.api"),
    read("Dockerfile.web"),
    read("compose.yaml")
  ]);

  assert.match(apiDockerfile, /apk add --no-cache[^\r\n]*libc6-compat/);
  assert.match(apiDockerfile, /apk add --no-cache[^\r\n]*ffmpeg/);
  assert.match(apiDockerfile, /^USER node$/m);
  assert.match(webDockerfile, /COPY --from=build \/app\/apps\/web\/dist \/usr\/share\/nginx\/html/);
  await Promise.all([
    fs.access(path.join(root, "apps/web/public/brand/mark.svg")),
    fs.access(path.join(root, "apps/web/public/brand/wordmark.svg"))
  ]);
  assert.doesNotMatch(compose, /["'](?:4300|5432):/);
  assert.match(compose, /ports:\s*\r?\n\s*-\s*["']80:80["']/);
});

test("API container health check stays healthy when there is no current event", async () => {
  const compose = await read("compose.yaml");
  const healthPath = compose.match(/fetch\('http:\/\/127\.0\.0\.1:4300([^']+)'\)/)?.[1];

  assert.ok(healthPath, "API health check URL must be discoverable from compose.yaml");
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    db.events = [];
    db.eventPublicProfiles = [];
    await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");

    const response = await fetch(`${baseUrl}${healthPath}`);
    assert.equal(response.status, 200);
  }, { prefix: "aerogp-health-no-current-event-" });
});

test("nginx protects HTML and public media while caching immutable assets", async () => {
  const nginx = await read("deploy/nginx.conf");

  assert.match(nginx, /location \^~ \/api\/public\/media\/\s*\{[\s\S]*proxy_pass http:\/\/api_backend/);
  assert.match(nginx, /location \^~ \/api\/public\/media\/[\s\S]*X-Content-Type-Options[\s\S]*nosniff/);
  assert.match(nginx, /location \^~ \/api\/public\/media\/[\s\S]*Content-Security-Policy/);
  assert.match(nginx, /location \^~ \/api\/public\/media\/[\s\S]*Cache-Control[\s\S]*(?:immutable|max-age)/);
  assert.doesNotMatch(nginx, /alias\s+\/data\/uploads|root\s+\/data\/uploads/);
  assert.match(nginx, /location ~\* \\.html\$[\s\S]*Cache-Control "no-store"/);
  assert.match(nginx, /location ~\* \^\/(?:\(\?:admin\/\)\?)?assets\//);
  assert.match(nginx, /max-age=31536000[\s\S]*immutable/);
  assert.match(nginx, /location \^~ \/brand\//);
  assert.match(nginx, /location \/admin\/\s*\{[\s\S]*\/admin\/index\.html/);
  assert.match(nginx, /location \/\s*\{[\s\S]*\/index\.html/);
});

test("nginx streams only submission uploads with the enlarged request limit", async () => {
  const nginx = await read("deploy/nginx.conf");
  const uploadLocation = nginx.match(/location \^~ \/api\/upload-sessions\/\s*\{([\s\S]*?)\n  \}/)?.[1];
  const genericApiLocation = nginx.match(/location \/api\/\s*\{([\s\S]*?)\n  \}/)?.[1];

  assert.ok(uploadLocation, "submission upload location must precede the generic API location");
  assert.ok(genericApiLocation, "generic API location must remain present");
  assert.match(uploadLocation, /client_max_body_size 205m/);
  assert.match(uploadLocation, /proxy_request_buffering off/);
  assert.match(uploadLocation, /proxy_read_timeout 300s/);
  assert.doesNotMatch(genericApiLocation, /205m|proxy_request_buffering off|proxy_read_timeout 300s/);
  assert.ok(nginx.indexOf("location ^~ /api/upload-sessions/") < nginx.indexOf("location /api/"));
});

test("API enables submission-session expiry cleanup only in production", async () => {
  const server = await read("apps/api/src/server.js");

  assert.match(server, /import \{[^}]*startSubmissionSessionExpiryCleanup[^}]*\} from "\.\/services\/submission-assets\.js"/);
  assert.match(server, /process\.env\.NODE_ENV === "production"[\s\S]*startSubmissionSessionExpiryCleanup\(\{ store: dataStore \}\)/);
  assert.match(server, /stopSubmissionSessionExpiryCleanup\(\)/);
});

test("compose supplies upload session and disk-capacity thresholds to the API", async () => {
  const compose = await read("compose.yaml");
  const apiEnvironment = compose.match(/  api:\s*[\s\S]*?    environment:\s*([\s\S]*?)\n    volumes:/)?.[1];

  assert.ok(apiEnvironment, "API environment must be discoverable from compose");
  assert.match(apiEnvironment, /SUBMISSION_SESSION_TTL_MS:\s*86400000/);
  assert.match(apiEnvironment, /UPLOAD_WARNING_PERCENT:\s*80/);
  assert.match(apiEnvironment, /UPLOAD_CRITICAL_PERCENT:\s*90/);
});

test("nginx never makes unpublished media errors publicly cacheable", async () => {
  const nginx = await read("deploy/nginx.conf");
  const mediaLocation = nginx.match(/location \^~ \/api\/public\/media\/\s*\{([\s\S]*?)\n  \}/)?.[1];

  assert.ok(mediaLocation, "public media location must remain more specific than /api/");
  assert.match(mediaLocation, /add_header X-Content-Type-Options "nosniff" always/);
  assert.match(mediaLocation, /add_header Content-Security-Policy [^\r\n]+ always/);
  assert.match(mediaLocation, /add_header Content-Disposition "inline" always/);
  assert.match(mediaLocation, /add_header Cache-Control "public, max-age=604800, immutable";/);
  assert.doesNotMatch(mediaLocation, /add_header Cache-Control [^\r\n]+ always/);
});

test("backup and preflight cover site media, capacity, health, and port boundaries", async () => {
  const [backup, preflight] = await Promise.all([
    read("deploy/backup-uploads.sh"),
    read("deploy/preflight-admin-upgrade.sh")
  ]);

  assert.match(backup, /tar -C "\$uploads_dir" -czf "\$temp" \./);
  assert.match(backup, /site-media/);
  assert.match(preflight, /pg_restore --list/);
  assert.match(preflight, /verify-uploads-backup\.sh/);
  assert.match(preflight, /site-media/);
  assert.match(preflight, /available disk space/);
  for (const service of ["postgres", "api", "web", "backup"]) {
    assert.equal(preflight.includes(`for service in postgres api web backup`), true, service);
  }
  assert.match(preflight, /API port 4300 must not be published/);
  assert.match(preflight, /PostgreSQL port 5432 must not be published/);
  assert.match(preflight, /web port 80 must be published/);
  assert.doesNotMatch(preflight, /docker compose up/);
});

test("remote smoke discovers public resources dynamically and checks admin authorization", async () => {
  const smoke = await read("deploy/remote-smoke-test.sh");

  const labels = [
    "healthz",
    "home",
    "admin",
    "public-home",
    "public-content",
    "sitemap",
    "brand-mark",
    "brand-wordmark",
    "system-version",
    "admin-events",
    "account-events",
    "admin-registrations-legacy-rejected",
    "admin-registrations-event",
    "authenticated-site-settings",
    "authenticated-site-content",
    "unauthenticated-site-settings",
    "submission-event-copy",
    "submission-session-create",
    "submission-image-upload",
    "submission-video-upload",
    "submission-registration-bind",
    "submission-account-registration-history",
    "submission-account-certificate-history",
    "submission-admin-summary",
    "submission-private-unauthorized"
  ];
  let last = -1;
  for (const label of labels) {
    const index = smoke.indexOf(`\"${label}\"`);
    assert.ok(index > last, `${label} must appear in smoke order`);
    last = index;
  }
  assert.match(smoke, /featuredEvent[\s\S]*concurrentEvents/);
  assert.match(smoke, /encodeURIComponent/);
  assert.match(smoke, /public-event-skipped=no-public-event/);
  assert.match(smoke, /public-content-detail-skipped=no-public-content/);
  assert.match(smoke, /status === "published" && !item\.archivedAt/);
  assert.match(smoke, /smoke_source_event_id="\$event_id"/);
  assert.match(smoke, /\/api\/admin\/events\/\$smoke_source_event_id\/copy/);
  assert.doesNotMatch(smoke, /No current published event is available/);
  const eventListResponse = smoke.indexOf('assert_json_response "admin-events"');
  const currentEventCapture = smoke.indexOf('original_current_event_id="$(json_path', eventListResponse);
  const nextAdminRequest = smoke.indexOf('assert_status "admin-organizations"', eventListResponse);
  assert.ok(eventListResponse >= 0 && currentEventCapture > eventListResponse && currentEventCapture < nextAdminRequest,
    "the original current event must be captured before the shared response file is overwritten");
  assert.match(smoke, /\/api\/admin\/events\/\$\{event_id\}\/registrations/);
  assert.match(smoke, /\/api\/admin\/registrations/);
  assert.match(smoke, /work_dir="\$\(mktemp -d /);
  assert.match(smoke, /response_file="\$work_dir\/response\.json"/);
  assert.match(smoke, /cookie_jar="\$work_dir\/cookies"/);
  assert.doesNotMatch(smoke, /\/tmp\/aerogp-smoke-[^\r\n]*\$\$/);
  assert.match(smoke, /trap 'handle_exit' 0/);
  assert.match(smoke, /handle_exit\(\) \{[\s\S]*?status="\$\?"[\s\S]*?if ! cleanup; then[\s\S]*?if \[ "\$status" -eq 0 \]; then[\s\S]*?status=1[\s\S]*?exit "\$status"/);
  for (const [signal, status] of [
    ["HUP", 129],
    ["INT", 130],
    ["TERM", 143]
  ]) {
    assert.match(smoke, new RegExp(`trap 'handle_signal ${signal} ${status}' ${signal}`));
  }
  assert.match(smoke, /handle_signal\(\) \{[\s\S]*?if ! cleanup; then[\s\S]*?exit "\$status"/);
  assert.doesNotMatch(smoke, /\/api\/public\/events\/(?:E\d+|[a-z0-9-]{4,})["']/i);
  assert.doesNotMatch(smoke, /set -[^\r\n]*x/);
  assert.doesNotMatch(smoke, /echo[^\r\n]*(?:password|cookie)|cat[^\r\n]*(?:cookie|response)/i);
  assert.match(smoke, /base64 -d/);
  assert.match(smoke, /docker compose exec -T api ffmpeg/);
  assert.match(smoke, /cleanup_submission_smoke\(\)/);
  assert.match(smoke, /smoke_password="Smoke-\$\{submission_token\}/);
  assert.doesNotMatch(smoke, /SmokeSubmission!2026/);
});
