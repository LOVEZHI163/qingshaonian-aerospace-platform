import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import AdmZip from "adm-zip";
import { createDataStore } from "./data/index.js";
import { EVENT, GRADES, PROJECTS } from "./data/seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadRoot = process.env.UPLOAD_ROOT ? path.resolve(process.env.UPLOAD_ROOT) : path.resolve(__dirname, "../uploads");
const certificateUploadDir = path.join(uploadRoot, "certificates");
const PORT = Number(process.env.PORT || 4300);
const dataStore = createDataStore();
const readDb = () => dataStore.readDb();
const writeDb = (db) => dataStore.writeDb(db);

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

function projectType(projectId) {
  return PROJECTS.find((item) => item.id === projectId)?.type || "individual";
}

function publicUser(user) {
  if (!user) return null;
  const { password, ...safe } = user;
  return safe;
}

function canManageOrganization(db, userId, organizationId) {
  const user = db.users.find((item) => item.id === userId);
  if (user?.type === "admin") return true;
  return db.memberships.some(
    (item) => item.userId === userId && item.organizationId === organizationId && item.status === "active" && ["owner", "manager"].includes(item.role)
  );
}

function isAdmin(db, userId) {
  return db.users.some((item) => item.id === userId && item.type === "admin");
}

function activeMemberIdsForManagedOrganizations(db, actorUserId, organizationId = null) {
  const orgIds = db.organizations
    .filter((organization) => (!organizationId || organization.id === organizationId) && canManageOrganization(db, actorUserId, organization.id))
    .map((organization) => organization.id);
  const memberIds = db.memberships
    .filter((membership) => orgIds.includes(membership.organizationId) && membership.status === "active" && membership.userId)
    .map((membership) => membership.userId);
  return [...new Set(memberIds)];
}

function canAccessRegistration(db, actorUserId, registration) {
  if (!registration) return false;
  if (isAdmin(db, actorUserId)) return true;
  if (registration.userId === actorUserId) return true;
  return activeMemberIdsForManagedOrganizations(db, actorUserId).includes(registration.userId);
}

function canAccessCertificate(db, actorUserId, certificate, { includeDraft = false } = {}) {
  if (!certificate) return false;
  if (!includeDraft && certificate.status !== "published") return false;
  const registration = db.registrations.find((row) => row.id === certificate.registrationId);
  return canAccessRegistration(db, actorUserId, registration);
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

function validateRegistration(input, existingRows, ignoreId = null) {
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

  if (!GRADES.includes(input.group)) errors.push("组别不在赛事规程范围内");
  if (!PROJECTS.some((project) => project.id === input.projectId)) errors.push("赛项不存在");

  const nextKey = athleteKey(athlete);
  const nextType = projectType(input.projectId);
  const activeRows = existingRows.filter((row) => row.id !== ignoreId && row.status !== "cancelled");
  const sameAthleteRows = activeRows.filter((row) => row.athleteKey === nextKey);
  const hasSameType = sameAthleteRows.some((row) => row.projectType === nextType);

  if (hasSameType) {
    errors.push(nextType === "individual" ? "该运动员已报名一个个人赛" : "该运动员已报名一个团体赛");
  }

  return { ok: errors.length === 0, errors, athleteKey: nextKey, projectType: nextType, duplicateCount: sameAthleteRows.length };
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/api/public/event", (_req, res) => {
  res.json({ event: EVENT, projects: PROJECTS, grades: GRADES });
});

app.post("/api/auth/register", async (req, res) => {
  const db = await readDb();
  const { name, phone, password, type = "ordinary", organizationName, organizationCode } = req.body;
  if (!name || !phone || !password) return res.status(422).json({ error: "姓名、手机号和密码不能为空" });
  const normalizedPhone = normalizePhone(phone);
  if (db.users.some((user) => normalizePhone(user.phone) === normalizedPhone)) return res.status(409).json({ error: "该手机号已注册" });

  const user = { id: id("U"), name, phone: normalizedPhone, password, type, status: "active", createdAt: now() };
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
});

app.post("/api/auth/login", async (req, res) => {
  const db = await readDb();
  const phone = normalizePhone(req.body.phone);
  const user = db.users.find((item) => normalizePhone(item.phone) === phone && item.password === req.body.password);
  if (!user) return res.status(401).json({ error: "手机号或密码错误" });
  res.json({ user: publicUser(user), organizations: userOrganizations(db, user.id) });
});

app.post("/api/auth/reset-password", async (req, res) => {
  const db = await readDb();
  const phone = normalizePhone(req.body.phone);
  const user = db.users.find((item) => normalizePhone(item.phone) === phone && normalizeText(item.name) === normalizeText(req.body.name));
  if (!user) return res.status(404).json({ error: "未找到匹配的账号，请确认姓名和手机号" });
  if (!req.body.password || String(req.body.password).length < 6) return res.status(422).json({ error: "新密码至少 6 位" });
  user.password = String(req.body.password);
  await writeDb(db);
  res.json({ user: publicUser(user), message: "密码已重置，请使用新密码登录" });
});

app.get("/api/users", async (_req, res) => {
  const db = await readDb();
  res.json({ rows: db.users.map(publicUser) });
});

app.post("/api/admin/users", async (req, res) => {
  const db = await readDb();
  if (!isAdmin(db, req.body.actorUserId)) return res.status(403).json({ error: "只有管理员可以创建用户" });
  const { name, phone, password = "123456", type = "ordinary", organizationName, organizationCode } = req.body;
  if (!name || !phone || !password) return res.status(422).json({ error: "姓名、手机号和密码不能为空" });
  if (!["ordinary", "organization"].includes(type)) return res.status(422).json({ error: "账号类型不合法" });
  const normalizedPhone = normalizePhone(phone);
  if (db.users.some((user) => normalizePhone(user.phone) === normalizedPhone)) return res.status(409).json({ error: "该手机号已注册" });

  const user = { id: id("U"), name, phone: normalizedPhone, password, type, status: req.body.status || "active", createdAt: now() };
  db.users.push(user);
  const organization = type === "organization" ? createOrganizationForUser(db, user, { organizationName, organizationCode }) : null;
  await writeDb(db);
  res.status(201).json({ row: publicUser(user), organization });
});

app.patch("/api/admin/users/:id", async (req, res) => {
  const db = await readDb();
  if (!isAdmin(db, req.body.actorUserId)) return res.status(403).json({ error: "只有管理员可以修改用户" });
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
  if (req.body.password) user.password = String(req.body.password);
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
});

app.delete("/api/admin/users/:id", async (req, res) => {
  const db = await readDb();
  if (!isAdmin(db, req.query.actorUserId)) return res.status(403).json({ error: "只有管理员可以删除用户" });
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
});

app.get("/api/organizations", async (_req, res) => {
  const db = await readDb();
  res.json({ rows: db.organizations, memberships: db.memberships });
});

app.get("/api/me/:userId", async (req, res, next) => {
  if (["registrations", "certificates"].includes(req.params.userId)) return next();
  const db = await readDb();
  const user = db.users.find((item) => item.id === req.params.userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  res.json({
    user: publicUser(user),
    organizations: userOrganizations(db, user.id),
    memberships: db.memberships.filter((item) => item.userId === user.id || item.invitedPhone === user.phone),
    registrations: db.registrations.filter((item) => item.userId === user.id)
  });
});

app.post("/api/organizations/request", async (req, res) => {
  const db = await readDb();
  const user = db.users.find((item) => item.id === req.body.userId);
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
});

app.post("/api/organizations/invite", async (req, res) => {
  const db = await readDb();
  if (!canManageOrganization(db, req.body.senderUserId, req.body.organizationId)) return res.status(403).json({ error: "无权邀请该组织成员" });
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
    role: req.body.role || "member",
    status: "invited",
    direction: "org_invite",
    note: req.body.note || "",
    createdAt: now(),
    updatedAt: now()
  };
  db.memberships.unshift(membership);
  await writeDb(db);
  res.status(201).json({ row: membership });
});

app.patch("/api/memberships/:id", async (req, res) => {
  const db = await readDb();
  const row = db.memberships.find((item) => item.id === req.params.id);
  if (!row) return res.status(404).json({ error: "成员关系不存在" });

  const actor = db.users.find((item) => item.id === req.body.actorUserId);
  const approvingSelfInvite = row.direction === "org_invite" && actor && (row.userId === actor.id || normalizePhone(row.invitedPhone) === normalizePhone(actor.phone));
  const managingOrg = canManageOrganization(db, req.body.actorUserId, row.organizationId);
  if (!approvingSelfInvite && !managingOrg) return res.status(403).json({ error: "无权处理该关系" });

  if (!["active", "rejected", "removed"].includes(req.body.status)) return res.status(422).json({ error: "状态不合法" });
  row.status = req.body.status;
  if (!row.userId && actor && normalizePhone(row.invitedPhone) === normalizePhone(actor.phone) && req.body.status === "active") row.userId = actor.id;
  row.updatedAt = now();
  await writeDb(db);
  res.json({ row });
});

app.get("/api/registrations", async (_req, res) => {
  const db = await readDb();
  res.json({ rows: db.registrations });
});

app.get("/api/admin/certificates", async (req, res) => {
  const db = await readDb();
  if (!isAdmin(db, req.query.actorUserId)) return res.status(403).json({ error: "只有管理员可以查看全部证书" });
  const rows = db.certificates.map((certificate) => certificatePayload(certificate, db.registrations.find((row) => row.id === certificate.registrationId)));
  res.json({ rows });
});

app.get("/api/me/registrations", async (req, res) => {
  const db = await readDb();
  const user = db.users.find((item) => item.id === req.query.userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  res.json({ rows: db.registrations.filter((item) => item.userId === user.id) });
});

app.get("/api/me/certificates", async (req, res) => {
  const db = await readDb();
  const user = db.users.find((item) => item.id === req.query.userId);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  const rows = db.certificates
    .filter((certificate) => canAccessCertificate(db, user.id, certificate))
    .map((certificate) => certificatePayload(certificate, db.registrations.find((row) => row.id === certificate.registrationId)));
  res.json({ rows });
});

app.get("/api/organizations/:id/registrations", async (req, res) => {
  const db = await readDb();
  if (!canManageOrganization(db, req.query.actorUserId, req.params.id)) return res.status(403).json({ error: "无权查看该组织记录" });
  const memberIds = activeMemberIdsForManagedOrganizations(db, req.query.actorUserId, req.params.id);
  res.json({ rows: db.registrations.filter((row) => memberIds.includes(row.userId)) });
});

app.get("/api/organizations/:id/certificates", async (req, res) => {
  const db = await readDb();
  if (!canManageOrganization(db, req.query.actorUserId, req.params.id)) return res.status(403).json({ error: "无权查看该组织证书" });
  const memberIds = activeMemberIdsForManagedOrganizations(db, req.query.actorUserId, req.params.id);
  const registrationIds = db.registrations.filter((row) => memberIds.includes(row.userId)).map((row) => row.id);
  const rows = db.certificates
    .filter((certificate) => certificate.status === "published" && registrationIds.includes(certificate.registrationId))
    .map((certificate) => certificatePayload(certificate, db.registrations.find((row) => row.id === certificate.registrationId)));
  res.json({ rows });
});

app.post("/api/registrations/check", async (req, res) => {
  const db = await readDb();
  const athlete = req.body.athlete || req.body;
  const key = athleteKey(athlete);
  const matches = db.registrations.filter((row) => row.athleteKey === key && row.status !== "cancelled");
  res.json({
    athleteKey: key,
    duplicate: matches.length > 0,
    individualUsed: matches.some((row) => row.projectType === "individual"),
    teamUsed: matches.some((row) => row.projectType === "team"),
    matches
  });
});

app.post("/api/registrations", async (req, res) => {
  const db = await readDb();
  const validation = validateRegistration(req.body, db.registrations);
  if (!validation.ok) return res.status(422).json(validation);

  const project = PROJECTS.find((item) => item.id === req.body.projectId);
  const organization = db.organizations.find((item) => item.id === req.body.organizationId);
  const row = {
    id: id("R"),
    source: req.body.source || "普通用户",
    userId: req.body.userId || null,
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
});

app.post("/api/admin/registrations/:id/result", async (req, res) => {
  const db = await readDb();
  if (!isAdmin(db, req.body.actorUserId)) return res.status(403).json({ error: "只有管理员可以录入成绩奖项" });
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
});

app.patch("/api/admin/registrations/:id", async (req, res) => {
  const db = await readDb();
  if (!isAdmin(db, req.body.actorUserId)) return res.status(403).json({ error: "只有管理员可以修改报名信息" });
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
  const validation = validateRegistration(next, db.registrations, row.id);
  if (!validation.ok) return res.status(422).json(validation);

  const project = PROJECTS.find((item) => item.id === next.projectId);
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
});

app.post("/api/admin/registrations/:id/certificate", upload.single("certificate"), async (req, res) => {
  const db = await readDb();
  if (!isAdmin(db, req.body.actorUserId)) return res.status(403).json({ error: "只有管理员可以上传证书" });
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
});

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

app.post("/api/admin/certificates/batch", upload.single("zip"), async (req, res) => {
  const db = await readDb();
  if (!isAdmin(db, req.body.actorUserId)) return res.status(403).json({ error: "只有管理员可以批量上传证书" });
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
});

app.patch("/api/admin/certificates/:id/publish", async (req, res) => {
  const db = await readDb();
  if (!isAdmin(db, req.body.actorUserId)) return res.status(403).json({ error: "只有管理员可以发布证书" });
  const certificate = db.certificates.find((item) => item.id === req.params.id);
  if (!certificate) return res.status(404).json({ error: "证书不存在" });
  if (!["draft", "published"].includes(req.body.status)) return res.status(422).json({ error: "状态不合法" });
  certificate.status = req.body.status;
  certificate.publishedAt = req.body.status === "published" ? now() : "";
  await writeDb(db);
  res.json({ row: certificatePayload(certificate, db.registrations.find((row) => row.id === certificate.registrationId)) });
});

app.get("/api/certificates/:id/download", async (req, res) => {
  const db = await readDb();
  const certificate = db.certificates.find((item) => item.id === req.params.id);
  if (!canAccessCertificate(db, req.query.actorUserId, certificate, { includeDraft: isAdmin(db, req.query.actorUserId) })) {
    return res.status(403).json({ error: "无权下载该证书" });
  }
  res.download(certificate.filePath, certificate.fileName);
});

app.patch("/api/registrations/:id/status", async (req, res) => {
  const db = await readDb();
  const row = db.registrations.find((item) => item.id === req.params.id);
  if (!row) return res.status(404).json({ error: "报名记录不存在" });

  const allowed = ["approved", "rejected", "cancelled", "pending"];
  if (!allowed.includes(req.body.status)) return res.status(422).json({ error: "状态不合法" });

  row.status = req.body.status;
  row.rejectReason = req.body.status === "rejected" ? String(req.body.rejectReason || "信息需补充") : "";
  row.updatedAt = now();
  await writeDb(db);
  res.json({ row });
});

app.get("/api/registrations/export.csv", async (_req, res) => {
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
});

await dataStore.initialize();

const server = app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});

async function shutdown() {
  server.close(async () => {
    await dataStore.close();
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
