import bcrypt from "bcryptjs";

export const isLegacyPassword = (value) => !String(value || "").startsWith("$2");

export const hashPassword = (value) => bcrypt.hash(String(value), 12);

export async function verifyPassword(value, stored) {
  if (isLegacyPassword(stored)) return String(value) === String(stored);
  return bcrypt.compare(String(value), stored);
}
