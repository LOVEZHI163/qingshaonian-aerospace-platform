import express from "express";
import cors from "cors";
import { hashPassword, isLegacyPassword, validatePassword, verifyLoginPassword } from "./auth/passwords.js";
import { createSmsPasswordResetService, sendPasswordResetError } from "./auth/password-reset.js";
import { asyncRoute, createSessionMiddleware, requireAdmin, requirePasswordReady, requireUser } from "./auth/session.js";
import { createAliyunSmsProvider } from "./auth/sms.js";
import { createDataStore } from "./data/index.js";
import { createMutationAsyncRoute } from "./data/mutation-lock.js";
import { createEventsRouter } from "./routes/events.js";
import { createOrganizationsRouter } from "./routes/organizations.js";
import { createRegistrationsRouter } from "./routes/registrations.js";
import { createCertificateImportsRouter } from "./routes/certificate-imports.js";
import { cleanupExpiredCertificateImportPreviews } from "./services/certificate-imports.js";
import { createCertificatesRouter } from "./routes/certificates.js";
import { createDashboardRouter } from "./routes/dashboard.js";
import { createResourcesRouter } from "./routes/resources.js";
import { createSiteMediaRouter } from "./routes/site-media.js";
import { createSiteAdminRouter } from "./routes/site-admin.js";
import { createPublicSiteRouter } from "./routes/public-site.js";
import { createAccountEventsRouter } from "./routes/account-events.js";
import { createSystemRouter } from "./routes/system.js";
import { createSubmissionAssetsRouter } from "./routes/submission-assets.js";
import { createMembershipsRouter } from "./routes/memberships.js";
import { startSubmissionSessionExpiryCleanup } from "./services/submission-assets.js";
import { registrationContext } from "./services/events.js";
import { replayFileCleanupJournal } from "./services/organizations.js";
import { organizationForOwner } from "./services/access-control.js";
import { publishDueScheduledContent, startScheduledContentPublisher } from "./services/scheduled-content-publisher.js";

const PORT = Number(process.env.PORT || 4300);
const dataStore = createDataStore();
const mutationAsyncRoute = createMutationAsyncRoute(dataStore);
const readDb = () => dataStore.readDb();
const writeDb = (db) => dataStore.writeDb(db);
const smsProvider = createAliyunSmsProvider(process.env);
const smsPasswordReset = createSmsPasswordResetService({
  secret: process.env.SESSION_SECRET || "test-session-secret-32-characters",
  readDb,
  writeDb,
  smsProvider,
  authState: dataStore.authState,
  withMutationLock: (handler) => dataStore.withMutationLock(handler)
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

const SAFE_EVENT_FILTER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function eventFilter(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !SAFE_EVENT_FILTER.test(value)) {
    throw Object.assign(new Error("赛事筛选不合法"), { status: 422 });
  }
  return value;
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
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    type: user.type,
    status: user.status,
    mustChangePassword: Boolean(user.mustChangePassword),
    createdAt: user.createdAt
  };
}

function isOrganizationOperational(db, organizationId) {
  const organization = db.organizations.find((item) => item.id === organizationId);
  return organization?.status === "active" && organization.reviewStatus === "approved";
}

function canManageOrganization(db, userId, organizationId) {
  const user = db.users.find((item) => item.id === userId);
  return user?.type === "organization"
    && organizationForOwner(db, userId)?.id === organizationId
    && isOrganizationOperational(db, organizationId);
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

function userOrganizations(db, userId) {
  const user = db.users.find((item) => item.id === userId);
  if (user?.type === "organization") {
    const organization = organizationForOwner(db, userId);
    return organization ? [{ id: organization.id, name: organization.name, code: organization.code, status: organization.status, reviewStatus: organization.reviewStatus }] : [];
  }
  if (user?.type !== "ordinary") return [];
  const memberships = db.memberships.filter((item) => item.userId === userId && item.status === "active");
  return memberships
    .filter((membership) => membership.role === "member")
    .map((membership) => {
      const organization = db.organizations.find((item) => item.id === membership.organizationId);
      return organization && { id: organization.id, name: organization.name, code: organization.code, status: organization.status, membershipRole: "member" };
    })
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
app.use(cors());
app.use(express.json({ limit: "5mb", strict: false }));
app.use((req, res, next) => {
  if (req.is("application/json") && req.body !== undefined
    && (!req.body || typeof req.body !== "object" || Array.isArray(req.body))) {
    return res.status(422).json({ error: "请求内容必须是 JSON 对象" });
  }
  next();
});
app.use("/api", createSystemRouter({ releaseSha: process.env.RELEASE_SHA }));
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
app.use("/api", createOrganizationsRouter({
  store: dataStore,
  requireUser,
  requireAdmin,
  requirePasswordReady,
  asyncRoute: mutationAsyncRoute,
  hashPassword,
  validatePassword,
  makeId: id,
  now,
  publicUser
}));

app.use("/api", createMembershipsRouter({
  store: dataStore,
  requireUser,
  requirePasswordReady,
  asyncRoute,
  mutationAsyncRoute,
  makeId: id,
  now
}));

app.use("/api", createAccountEventsRouter({
  store: dataStore,
  requireUser,
  requirePasswordReady,
  asyncRoute: mutationAsyncRoute,
  now
}));

app.use("/api", createEventsRouter({
  store: dataStore,
  requireAdmin,
  requirePasswordReady,
  asyncRoute: mutationAsyncRoute,
  makeId: id
}));

app.use("/api", createResourcesRouter({
  store: dataStore,
  requireAdmin,
  requirePasswordReady,
  asyncRoute,
  mutationAsyncRoute,
  makeId: id,
  now
}));

app.use("/api", createRegistrationsRouter({
  store: dataStore,
  requireUser,
  requireAdmin,
  requirePasswordReady,
  asyncRoute: mutationAsyncRoute,
  makeId: id,
  now
}));

app.use("/api", createSubmissionAssetsRouter({
  store: dataStore,
  requireUser,
  requireAdmin,
  requirePasswordReady,
  asyncRoute: mutationAsyncRoute,
  makeId: id,
  now
}));

app.use("/api", createCertificateImportsRouter({
  store: dataStore,
  requireAdmin,
  requirePasswordReady,
  asyncRoute: mutationAsyncRoute,
  makeId: id,
  now
}));

app.use("/api", createCertificatesRouter({
  store: dataStore,
  requireUser,
  requireAdmin,
  requirePasswordReady,
  asyncRoute,
  mutationAsyncRoute,
  makeId: id,
  now
}));

app.use("/api", createDashboardRouter({
  store: dataStore,
  requireAdmin,
  requirePasswordReady,
  asyncRoute,
  uploadRoot: process.env.UPLOAD_ROOT || "/data/uploads"
}));

app.use("/api", createSiteMediaRouter({
  store: dataStore,
  requireAdmin,
  requirePasswordReady,
  asyncRoute,
  mutationAsyncRoute,
  makeId: id,
  now
}));

app.use("/api", createSiteAdminRouter({
  store: dataStore,
  requireAdmin,
  requirePasswordReady,
  asyncRoute,
  mutationAsyncRoute,
  makeId: id,
  now
}));

let nextScheduledPublishingCheckAt = 0;
let scheduledPublishingCheck = null;
app.use("/api/public", asyncRoute(async (_req, _res, next) => {
  const timestamp = Date.now();
  if (timestamp >= nextScheduledPublishingCheckAt) {
    nextScheduledPublishingCheckAt = timestamp + 1_000;
    scheduledPublishingCheck = publishDueScheduledContent({ store: dataStore })
      .finally(() => { scheduledPublishingCheck = null; });
  }
  if (scheduledPublishingCheck) await scheduledPublishingCheck;
  next();
}));

app.use("/api", createPublicSiteRouter({
  store: dataStore,
  asyncRoute
}));

app.get("/api/public/features", (_req, res) => {
  res.json({ smsPasswordResetEnabled: smsPasswordReset.enabled });
});

app.post("/api/auth/register", mutationAsyncRoute(async (req, res) => {
  const db = await readDb();
  const { name, phone, password, type = "ordinary" } = req.body;
  if (!name || !phone || !password) return res.status(422).json({ error: "姓名、手机号和密码不能为空" });
  if (type === "organization") return res.status(422).json({ error: "组织注册请使用资质上传接口" });
  if (type !== "ordinary") return res.status(422).json({ error: "账号类型不合法" });
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(422).json({ error: passwordError });
  const normalizedPhone = normalizePhone(phone);
  if (db.users.some((user) => normalizePhone(user.phone) === normalizedPhone)) return res.status(409).json({ error: "该手机号已注册" });

  const user = {
    id: id("U"), name, phone: normalizedPhone, password: await hashPassword(password), type, status: "active",
    sessionVersion: 0, mustChangePassword: false, createdAt: now()
  };
  db.users.push(user);

  await writeDb(db);
  res.status(201).json({ user: publicUser(user), organization: null });
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
  const authenticated = await dataStore.withMutationLock(async () => {
    const db = await readDb();
    const user = db.users.find((item) => normalizePhone(item.phone) === phone && item.status === "active");
    if (!(await verifyLoginPassword(req.body.password, user?.password))) return null;
    if (isLegacyPassword(user.password)) {
      user.password = await hashPassword(req.body.password);
      await writeDb(db);
    }
    return { db, user };
  });
  if (!authenticated) {
    return res.status(401).json({ error: "手机号或密码错误" });
  }
  await dataStore.authState.releaseRateLimits(rateKeys, attemptTime);
  const { db, user } = authenticated;
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
  const result = await dataStore.withMutationLock(async () => {
    const db = await readDb();
    const user = db.users.find((item) => item.id === req.user.id);
    if (!user || !(await verifyLoginPassword(req.body.currentPassword, user.password))) return { status: 401, error: "当前密码错误" };
    const passwordError = validatePassword(req.body.newPassword);
    if (passwordError) return { status: 422, error: passwordError };
    if (await verifyLoginPassword(req.body.newPassword, user.password)) return { status: 422, error: "新密码不能与当前密码相同" };
    user.password = await hashPassword(req.body.newPassword);
    user.sessionVersion += 1;
    user.mustChangePassword = false;
    await writeDb(db);
    return { user };
  });
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  const { user } = result;
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

app.post("/api/admin/users/:id/reset-password", requireAdmin, requirePasswordReady, mutationAsyncRoute(async (req, res) => {
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

app.post("/api/admin/users", requireAdmin, requirePasswordReady, mutationAsyncRoute(async (req, res) => {
  const db = await readDb();
  const { name, phone, password, type = "ordinary" } = req.body;
  if (!name || !phone || !password) return res.status(422).json({ error: "姓名、手机号和密码不能为空" });
  if (type === "organization") return res.status(422).json({ error: "组织必须通过资质注册并审核" });
  if (type !== "ordinary") return res.status(422).json({ error: "账号类型不合法" });
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(422).json({ error: passwordError });
  const normalizedPhone = normalizePhone(phone);
  if (db.users.some((user) => normalizePhone(user.phone) === normalizedPhone)) return res.status(409).json({ error: "该手机号已注册" });

  const user = {
    id: id("U"), name, phone: normalizedPhone, password: await hashPassword(password), type, status: req.body.status || "active",
    sessionVersion: 0, mustChangePassword: false, createdAt: now()
  };
  db.users.push(user);
  await writeDb(db);
  res.status(201).json({ row: publicUser(user), organization: null });
}));

app.patch("/api/admin/users/:id", requireAdmin, requirePasswordReady, mutationAsyncRoute(async (req, res) => {
  const db = await readDb();
  const user = db.users.find((item) => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  let organization = organizationForOwner(db, user.id);
  if (user.type === "organization" && !organization) {
    return res.status(422).json({ error: "历史组织账号缺少资质组织，请重新注册并审核" });
  }
  if (user.type === "admin" && req.body.type && req.body.type !== "admin") return res.status(422).json({ error: "不能修改超级管理员账号类型" });
  if (req.body.type === "organization" && user.type !== "organization") return res.status(422).json({ error: "组织必须通过资质注册并审核" });

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

  if (user.type === "organization" && (req.body.organizationName || req.body.organizationCode)) {
    organization.name = req.body.organizationName || organization.name;
    organization.code = req.body.organizationCode || organization.code;
    organization.contactName = user.name;
    organization.contactPhone = user.phone;
  }

  await writeDb(db);
  res.json({ row: publicUser(user), organization });
}));

app.delete("/api/admin/users/:id", requireAdmin, requirePasswordReady, mutationAsyncRoute(async (req, res) => {
  const db = await readDb();
  const user = db.users.find((item) => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  if (user.type === "admin") return res.status(422).json({ error: "不能删除超级管理员" });

  const ownedOrganizationIds = db.organizations.filter((org) => org.ownerUserId === user.id).map((org) => org.id);
  if (db.organizationDocuments.some((document) => ownedOrganizationIds.includes(document.organizationId) && !document.cleanedAt)) {
    return res.status(409).json({ error: "组织仍有资质文件，请先完成资源清理流程" });
  }
  if (db.registrations.some((registration) => registration.createdByUserId === user.id || registration.personalUserId === user.id)) {
    return res.status(409).json({ error: "用户仍有关联报名，不能删除" });
  }
  db.users = db.users.filter((item) => item.id !== user.id);
  db.organizations = db.organizations.filter((org) => org.ownerUserId !== user.id);
  db.memberships = db.memberships.filter((membership) => membership.userId !== user.id && !ownedOrganizationIds.includes(membership.organizationId));
  await writeDb(db);
  res.json({ ok: true });
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
    memberships: db.memberships
      .filter((item) => item.userId === user.id || item.invitedPhone === user.phone)
      .map((item) => ({ id: item.id, userId: item.userId, organizationId: item.organizationId, role: item.role, status: item.status, direction: item.direction, note: item.note, createdAt: item.createdAt, updatedAt: item.updatedAt })),
    registrations: req.user.type === "admin"
      ? db.registrations.filter((item) => item.createdByUserId === user.id || item.personalUserId === user.id)
        .map((item) => ({ id: item.id, eventId: item.eventId, organizationId: item.organizationId, status: item.status, athlete: { name: item.athlete?.name, school: item.athlete?.school, grade: item.athlete?.grade }, group: item.group, projectId: item.projectId, createdAt: item.createdAt }))
      : []
  });
}));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status === 500) {
    console.error("Unhandled API request error", {
      method: req.method,
      path: req.originalUrl,
      message: error?.message || "Unknown error",
      stack: error?.stack || ""
    });
  }
  const contentRange = error?.headers?.["Content-Range"];
  if (typeof contentRange === "string" && /^bytes \*\/\d+$/.test(contentRange)) {
    res.setHeader("Content-Range", contentRange);
  }
  res.status(status).json({
    error: status === 500 ? "服务器内部错误" : error.message,
    ...(error.code ? { code: error.code } : {})
  });
});

await dataStore.initialize();
await cleanupExpiredCertificateImportPreviews({ store: dataStore, makeId: id, now });
await replayFileCleanupJournal({ store: dataStore, now });
const stopScheduledContentPublisher = startScheduledContentPublisher({ store: dataStore });
const stopSubmissionSessionExpiryCleanup = process.env.NODE_ENV === "production"
  ? startSubmissionSessionExpiryCleanup({ store: dataStore })
  : () => {};

const server = app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${server.address().port}`);
});

async function shutdown() {
  stopScheduledContentPublisher();
  stopSubmissionSessionExpiryCleanup();
  server.close(async () => {
    await dataStore.close();
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
