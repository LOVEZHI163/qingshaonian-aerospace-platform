export class AccountPasswordError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function temporaryPasswordKeyUnavailable() {
  return new AccountPasswordError(503, "临时密码安全服务不可用，请联系系统管理员", "TEMP_PASSWORD_KEY_UNAVAILABLE");
}

export function clearUserTemporaryPassword(user) {
  user.temporaryPasswordCiphertext = null;
  user.temporaryPasswordIv = null;
  user.temporaryPasswordTag = null;
  user.temporaryPasswordCreatedAt = null;
}

export async function resetUserTemporaryPassword(db, user, { vault, hashPassword, now }) {
  if (!db || !user || !vault) throw new TypeError("db, user and vault are required");
  const temporaryPassword = vault.generate();
  const sealed = vault.seal(temporaryPassword);
  user.password = await hashPassword(temporaryPassword);
  user.temporaryPasswordCiphertext = sealed.ciphertext;
  user.temporaryPasswordIv = sealed.iv;
  user.temporaryPasswordTag = sealed.tag;
  user.temporaryPasswordCreatedAt = now();
  user.mustChangePassword = true;
  user.sessionVersion = Number(user.sessionVersion || 0) + 1;
  return { user, temporaryPassword };
}

export function readUserTemporaryPassword(user, vault) {
  if (!user || !vault) throw new TypeError("user and vault are required");
  if (!user.mustChangePassword
    || !user.temporaryPasswordCiphertext
    || !user.temporaryPasswordIv
    || !user.temporaryPasswordTag
    || !user.temporaryPasswordCreatedAt) return null;
  return vault.open({
    ciphertext: user.temporaryPasswordCiphertext,
    iv: user.temporaryPasswordIv,
    tag: user.temporaryPasswordTag
  });
}
