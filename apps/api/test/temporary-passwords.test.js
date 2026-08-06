import assert from "node:assert/strict";
import test from "node:test";

import { validatePassword } from "../src/auth/passwords.js";
import { createTemporaryPasswordVault } from "../src/auth/temporary-passwords.js";

test("temporary password is encrypted, decryptable, and clearable", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const vault = createTemporaryPasswordVault(key);
  const password = vault.generate();
  const sealed = vault.seal(password);

  assert.equal(validatePassword(password), null);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[a-z]/);
  assert.match(password, /\d/);
  assert.notEqual(sealed.ciphertext, password);
  assert.equal(vault.open(sealed), password);

  const user = {
    temporaryPasswordCiphertext: sealed.ciphertext,
    temporaryPasswordIv: sealed.iv,
    temporaryPasswordTag: sealed.tag,
    temporaryPasswordCreatedAt: new Date().toISOString()
  };
  vault.clear(user);
  assert.deepEqual(user, {
    temporaryPasswordCiphertext: null,
    temporaryPasswordIv: null,
    temporaryPasswordTag: null,
    temporaryPasswordCreatedAt: null
  });
});

test("temporary password vault rejects a missing or non-32-byte key", () => {
  assert.throws(() => createTemporaryPasswordVault(""), /TEMP_PASSWORD_ENCRYPTION_KEY/);
  assert.throws(() => createTemporaryPasswordVault(Buffer.alloc(16).toString("base64")), /32 bytes/);
  assert.throws(() => createTemporaryPasswordVault(`!!!!${Buffer.alloc(32, 7).toString("base64")}`), /base64/i);
});
