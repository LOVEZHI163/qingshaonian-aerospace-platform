import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "node:crypto";

import { validatePassword } from "./passwords.js";

const UPPERCASE = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const PASSWORD_CHARACTERS = `${UPPERCASE}${LOWERCASE}${DIGITS}`;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function readKey(secret) {
  if (!secret) throw new Error("TEMP_PASSWORD_ENCRYPTION_KEY is required");
  const encoded = String(secret);
  if (!BASE64.test(encoded)) throw new Error("TEMP_PASSWORD_ENCRYPTION_KEY must be valid base64");
  const key = Buffer.from(encoded, "base64");
  if (key.toString("base64") !== encoded) throw new Error("TEMP_PASSWORD_ENCRYPTION_KEY must be valid base64");
  if (key.length !== 32) throw new Error("TEMP_PASSWORD_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

function randomCharacter(characters) {
  return characters[randomInt(characters.length)];
}

export function createTemporaryPasswordVault(secret) {
  const key = readKey(secret);

  return {
    generate() {
      const characters = [
        randomCharacter(UPPERCASE),
        randomCharacter(LOWERCASE),
        randomCharacter(DIGITS),
        ...Array.from({ length: 13 }, () => randomCharacter(PASSWORD_CHARACTERS))
      ];
      for (let index = characters.length - 1; index > 0; index -= 1) {
        const swapIndex = randomInt(index + 1);
        [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
      }
      const password = characters.join("");
      if (validatePassword(password)) throw new Error("Generated temporary password does not satisfy the password policy");
      return password;
    },
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
      return {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64")
      };
    },
    open(record) {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8");
    },
    clear(user) {
      user.temporaryPasswordCiphertext = null;
      user.temporaryPasswordIv = null;
      user.temporaryPasswordTag = null;
      user.temporaryPasswordCreatedAt = null;
    }
  };
}
