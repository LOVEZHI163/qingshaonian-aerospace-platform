import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
  assert.match(apiDockerfile, /^USER node$/m);
  assert.match(webDockerfile, /COPY --from=build \/app\/apps\/web\/dist \/usr\/share\/nginx\/html/);
  await Promise.all([
    fs.access(path.join(root, "apps/web/public/brand/mark.svg")),
    fs.access(path.join(root, "apps/web/public/brand/wordmark.svg"))
  ]);
  assert.doesNotMatch(compose, /["'](?:4300|5432):/);
  assert.match(compose, /ports:\s*\r?\n\s*-\s*["']80:80["']/);
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
    "authenticated-site-settings",
    "authenticated-site-content",
    "unauthenticated-site-settings"
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
  assert.doesNotMatch(smoke, /\/api\/public\/events\/(?:E\d+|[a-z0-9-]{4,})["']/i);
  assert.doesNotMatch(smoke, /set -[^\r\n]*x/);
  assert.doesNotMatch(smoke, /echo[^\r\n]*(?:password|cookie)|cat[^\r\n]*(?:cookie|response)/i);
});
