import bcrypt from "bcryptjs";

const DUMMY_PASSWORD_HASH = "$2b$12$kNjNKYCdGTg4MqmixCKtCef4X/67YNoukU4h9wliHNkSne0fWICca";

export const isLegacyPassword = (value) => !String(value || "").startsWith("$2");

export const hashPassword = (value) => bcrypt.hash(String(value), 12);

export function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 8) return "密码至少 8 位";
  if (password.length > 64) return "密码最多 64 位";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "密码必须同时包含字母和数字";
  return null;
}

export async function verifyPassword(value, stored) {
  if (isLegacyPassword(stored)) return String(value) === String(stored);
  return bcrypt.compare(String(value), stored);
}

export async function verifyLoginPassword(value, stored) {
  if (stored && !isLegacyPassword(stored)) return bcrypt.compare(String(value || ""), stored);
  await bcrypt.compare(String(value || ""), DUMMY_PASSWORD_HASH);
  return stored ? String(value) === String(stored) : false;
}
