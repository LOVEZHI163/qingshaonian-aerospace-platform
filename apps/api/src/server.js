import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import AdmZip from "adm-zip";
import { hashPassword, isLegacyPassword, validatePassword, verifyLoginPassword } from "./auth/passwords.js";
import { createSmsPasswordResetService, sendPasswordResetError } from "./auth/password-reset.js";
import { asyncRoute, createSessionMiddleware, requireAdmin, requirePasswordReady, requireUser } from "./auth/session.js";
import { createAliyunSmsProvider } from "./auth/sms.js";
import { createDataStore } from "./data/index.js";
import { createEventsRouter } from "./routes/events.js";
import { projectForHistoricalRegistration, registrationContext } from "./services/events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadRoot = process.env.UPLOAD_ROOT ? path.resolve(process.env.UPLOAD_ROOT) : path.resolve(__dirname, "../uploads");
const certificateUploadDir = path.join(uploadRoot, "certificates");
const PORT = Number(process.env.PORT || 4300);
const dataStore = createDataStore();
const readDb = () => dataStore.readDb();
const writeDb = (db) => dataStore.writeDb(db);
const smsProvider = createAliyunSmsProvider(process.env);
const smsPasswordReset = createSmsPasswordResetService({
  secret: process.env.SESSION_SECRET || "test-session-secret-32-characters",
  readDb,
  writeDb,
  smsProvider,
  authState: dataStore.authState
});

function id(prefix) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function now() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, "").toLowerCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function athleteKey(athlete) {
  return [
    normalizeText(athlete.name),
    normalizeText(athlete.school),
    normalizeText(athlete.grade),
    normalizePhone(athlete.phone)
  ].join("|");
}

function publicUser(user) {
  if (!user) return null;
  const { password, sessionVersion, ...safe } = user;
  return safe;
}

const MANAGED_MEMBERSHIP_ROLES = ["manager", "member"];

function organizationRole(db, userId, organizationId) {
  const user = db.users.find((item) => item.id === userId);
  if (user?.type === "admin") return "admin";
  return db.memberships.find(
    (item) => item.userId === userId && item.organizationId === organizationId && item.status === "active"
  )?.role || null;
}

function canManageOrganization(db, userId, organizationId) {
  return ["admin", "owner", "manager"].includes(organizationRole(db, userId, organizationId));
}

function canGrantOrganizationRole(db, userId, organizationId, role) {
  const currentRole = organizationRole(db, userId, organizationId);
  if (["admin", "owner"].includes(currentRole)) return MANAGED_MEMBERSHIP_ROLES.includes(role);
  return currentRole === "manager" && role === "member";
}

function canManageMembership(db, userId, membership, nextRole) {
  if (membership.role === "owner") return false;
  const currentRole = organizationRole(db, userId, membership.organizationId);
  if (["admin", "owner"].includes(currentRole)) {
    return MANAGED_MEMBERSHIP_ROLES.includes(membership.role) && MANAGED_MEMBERSHIP_ROLES.includes(nextRole);
  }
  return currentRole === "manager" && membership.role === "member" && nextRole === "member";
}

function activeMemberIdsForManagedOrganizations(db, userId, organizationId = null) {
  const orgIds = db.organizations
    .filter((organization) => (!organizationId || organization.id === organizationId) && canManageOrganization(db, userId, organization.id))
    .map((organization) => organization.id);
  const memberIds = db.memberships
    .filter((membership) => orgIds.includes(membership.organizationId) && membership.status === "active" && membership.userId)
    .map((membership) => membership.userId);
  return [...new Set(memberIds)];
}

function canAccessRegistration(db, userId, registration) {
  if (!registration) return false;
  if (db.users.some((item) => item.id === userId && item.type === "admin")) return true;
  if (registration.userId === userId) return true;
  if (!registration.organizationId || !canManageOrganization(db, userId, registration.organizationId)) return false;
  return db.memberships.some((membership) =>
    membership.userId === registration.userId
    && membership.organizationId === registration.organizationId
    && membership.status === "active"
  );
}

function canAccessCertificate(db, userId, certificate, { includeDraft = false } = {}) {
  if (!certificate) return false;
  if (!includeDraft && certificate.status !== "published") return false;
  const registration = db.registrations.find((row) => row.id === certificate.registrationId);
  return canAccessRegistration(db, userId, registration);
}

function certificatePayload(certificate, registration) {
  return {
    ...certificate,
    registration,
    athlete: registration?.athlete,
    projectName: registration?.projectName,
    organization: registration?.organization || ""
  };
}

function publicCertificatePayload(certificate, registration) {
  const { filePath, storedName, ...safe } = certificatePayload(certificate, registration);
  return safe;
}

function safeFileName(fileName) {
  return path.basename(String(fileName || "certificate.pdf")).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
}

async function saveCertificateFile({ fileName, buffer }) {
  await fs.mkdir(certificateUploadDir, { recursive: true });
  const storedName = `${Date.now()}-${Math.floor(Math.random() * 1000)}-${safeFileName(fileName)}`;
  const filePath = path.join(certificateUploadDir, storedName);
  await fs.writeFile(filePath, buffer);
  return { storedName, filePath };
}

function updateCertificateFromRegistration(certificate, registration) {
  certificate.userId = registration.userId || null;
  certificate.organizationId = registration.organizationId || null;
  certificate.awardName = registration.awardName || certificate.awardName || "";
  certificate.rank = registration.rank || certificate.rank || "";
  certificate.score = registration.score || certificate.score || "";
}

function findCertificateByRegistration(db, registrationId) {
  return db.certificates.find((item) => item.registrationId === registrationId);
}

function organizationForOwner(db, userId) {
  return db.organizations.find((item) => item.ownerUserId === userId);
}

function createOrganizationForUser(db, user, { organizationName, organizationCode } = {}) {
  const organization = {
    id: id("O"),
    name: organizationName || `${user.name}组织`,
    code: organizationCode || `ORG-${normalizePhone(user.phone).slice(-4)}`,
    ownerUserId: user.id,
    contactName: user.name,
    contactPhone: user.phone,
    status: "active",
    createdAt: now()
  };
  db.organizations.push(organization);
  db.memberships.push({
    id: id("M"),
    userId: user.id,
    organizationId: organization.id,
    role: "owner",
    status: "active",
    direction: "system",
    note: "管理员创建组织用户",
    createdAt: now(),
    updatedAt: now()
  });
  return organization;
}

function userOrganizations(db, userId) {
  const memberships = db.memberships.filter((item) => item.userId === userId && item.status === "active");
  return memberships
    .map((membership) => ({
      ...db.organizations.find((organization) => organization.id === membership.organizationId),
      membershipRole: membership.role
    }))
    .filter(Boolean);
}

function validateRegistration(input, existingRows, project, eventId, ignoreId = null) {
  const errors = [];
  const athlete = input.athlete || {};
  const required = [
    ["name", "姓名"],
    ["school", "学校"],
    ["grade", "年级"],
    ["phone", "手机号/家长手机号"],
    ["group", "组别"],
    ["projectId", "赛项"]
  ];

  for (const [key, label] of required) {
    if (!String(input[key] ?? athlete[key] ?? "").trim()) errors.push(`${label}不能为空`);
  }

  const nextKey = athleteKey(athlete);
  const nextType = project?.type || "individual";
  const activeRows = existingRows.filter((row) => row.id !== ignoreId && row.eventId === eventId && row.status !== "cancelled");
  const sameAthleteRows = activeRows.filter((row) => row.athleteKey === nextKey);
  const hasSameType = sameAthleteRows.some((row) => row.projectType === nextType);

  if (hasSameType) {
    errors.push(nextType === "individual" ? "该运动员已报名一个个人赛" : "该运动员已报名一个团体赛");
  }

  return { ok: errors.length === 0, errors, athleteKey: nextKey, projectType: nextType, duplicateCount: sameAthleteRows.length };
}

const app = express();
app.set("trust proxy", 1);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(createSessionMiddleware({ env: process.env, dataStore }));
app.use(asyncRoute(async (req, _res, next) => {
  if (req.session.userId) {
    const db = await readDb();
    req.user = db.users.find((user) =>
      user.id === req.session.userId
      && user.status === "active"
      && user.sessionVersion === req.session.sessionVersion
    );
  }
  next();
}));

app.use("/api", createEventsRouter({
  store: dataStore,
  requireAdmin,
  requirePasswordReady,
  asyncRoute,
  makeId: id
}));

app.get("/api/public/features", (_req, res) => {
  res.json({ smsPasswordResetEnabled: smsPasswordReset.enabled });
});

app.post("/api/auth/register", asyncRoute(async (req, res) => {
  const db = await readDb();
  const { name, phone, password, type = "ordinary", organizationName, organizationCode } = req.body;
  if (!name || !phone || !password) return res.status(422).json({ error: "姓名、手机号和密码不能为空" });
  if (!["ordinary", "organization"].includes(type)) return res.status(422).json({ error: "账号类型不合法" });
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(422).json({ error: passwordError });
  const normalizedPhone = normalizePhone(phone);
  if (db.users.some((user) => normalizePhone(user.phone) === normalizedPhone)) return res.status(409).json({ error: "该手机号已注册" });

  const user = {
    id: id("U"), name, phone: normalizedPhone, password: await hashPassword(password), type, status: "active",
    sessionVersion: 0, mustChangePassword: false, createdAt: now()
  };
  db.users.push(user);

  let organization = null;
  if (type === "organization") {
    if (!organizationName) return res.status(422).json({ error: "组织用户注册时必须填写组织名称" });
    organization = {
      id: id("O"),
      name: organizationName,
      code: organizationCode || `ORG-${normalizedPhone.slice(-4)}`,
      ownerUserId: user.id,
      contactName: user.name,
      contactPhone: user.phone,
      status: "active",
      createdAt: now()
    };
    db.organizations.push(organization);
    db.memberships.push({
      id: id("M"),
      userId: user.id,
      organizationId: organization.id,
      role: "owner",
      status: "active",
      direction: "system",
      note: "组织注册自动创建",
      createdAt: now(),
      updatedAt: now()
    });
  }

  await writeDb(db);
  res.status(201).json({ user: publicUser(user), organization });
}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const attemptTime = Date.now();
  const rateKeys = [`login:phone:${phone}`, `login:ip:${req.ip}`];
  const allowed = await dataStore.authState.consumeRateLimits([
    { key: rateKeys[0], limit: 5, windowMs: 15 * 60 * 1000 },
    { key: rateKeys[1], limit: 20, windowMs: 15 * 60 * 1000 }
  ], attemptTime);
  if (!allowed) return res.status(429).json({ error: "登录尝试过于频繁，请稍后再试" });
  const db = await readDb();
  const user = db.users.find((item) => normalizePhone(item.phone) === phone && item.status === "active");
  if (!(await verifyLoginPassword(req.body.password, user?.password))) {
    return res.status(401).json({ error: "手机号或密码错误" });
  }
  await dataStore.authState.releaseRateLimits(rateKeys, attemptTime);
  if (isLegacyPassword(user.password)) {
    user.password = await hashPassword(req.body.password);
    await writeDb(db);
  }
  await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.userId = user.id;
  req.session.sessionVersion = user.sessionVersion;
  await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
  res.json({ user: publicUser(user), organizations: userOrganizations(db, user.id) });
}));

app.get("/api/auth/me", requireUser, asyncRoute(async (req, res) => {
  const db = await readDb();
  res.json({ user: publicUser(req.user), organizations: userOrganizations(db, req.user.id) });
}));

app.post("/api/auth/change-password", requireUser, asyncRoute(async (req, res) => {
  const db = await readDb();
  const user = db.users.find((item) => item.id === req.user.id);
  if (!user || !(await verifyLoginPassword(req.body.currentPassword, user.password))) {
    return res.status(401).json({ error: "当前密码错误" });
  }
  const passwordError = validatePassword(req.body.newPassword);
  if (passwordError) return res.status(422).json({ error: passwordError });
  if (await verifyLoginPassword(req.body.newPassword, user.password)) {
    return res.status(422).json({ error: "新密码不能与当前密码相同" });
  }
  user.password = await hashPassword(req.body.newPassword);
  user.sessionVersion += 1;
  user.mustChangePassword = false;
  await writeDb(db);
  req.session.sessionVersion = user.sessionVersion;
  await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
  res.json({ user: publicUser(user) });
}));

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  await new Promise((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
  res.clearCookie("aerogp.sid", { path: "/", httpOnly: true, sameSite: "lax", secure: req.secure });
  res.json({ ok: true });
}));

app.post("/api/auth/password-reset/sms/request", asyncRoute(async (req, res) => {
  try {
    res.json(await smsPasswordReset.request({ phone: req.body.phone, ip: req.ip }));
  } catch (error) {
    return sendPasswordResetError(error, res);
  }
}));

app.post("/api/auth/password-reset/sms/confirm", asyncRoute(async (req, res) => {
  try {
    res.json(await smsPasswordReset.confirm(req.body));
  } catch (error) {
    return sendPasswordResetError(error, res);
  }
}));

app.get("/api/users", requireAdmin, requirePasswordReady, asyncRoute(async (_req, res) => {
  const db = await readDb();
  res.json({ rows: db.users.map(publicUser) });
}));

app.post("/api/admin/users/:id/reset-password", requireAdmin, requirePasswordReady, asyncRoute(async (req, res) => {
  const passwordError = validatePassword(req.body.password);
  if (passwordError) return res.status(422).json({ error: passwordError });
  const db = await readDb();
  const user = db.users.find((item) => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  user.password = await hashPassword(req.body.password);
  user.sessionVersion += 1;
  user.mustChangePassword = true;
  await writeDb(db);
  res.json({ user: publicUser(user) });
}));

app.post("/api/admin/users", requireAdmin, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const { name, phone, password, type = "ordinary", organizationName, organizationCode } = req.body;
  if (!name || !phone || !password) return res.status(422).json({ error: "姓名、手机号和密码不能为空" });
  if (!["ordinary", "organization"].includes(type)) return res.status(422).json({ error: "账号类型不合法" });
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(422).json({ error: passwordError });
  const normalizedPhone = normalizePhone(phone);
  if (db.users.some((user) => normalizePhone(user.phone) === normalizedPhone)) return res.status(409).json({ error: "该手机号已注册" });

  const user = {
    id: id("U"), name, phone: normalizedPhone, password: await hashPassword(password), type, status: req.body.status || "active",
    sessionVersion: 0, mustChangePassword: false, createdAt: now()
  };
  db.users.push(user);
  const organization = type === "organization" ? createOrganizationForUser(db, user, { organizationName, organizationCode }) : null;
  await writeDb(db);
  res.status(201).json({ row: publicUser(user), organization });
}));

app.patch("/api/admin/users/:id", requireAdmin, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const user = db.users.find((item) => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  if (user.type === "admin" && req.body.type && req.body.type !== "admin") return res.status(422).json({ error: "不能修改超级管理员账号类型" });

  if (req.body.phone) {
    const normalizedPhone = normalizePhone(req.body.phone);
    const exists = db.users.some((item) => item.id !== user.id && normalizePhone(item.phone) === normalizedPhone);
    if (exists) return res.status(409).json({ error: "该手机号已注册" });
    user.phone = normalizedPhone;
  }
  if (req.body.name) user.name = String(req.body.name);
  if (req.body.password) return res.status(422).json({ error: "请使用管理员密码重置接口" });
  if (req.body.status) user.status = String(req.body.status);
  if (req.body.type && ["ordinary", "organization"].includes(req.body.type)) user.type = req.body.type;

  let organization = organizationForOwner(db, user.id);
  if (user.type === "organization" && (req.body.organizationName || req.body.organizationCode)) {
    if (!organization) organization = createOrganizationForUser(db, user, { organizationName: req.body.organizationName, organizationCode: req.body.organizationCode });
    organization.name = req.body.organizationName || organization.name;
    organization.code = req.body.organizationCode || organization.code;
    organization.contactName = user.name;
    organization.contactPhone = user.phone;
  }

  await writeDb(db);
  res.json({ row: publicUser(user), organization });
}));

app.delete("/api/admin/users/:id", requireAdmin, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const user = db.users.find((item) => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  if (user.type === "admin") return res.status(422).json({ error: "不能删除超级管理员" });

  const ownedOrganizationIds = db.organizations.filter((org) => org.ownerUserId === user.id).map((org) => org.id);
  db.users = db.users.filter((item) => item.id !== user.id);
  db.organizations = db.organizations.filter((org) => org.ownerUserId !== user.id);
  db.memberships = db.memberships.filter((membership) => membership.userId !== user.id && !ownedOrganizationIds.includes(membership.organizationId));
  db.registrations = db.registrations.map((registration) => registration.userId === user.id ? { ...registration, userId: null } : registration);
  db.certificates = db.certificates.map((certificate) => certificate.userId === user.id ? { ...certificate, userId: null } : certificate);
  await writeDb(db);
  res.json({ ok: true });
}));

app.get("/api/organizations", requireUser, requirePasswordReady, asyncRoute(async (_req, res) => {
  const db = await readDb();
  res.json({
    rows: db.organizations.map(({ ownerUserId, ...organization }) => organization)
  });
}));

app.get("/api/me/:userId", requireUser, requirePasswordReady, asyncRoute(async (req, res, next) => {
  if (["registrations", "certificates"].includes(req.params.userId)) return next();
  const db = await readDb();
  const user = db.users.find((item) => item.id === req.params.userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  if (req.user.type !== "admin" && user.id !== req.user.id) return res.status(403).json({ error: "无权查看该用户" });
  res.json({
    user: publicUser(user),
    organizations: userOrganizations(db, user.id),
    memberships: db.memberships.filter((item) => item.userId === user.id || item.invitedPhone === user.phone),
    registrations: db.registrations.filter((item) => item.userId === user.id)
  });
}));

app.post("/api/organizations/request", requireUser, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const user = db.users.find((item) => item.id === req.user.id);
  const organization = db.organizations.find((item) => item.id === req.body.organizationId);
  if (!user || !organization) return res.status(404).json({ error: "用户或组织不存在" });
  const existing = db.memberships.find((item) => item.userId === user.id && item.organizationId === organization.id && ["active", "pending"].includes(item.status));
  if (existing) return res.status(409).json({ error: "已经存在成员关系或待审核申请" });

  const membership = {
    id: id("M"),
    userId: user.id,
    organizationId: organization.id,
    role: "member",
    status: "pending",
    direction: "user_request",
    note: req.body.note || "",
    createdAt: now(),
    updatedAt: now()
  };
  db.memberships.unshift(membership);
  await writeDb(db);
  res.status(201).json({ row: membership });
}));

app.post("/api/organizations/invite", requireUser, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const role = req.body.role || "member";
  if (!MANAGED_MEMBERSHIP_ROLES.includes(role)) return res.status(422).json({ error: "邀请角色不合法" });
  const organization = db.organizations.find((item) => item.id === req.body.organizationId);
  if (!organization) return res.status(404).json({ error: "组织不存在" });
  if (!canGrantOrganizationRole(db, req.user.id, req.body.organizationId, role)) {
    return res.status(403).json({ error: "无权邀请该角色" });
  }
  const phone = normalizePhone(req.body.phone);
  const user = db.users.find((item) => normalizePhone(item.phone) === phone);
  const existing = db.memberships.find(
    (item) => item.organizationId === req.body.organizationId && ((user && item.userId === user.id) || normalizePhone(item.invitedPhone) === phone) && ["active", "invited", "pending"].includes(item.status)
  );
  if (existing) return res.status(409).json({ error: "该用户已在组织中或已有邀请/申请" });

  const membership = {
    id: id("M"),
    userId: user?.id || null,
    invitedPhone: phone,
    invitedName: req.body.name || user?.name || "",
    organizationId: req.body.organizationId,
    role,
    status: "invited",
    direction: "org_invite",
    note: req.body.note || "",
    createdAt: now(),
    updatedAt: now()
  };
  db.memberships.unshift(membership);
  await writeDb(db);
  res.status(201).json({ row: membership });
}));

app.patch("/api/memberships/:id", requireUser, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const row = db.memberships.find((item) => item.id === req.params.id);
  if (!row) return res.status(404).json({ error: "成员关系不存在" });

  const currentUser = req.user;
  const acceptingSelfInvite = row.direction === "org_invite"
    && row.status === "invited"
    && MANAGED_MEMBERSHIP_ROLES.includes(row.role)
    && (row.userId === currentUser.id || normalizePhone(row.invitedPhone) === normalizePhone(currentUser.phone));
  if (!["active", "rejected", "removed"].includes(req.body.status)) return res.status(422).json({ error: "状态不合法" });
  const nextRole = req.body.role || row.role;
  if (req.body.role && !MANAGED_MEMBERSHIP_ROLES.includes(req.body.role)) {
    return res.status(422).json({ error: "成员角色不合法" });
  }
  const selfDecision = acceptingSelfInvite
    && ["active", "rejected"].includes(req.body.status)
    && (!req.body.role || req.body.role === row.role);
  if (!selfDecision && !canManageMembership(db, currentUser.id, row, nextRole)) {
    return res.status(403).json({ error: "无权处理该关系" });
  }

  row.status = req.body.status;
  row.role = nextRole;
  if (!row.userId && normalizePhone(row.invitedPhone) === normalizePhone(currentUser.phone) && req.body.status === "active") row.userId = currentUser.id;
  row.updatedAt = now();
  await writeDb(db);
  res.json({ row });
}));

app.get("/api/registrations", requireAdmin, requirePasswordReady, asyncRoute(async (_req, res) => {
  const db = await readDb();
  res.json({ rows: db.registrations });
}));

app.get("/api/admin/certificates", requireAdmin, requirePasswordReady, asyncRoute(async (_req, res) => {
  const db = await readDb();
  const rows = db.certificates.map((certificate) => certificatePayload(certificate, db.registrations.find((row) => row.id === certificate.registrationId)));
  res.json({ rows });
}));

app.get("/api/me/registrations", requireUser, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  res.json({ rows: db.registrations.filter((item) => item.userId === req.user.id) });
}));

app.get("/api/me/certificates", requireUser, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const rows = db.certificates
    .filter((certificate) => certificate.userId === req.user.id && certificate.status === "published")
    .map((certificate) => publicCertificatePayload(certificate, db.registrations.find((row) => row.id === certificate.registrationId)));
  res.json({ rows });
}));

app.get("/api/organizations/:id/registrations", requireUser, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  if (!canManageOrganization(db, req.user.id, req.params.id)) return res.status(403).json({ error: "无权查看该组织记录" });
  const memberIds = activeMemberIdsForManagedOrganizations(db, req.user.id, req.params.id);
  res.json({
    rows: db.registrations.filter((row) => row.organizationId === req.params.id && memberIds.includes(row.userId))
  });
}));

app.get("/api/organizations/:id/certificates", requireUser, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  if (!canManageOrganization(db, req.user.id, req.params.id)) return res.status(403).json({ error: "无权查看该组织证书" });
  const memberIds = activeMemberIdsForManagedOrganizations(db, req.user.id, req.params.id);
  const registrationIds = db.registrations
    .filter((row) => row.organizationId === req.params.id && memberIds.includes(row.userId))
    .map((row) => row.id);
  const rows = db.certificates
    .filter((certificate) => certificate.status === "published" && registrationIds.includes(certificate.registrationId))
    .map((certificate) => publicCertificatePayload(certificate, db.registrations.find((row) => row.id === certificate.registrationId)));
  res.json({ rows });
}));

app.post("/api/registrations/check", requireUser, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const { event } = registrationContext(db, req.body);
  const athlete = req.body.athlete || req.body;
  const key = athleteKey(athlete);
  const matches = db.registrations.filter((row) => row.eventId === event.id && row.athleteKey === key && row.status !== "cancelled");
  res.json({
    duplicate: matches.length > 0,
    duplicateCount: matches.length,
    individualUsed: matches.some((row) => row.projectType === "individual"),
    teamUsed: matches.some((row) => row.projectType === "team")
  });
}));

app.post("/api/registrations", requireUser, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const { event, project } = registrationContext(db, req.body);
  const validation = validateRegistration(req.body, db.registrations, project, event.id);
  if (!validation.ok) return res.status(422).json(validation);

  const organization = db.organizations.find((item) => item.id === req.body.organizationId);
  if (req.body.organizationId && !organization) return res.status(404).json({ error: "组织不存在" });
  if (organization) {
    const activeMembership = db.memberships.some((item) =>
      item.userId === req.user.id && item.organizationId === organization.id && item.status === "active"
    );
    if (!activeMembership && !canManageOrganization(db, req.user.id, organization.id)) {
      return res.status(403).json({ error: "无权使用该组织报名" });
    }
  }
  const row = {
    id: id("R"),
    eventId: event.id,
    source: req.body.source || "普通用户",
    userId: req.user.id,
    organizationId: req.body.organizationId || null,
    organization: organization?.name || req.body.organization || "",
    athlete: req.body.athlete,
    athleteKey: validation.athleteKey,
    group: req.body.group,
    projectId: project.id,
    projectName: project.name,
    projectType: validation.projectType,
    instructor: req.body.instructor || "",
    status: "pending",
    rejectReason: "",
    createdAt: now(),
    updatedAt: now()
  };

  db.registrations.unshift(row);
  await writeDb(db);
  res.status(201).json({ row, duplicateCount: validation.duplicateCount });
}));

app.post("/api/admin/registrations/:id/result", requireAdmin, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const row = db.registrations.find((item) => item.id === req.params.id);
  if (!row) return res.status(404).json({ error: "报名记录不存在" });
  row.awardName = String(req.body.awardName || "");
  row.rank = String(req.body.rank || "");
  row.score = String(req.body.score || "");
  row.resultRecordedAt = now();
  row.updatedAt = now();
  const certificate = findCertificateByRegistration(db, row.id);
  if (certificate) updateCertificateFromRegistration(certificate, row);
  await writeDb(db);
  res.json({ row, certificate });
}));

app.patch("/api/admin/registrations/:id", requireAdmin, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const row = db.registrations.find((item) => item.id === req.params.id);
  if (!row) return res.status(404).json({ error: "报名记录不存在" });

  const next = {
    ...row,
    organizationId: req.body.organizationId || null,
    athlete: req.body.athlete || row.athlete,
    group: req.body.group || row.group,
    projectId: req.body.projectId || row.projectId,
    instructor: req.body.instructor ?? row.instructor
  };
  const project = (Object.hasOwn(req.body, "projectId") || Object.hasOwn(req.body, "group"))
    ? projectForHistoricalRegistration(db, row, next.projectId, next.group)
    : db.projects.find((item) => item.id === next.projectId);
  if (!project) return res.status(422).json({ error: "赛项不存在" });
  const validation = validateRegistration(next, db.registrations, project, row.eventId, row.id);
  if (!validation.ok) return res.status(422).json(validation);

  const organization = db.organizations.find((item) => item.id === next.organizationId);
  row.organizationId = next.organizationId;
  row.organization = organization?.name || "";
  row.athlete = next.athlete;
  row.athleteKey = validation.athleteKey;
  row.group = next.group;
  row.projectId = project.id;
  row.projectName = project.name;
  row.projectType = validation.projectType;
  row.instructor = next.instructor || "";
  row.updatedAt = now();

  const certificate = findCertificateByRegistration(db, row.id);
  if (certificate) {
    certificate.userId = row.userId || null;
    certificate.organizationId = row.organizationId || null;
  }
  await writeDb(db);
  res.json({ row });
}));

app.post("/api/admin/registrations/:id/certificate", requireAdmin, requirePasswordReady, upload.single("certificate"), asyncRoute(async (req, res) => {
  const db = await readDb();
  const registration = db.registrations.find((item) => item.id === req.params.id);
  if (!registration) return res.status(404).json({ error: "报名记录不存在" });

  const incomingBuffer = req.file?.buffer || (req.body.fileContentBase64 ? Buffer.from(req.body.fileContentBase64, "base64") : null);
  if (!incomingBuffer) return res.status(422).json({ error: "请上传证书 PDF 文件" });
  const originalName = req.file?.originalname || req.body.fileName || `${registration.id}.pdf`;
  const { storedName, filePath } = await saveCertificateFile({ fileName: originalName, buffer: incomingBuffer });

  let certificate = findCertificateByRegistration(db, registration.id);
  if (!certificate) {
    certificate = {
      id: id("C"),
      registrationId: registration.id,
      userId: registration.userId || null,
      organizationId: registration.organizationId || null,
      certificateNo: req.body.certificateNo || `CERT-${registration.id}`,
      fileName: originalName,
      storedName,
      filePath,
      awardName: registration.awardName || "",
      rank: registration.rank || "",
      score: registration.score || "",
      status: "draft",
      uploadedAt: now(),
      publishedAt: ""
    };
    db.certificates.unshift(certificate);
  } else {
    Object.assign(certificate, {
      certificateNo: req.body.certificateNo || certificate.certificateNo,
      fileName: originalName,
      storedName,
      filePath,
      uploadedAt: now(),
      status: "draft",
      publishedAt: ""
    });
    updateCertificateFromRegistration(certificate, registration);
  }

  await writeDb(db);
  res.status(201).json({ row: certificatePayload(certificate, registration) });
}));

function matchCertificateFile(db, fileName) {
  const baseName = path.basename(fileName, path.extname(fileName));
  const [name = "", school = "", projectKeyword = ""] = baseName.split("_");
  const nameKey = normalizeText(name);
  const schoolKey = normalizeText(school);
  const projectKey = normalizeText(projectKeyword);
  if (!nameKey || !schoolKey || !projectKey) return [];
  return db.registrations.filter((row) => {
    return (
      normalizeText(row.athlete?.name) === nameKey &&
      normalizeText(row.athlete?.school) === schoolKey &&
      normalizeText(row.projectName).includes(projectKey)
    );
  });
}

app.post("/api/admin/certificates/batch", requireAdmin, requirePasswordReady, upload.single("zip"), asyncRoute(async (req, res) => {
  const db = await readDb();
  if (!req.file?.buffer) return res.status(422).json({ error: "请上传 ZIP 文件" });

  const zip = new AdmZip(req.file.buffer);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".pdf"));
  const matched = [];
  const unmatched = [];
  const ambiguous = [];

  for (const entry of entries) {
    const matches = matchCertificateFile(db, entry.entryName);
    if (matches.length === 0) {
      unmatched.push({ fileName: entry.entryName, reason: "未找到姓名、学校、赛项匹配的报名记录" });
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push({ fileName: entry.entryName, registrations: matches.map((row) => ({ id: row.id, athlete: row.athlete, projectName: row.projectName })) });
      continue;
    }

    const registration = matches[0];
    const { storedName, filePath } = await saveCertificateFile({ fileName: entry.entryName, buffer: entry.getData() });
    let certificate = findCertificateByRegistration(db, registration.id);
    if (!certificate) {
      certificate = {
        id: id("C"),
        registrationId: registration.id,
        userId: registration.userId || null,
        organizationId: registration.organizationId || null,
        certificateNo: `CERT-${registration.id}`,
        fileName: path.basename(entry.entryName),
        storedName,
        filePath,
        awardName: registration.awardName || "",
        rank: registration.rank || "",
        score: registration.score || "",
        status: "draft",
        uploadedAt: now(),
        publishedAt: ""
      };
      db.certificates.unshift(certificate);
    } else {
      Object.assign(certificate, {
        fileName: path.basename(entry.entryName),
        storedName,
        filePath,
        status: "draft",
        uploadedAt: now(),
        publishedAt: ""
      });
      updateCertificateFromRegistration(certificate, registration);
    }
    matched.push({ fileName: entry.entryName, registrationId: registration.id, certificateId: certificate.id });
  }

  await writeDb(db);
  res.json({ matched, unmatched, ambiguous });
}));

app.patch("/api/admin/certificates/:id/publish", requireAdmin, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const certificate = db.certificates.find((item) => item.id === req.params.id);
  if (!certificate) return res.status(404).json({ error: "证书不存在" });
  if (!["draft", "published"].includes(req.body.status)) return res.status(422).json({ error: "状态不合法" });
  certificate.status = req.body.status;
  certificate.publishedAt = req.body.status === "published" ? now() : "";
  await writeDb(db);
  res.json({ row: certificatePayload(certificate, db.registrations.find((row) => row.id === certificate.registrationId)) });
}));

app.get("/api/certificates/:id/download", requireUser, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const certificate = db.certificates.find((item) => item.id === req.params.id);
  if (!certificate) return res.status(404).json({ error: "证书不存在" });
  if (!canAccessCertificate(db, req.user.id, certificate, { includeDraft: req.user.type === "admin" })) {
    return res.status(403).json({ error: "无权下载该证书" });
  }
  res.download(certificate.filePath, certificate.fileName);
}));

app.patch("/api/registrations/:id/status", requireUser, requirePasswordReady, asyncRoute(async (req, res) => {
  const db = await readDb();
  const row = db.registrations.find((item) => item.id === req.params.id);
  if (!row) return res.status(404).json({ error: "报名记录不存在" });

  const allowed = ["approved", "rejected", "cancelled", "pending"];
  if (!allowed.includes(req.body.status)) return res.status(422).json({ error: "状态不合法" });
  if (req.user.type !== "admin") {
    if (row.userId !== req.user.id) return res.status(403).json({ error: "无权修改该报名" });
    if (req.body.status !== "cancelled") return res.status(403).json({ error: "普通用户只能取消自己的报名" });
  }

  row.status = req.body.status;
  row.rejectReason = req.body.status === "rejected" ? String(req.body.rejectReason || "信息需补充") : "";
  row.updatedAt = now();
  await writeDb(db);
  res.json({ row });
}));

app.get("/api/registrations/export.csv", requireAdmin, requirePasswordReady, asyncRoute(async (_req, res) => {
  const db = await readDb();
  const header = ["编号", "来源", "组织", "姓名", "学校", "年级", "手机号", "组别", "赛项", "类别", "指导老师", "状态"];
  const lines = db.registrations.map((row) => [
    row.id,
    row.source,
    row.organization,
    row.athlete.name,
    row.athlete.school,
    row.athlete.grade,
    row.athlete.phone,
    row.group,
    row.projectName,
    row.projectType === "individual" ? "个人赛" : "团体赛",
    row.instructor,
    row.status
  ]);
  const csv = [header, ...lines]
    .map((line) => line.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=registrations.csv");
  res.send(`\uFEFF${csv}`);
}));

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) ? error.status : 500;
  res.status(status).json({
    error: status === 500 ? "服务器内部错误" : error.message,
    ...(error.code ? { code: error.code } : {})
  });
});

await dataStore.initialize();

const server = app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${server.address().port}`);
});

async function shutdown() {
  server.close(async () => {
    await dataStore.close();
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
