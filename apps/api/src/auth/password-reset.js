import { hashPassword, validatePassword } from "./passwords.js";
import { clearUserTemporaryPassword } from "../services/account-passwords.js";

class PasswordResetError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const normalizePhone = (value) => String(value || "").replace(/\D/g, "");

export function createSmsPasswordResetService({
  challengeService,
  readDb,
  writeDb,
  withMutationLock = (handler) => handler(),
  clearTemporaryPassword = clearUserTemporaryPassword
}) {
  if (!challengeService) throw new Error("challengeService is required");

  return {
    enabled: challengeService.enabled,
    request(input) {
      return challengeService.request(input);
    },
    async confirm({ phone: incomingPhone, code: incomingCode, password }) {
      const passwordError = validatePassword(password);
      if (passwordError) throw new PasswordResetError(422, passwordError);
      const phone = normalizePhone(incomingPhone);
      const valid = await challengeService.consume({ phone, code: incomingCode });
      if (!valid) throw new PasswordResetError(422, "验证码无效或已过期");

      await withMutationLock(async () => {
        const db = await readDb();
        const user = db.users.find((item) => normalizePhone(item.phone) === phone && item.status === "active");
        if (!user) throw new PasswordResetError(422, "验证码无效或已过期");
        user.password = await hashPassword(password);
        user.sessionVersion += 1;
        user.mustChangePassword = false;
        clearTemporaryPassword(user);
        await writeDb(db);
      });
      return { ok: true };
    }
  };
}

export function sendPasswordResetError(error, res) {
  if (!error?.statusCode) throw error;
  return res.status(error.statusCode).json({ error: error.message });
}
