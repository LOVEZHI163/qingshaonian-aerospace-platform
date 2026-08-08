import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const shell = process.platform === "win32"
  ? ["C:\\Program Files\\Git\\bin\\sh.exe", "C:\\Program Files\\Git\\usr\\bin\\sh.exe"].find(existsSync)
  : "sh";

test("smoke credential helper extracts a generated temporary password into a private file without stdout leakage", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-smoke-credential-"));
  try {
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir);
    const fakeDocker = path.join(binDir, "docker");
    await fs.writeFile(fakeDocker, `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = node ]; then shift; exec '${pathToPosix(process.execPath)}' "$@"; fi\n  shift\ndone\nexit 2\n`, { mode: 0o755 });
    const response = path.join(tempDir, "response.json");
    const secret = path.join(tempDir, "temporary-password");
    await fs.writeFile(response, JSON.stringify({ row: { id: "U1", mustChangePassword: true }, temporaryPassword: "Generated-Secret-9" }));

    const command = process.platform === "win32"
      ? `. ./deploy/smoke-credentials.sh; response=$(cygpath -u '${response}'); secret=$(cygpath -u '${secret}'); smoke_extract_temporary_password "$response" "$secret"`
      : `. ./deploy/smoke-credentials.sh; smoke_extract_temporary_password '${response}' '${secret}'`;
    const { stdout, stderr } = await execFileAsync(shell, ["-c", command], {
      cwd: root,
      env: { ...process.env, PATH: `${process.platform === "win32" ? pathToPosix(binDir) : binDir}:${process.env.PATH}` }
    });
    assert.equal(stdout, "");
    assert.equal(stderr, "");
    assert.equal(await fs.readFile(secret, "utf8"), "Generated-Secret-9");
    if (process.platform !== "win32") assert.equal((await fs.stat(secret)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("smoke credential helper rejects malformed creation responses without retaining an output file", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aerogp-smoke-credential-invalid-"));
  try {
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir);
    const fakeDocker = path.join(binDir, "docker");
    await fs.writeFile(fakeDocker, `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = node ]; then shift; exec '${pathToPosix(process.execPath)}' "$@"; fi\n  shift\ndone\nexit 2\n`, { mode: 0o755 });
    const response = path.join(tempDir, "response.json");
    const secret = path.join(tempDir, "temporary-password");
    await fs.writeFile(response, JSON.stringify({ row: { id: "U1" } }));
    const command = process.platform === "win32"
      ? `. ./deploy/smoke-credentials.sh; response=$(cygpath -u '${response}'); secret=$(cygpath -u '${secret}'); smoke_extract_temporary_password "$response" "$secret"`
      : `. ./deploy/smoke-credentials.sh; smoke_extract_temporary_password '${response}' '${secret}'`;
    await assert.rejects(execFileAsync(shell, ["-c", command], {
      cwd: root,
      env: { ...process.env, PATH: `${process.platform === "win32" ? pathToPosix(binDir) : binDir}:${process.env.PATH}` }
    }));
    await assert.rejects(fs.access(secret));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function pathToPosix(value) {
  return value.replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
}
