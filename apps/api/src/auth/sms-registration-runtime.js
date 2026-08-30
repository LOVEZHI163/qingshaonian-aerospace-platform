import { createSmsChallengeService, SMS_PURPOSES } from "./sms-challenges.js";
import { createSmsRegistrationService } from "./sms-registration.js";

const normalizePhone = (value) => String(value || "").replace(/\D/g, "");

export function createSmsRegistrationRuntime({
  sessionSecret,
  readDb,
  smsProvider,
  authState,
  verifyHuman,
  clock = Date.now,
  generateCode,
  schedule
}) {
  const challengeService = createSmsChallengeService({
    purpose: SMS_PURPOSES.registration,
    secret: sessionSecret,
    readDb,
    smsProvider,
    authState,
    resolveEligibleTarget: (db, phone) => (
      db.users.some((item) => normalizePhone(item.phone) === phone) ? null : { phone }
    ),
    verifyHuman,
    clock,
    generateCode,
    schedule
  });
  return {
    smsRegistration: createSmsRegistrationService({
      challengeService,
      readDb,
      secret: sessionSecret,
      clock
    })
  };
}
