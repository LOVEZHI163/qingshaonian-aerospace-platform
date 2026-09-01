import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const rollbackScript = path.join(root, "deploy/rollback/run-legacy-sms-disabled.sh");
const rollbackVerifier = path.join(root, "deploy/rollback/verify-legacy-sms-disabled.sh");
const legacyPrePurposeRevision = "d6f68390da84780e7d74e9c1149fdd35b0cdd9df";

function shellCommand() {
  if (process.platform !== "win32") return "sh";
  return "C:\\Program Files\\Git\\bin\\sh.exe";
}

function shellPath(value) {
  if (process.platform !== "win32") return value;
  return value.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function runFile(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function startServer(serverPath, cwd, env) {
  const child = spawn(process.execPath, [serverPath], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`legacy API did not start: ${stderr}`));
    }, 15_000);
    child.stdout.on("data", () => {
      const match = stdout.match(/API listening on http:\/\/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(`http://127.0.0.1:${match[1]}`);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`legacy API exited before startup (${code}): ${stderr}`));
    });
  });
  return { child, baseUrl };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    await runFile("taskkill", ["/pid", String(child.pid), "/f", "/t"], { windowsHide: true }).catch(() => {});
  } else {
    child.kill("SIGKILL");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
}

test("legacy rollback wrapper clears SMS inputs before Compose and retains email inputs", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-legacy-sms-rollback-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const releaseDir = path.join(tempDir, "archived-release");
  const fakeDocker = path.join(tempDir, "fake-docker.sh");
  const evidence = path.join(tempDir, "docker-evidence.json");
  await fs.mkdir(releaseDir, { recursive: true });
  await fs.writeFile(path.join(releaseDir, "compose.yaml"), "services: {}\n", "utf8");
  await fs.writeFile(fakeDocker, [
    "#!/bin/sh",
    "set -eu",
    "test \"$ALIBABA_CLOUD_ACCESS_KEY_ID\" = \"\"",
    "test \"$ALIBABA_CLOUD_ACCESS_KEY_SECRET\" = \"\"",
    "test \"$ALIYUN_SMS_SIGN_NAME\" = \"\"",
    "test \"$ALIYUN_SMS_TEMPLATE_CODE\" = \"\"",
    "test \"$ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE\" = \"\"",
    "test \"$ALIYUN_SMS_LOGIN_TEMPLATE_CODE\" = \"\"",
    "test \"$ALIYUN_SMS_RESET_TEMPLATE_CODE\" = \"\"",
    "test \"$DIRECTMAIL_SMTP_USER\" = \"email-user-is-retained\"",
    "test \"$DIRECTMAIL_SMTP_PASSWORD\" = \"email-password-is-retained\"",
    "printf '%s\\n' \"$@\" > \"$ROLLBACK_EVIDENCE_FILE\""
  ].join("\n"), "utf8");
  await fs.chmod(fakeDocker, 0o700);

  const result = await run(shellCommand(), [rollbackScript, releaseDir, "-d", "--wait"], {
    cwd: root,
    env: {
      ...process.env,
      DOCKER_BIN: shellPath(fakeDocker),
      ROLLBACK_EVIDENCE_FILE: evidence,
      ALIBABA_CLOUD_ACCESS_KEY_ID: "current-access-key-id",
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: "current-access-key-secret",
      ALIYUN_SMS_SIGN_NAME: "current-sign-name",
      ALIYUN_SMS_TEMPLATE_CODE: "legacy-template-must-not-survive",
      ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE: "current-registration-template",
      ALIYUN_SMS_LOGIN_TEMPLATE_CODE: "current-login-template",
      ALIYUN_SMS_RESET_TEMPLATE_CODE: "current-reset-template",
      DIRECTMAIL_SMTP_USER: "email-user-is-retained",
      DIRECTMAIL_SMTP_PASSWORD: "email-password-is-retained"
    }
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  const args = (await fs.readFile(evidence, "utf8")).trim().split(/\r?\n/);
  assert.deepEqual(args.slice(0, 2), ["compose", "--project-directory"]);
  assert.match(args[2].replaceAll("\\", "/"), /\/archived-release$/);
  assert.deepEqual(args.slice(3, 4), ["-f"]);
  assert.match(args[4].replaceAll("\\", "/"), /\/archived-release\/compose\.yaml$/);
  assert.deepEqual(args.slice(5), [
    "-f",
    args[6],
    "up",
    "-d",
    "--wait"
  ]);
  assert.match(args[6].replaceAll("\\", "/"), /\/deploy\/rollback\/legacy-sms-disabled\.compose\.yaml$/);
});

test("legacy rollback verifier proves migrations remain and password and email routes stay available", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-legacy-sms-verify-"));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const releaseDir = path.join(tempDir, "archived-release");
  const fakeDocker = path.join(tempDir, "fake-docker.sh");
  const fakeCurl = path.join(tempDir, "fake-curl.sh");
  const passwordFile = path.join(tempDir, "password");
  await fs.mkdir(releaseDir, { recursive: true });
  await fs.writeFile(path.join(releaseDir, "compose.yaml"), "services: {}\n", "utf8");
  await fs.writeFile(passwordFile, "rollback-password", "utf8");
  await fs.chmod(passwordFile, 0o600);
  await fs.writeFile(fakeDocker, [
    "#!/bin/sh",
    "set -eu",
    "test \"$ALIBABA_CLOUD_ACCESS_KEY_ID\" = \"\"",
    "test \"$ALIYUN_SMS_TEMPLATE_CODE\" = \"\"",
    "test \"$DIRECTMAIL_SMTP_USER\" = \"email-user-is-retained\"",
    "test \"$1\" = compose",
    "test \"$8\" = exec",
    "printf 3"
  ].join("\n"), "utf8");
  await fs.writeFile(fakeCurl, [
    "#!/bin/sh",
    "set -eu",
    "output=",
    "last=",
    "while test \"$#\" -gt 0; do",
    "  if test \"$1\" = -o; then output=\"$2\"; shift 2; continue; fi",
    "  last=\"$1\"",
    "  shift",
    "done",
    "case \"$last\" in",
    "  */api/public/features) printf '%s' '{\"smsPasswordResetEnabled\":false,\"emailPasswordResetEnabled\":true}' > \"$output\" ;;",
    "  */api/auth/login) printf '%s' '{\"user\":{\"id\":\"U-legacy\"}}' > \"$output\" ;;",
    "  */api/auth/password-reset/email/request) printf '%s' '{\"ok\":true}' > \"$output\" ;;",
    "  *) exit 91 ;;",
    "esac",
    "printf 200"
  ].join("\n"), "utf8");
  await fs.chmod(fakeDocker, 0o700);
  await fs.chmod(fakeCurl, 0o700);

  const result = await run(shellCommand(), [rollbackVerifier, releaseDir], {
    cwd: root,
    env: {
      ...process.env,
      DOCKER_BIN: shellPath(fakeDocker),
      CURL_BIN: shellPath(fakeCurl),
      ROLLBACK_SMOKE_PHONE: "13800000001",
      ROLLBACK_SMOKE_PASSWORD_FILE: shellPath(passwordFile),
      DIRECTMAIL_SMTP_USER: "email-user-is-retained",
      ALIBABA_CLOUD_ACCESS_KEY_ID: "current-access-key-id",
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: "current-access-key-secret",
      ALIYUN_SMS_TEMPLATE_CODE: "legacy-template-must-not-survive"
    }
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /legacy-sms-disabled rollback smoke passed/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /rollback-password|current-access-key|legacy-template/i);
});

test("pre-purpose baseline starts with SMS disabled while password and email routes remain usable", async (t) => {
  const archiveDir = await fs.mkdtemp(path.join(root, "apps/api/.legacy-sms-rollback-"));
  const archiveFile = path.join(archiveDir, "legacy.tar");
  const dbPath = path.join(archiveDir, "legacy-db.json");
  t.after(() => fs.rm(archiveDir, { recursive: true, force: true }));
  await runFile("git", ["archive", "--format=tar", `--output=${archiveFile}`, legacyPrePurposeRevision, "apps/api"], { cwd: root });
  await runFile("tar", ["-xf", archiveFile, "-C", archiveDir], { cwd: root });
  const legacyApiDir = path.join(archiveDir, "apps/api");
  const { child, baseUrl } = await startServer(path.join(legacyApiDir, "src/server.js"), legacyApiDir, {
    ...process.env,
    NODE_ENV: "test",
    PORT: "0",
    DB_PATH: dbPath,
    UPLOAD_ROOT: path.join(archiveDir, "uploads"),
    SESSION_SECRET: "legacy-rollback-session-secret-32-characters",
    TEMP_PASSWORD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    REGISTRATION_ID_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
    ALIBABA_CLOUD_ACCESS_KEY_ID: "",
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: "",
    ALIYUN_SMS_SIGN_NAME: "",
    ALIYUN_SMS_TEMPLATE_CODE: "",
    ALIYUN_SMS_REGISTRATION_TEMPLATE_CODE: "",
    ALIYUN_SMS_LOGIN_TEMPLATE_CODE: "",
    ALIYUN_SMS_RESET_TEMPLATE_CODE: "",
    DIRECTMAIL_SMTP_HOST: "smtp.invalid.example",
    DIRECTMAIL_SMTP_PORT: "465",
    DIRECTMAIL_SMTP_USER: "rollback-email-user",
    DIRECTMAIL_SMTP_PASSWORD: "rollback-email-password",
    DIRECTMAIL_FROM: "noreply@invalid.example"
  });
  try {
    const features = await fetch(`${baseUrl}/api/public/features`);
    assert.equal(features.status, 200);
    assert.deepEqual(await features.json(), {
      smsPasswordResetEnabled: false,
      emailPasswordResetEnabled: true
    });
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800000001", password: "123456" })
    });
    assert.equal(login.status, 200);
    const emailReset = await fetch(`${baseUrl}/api/auth/password-reset/email/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "rollback-sms-disabled-check@invalid.example" })
    });
    assert.equal(emailReset.status, 200);
    assert.equal((await emailReset.json()).ok, true);
  } finally {
    await stopServer(child);
  }
});
