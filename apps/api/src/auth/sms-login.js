export class SmsLoginError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const normalizePhone = (value) => String(value || "").replace(/\D/g, "");

export function isSmsLoginEligible(db, user) {
  if (!user || user.status !== "active") return false;
  if (user.type !== "organization") return user.type === "ordinary" || user.type === "admin";
  const organization = db.organizations.find((row) => row.ownerUserId === user.id);
  return organization?.reviewStatus === "approved" && organization.status === "active";
}

export function createSmsLoginService({ challengeService, readDb, isEligible = isSmsLoginEligible }) {
  if (!challengeService) throw new Error("challengeService is required");
  const invalidCode = () => new SmsLoginError(422, "验证码无效或已过期");

  return {
    enabled: challengeService.enabled,
    request(input) {
      return challengeService.request(input);
    },
    async confirm({ phone: incomingPhone, code }) {
      const phone = normalizePhone(incomingPhone);
      if (!await challengeService.consume({ phone, code })) throw invalidCode();
      const db = await readDb();
      const user = db.users.find((row) => normalizePhone(row.phone) === phone);
      if (!isEligible(db, user)) throw invalidCode();
      return { db, user };
    }
  };
}
