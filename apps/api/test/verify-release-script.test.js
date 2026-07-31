import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const expectedRelease = "release-123";

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

function runVerifier({ baseUrl, includeRelease = true }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, BASE_URL: baseUrl };
    if (includeRelease) env.EXPECTED_RELEASE = expectedRelease;
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
      response.end(JSON.stringify({
        releaseSha: mode === "wrong-release" ? "other-release" : expectedRelease
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
          : expectedRelease
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
    assert.match(result.stdout, /release-consistency=release-123/);
    const successRequests = requests.filter(({ mode }) => mode === "success");
    assert.deepEqual(
      successRequests.map(({ route }) => route),
      ["/api/system/version", "/admin/index.html", "/admin/assets/index-Ab_cd-12.js"]
    );
    assert.equal(successRequests[0].cacheControl, "no-cache");
    assert.equal(successRequests[1].query, "?release-check=release-123");
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

  await t.test("requires EXPECTED_RELEASE before making a request", async () => {
    const requestCount = requests.length;
    const result = await runVerifier({
      baseUrl: `${origin}/missing-expected-release`,
      includeRelease: false
    });
    assert.notEqual(result.code, 0);
    assert.equal(requests.length, requestCount);
  });
});
