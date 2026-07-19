import { groupForGrade } from "../domain/grades.js";

export const EVENT = {
  id: "wz-aerospace-2026",
  name: "2026年温州市青少年航空航天创新比赛",
  theme: "瓯越少年、星耀未来",
  date: "2026年11月21-22日",
  venue: "温州市文成县东方职业技术学院",
  registrationDeadline: "2026-11-01",
  contact: "吴琛琛 88968723 / 15858799111"
};

export const PROJECTS = [
  { id: "paper-plane-gate", name: "遥控纸飞机穿龙门飞行比赛", type: "individual", category: "青少年航模比赛" },
  { id: "rocket-duration", name: "带降航天火箭留空比赛", type: "individual", category: "青少年航模比赛" },
  { id: "rotor-race", name: "个人旋翼机竞速赛", type: "individual", category: "青少年旋翼机操控比赛" },
  { id: "thunder-route", name: "雷霆飞途比赛", type: "individual", category: "青少年旋翼机操控比赛" },
  { id: "fpv", name: "FPV穿越机比赛", type: "individual", category: "青少年旋翼机操控比赛" },
  { id: "drone-relay", name: "无人机竞速接力比赛", type: "team", category: "青少年旋翼机操控比赛" },
  { id: "air-robot-patrol", name: "空中机器人定点巡查比赛", type: "team", category: "青少年旋翼机编程比赛" },
  { id: "rotor-programming", name: "旋翼机编程任务比赛", type: "team", category: "青少年旋翼机编程比赛" },
  { id: "ai-short-film", name: "“航天梦·强国梦”青少年AI短片创意创作比赛", type: "individual", category: "青少年航空航天创意创作比赛" },
  { id: "aviation-painting", name: "青少年航空绘画比赛", type: "individual", category: "青少年航空航天创意创作比赛" },
  { id: "drone-football", name: "多轴无人机足球比赛", type: "team", category: "多轴无人机足球比赛" }
];

const REGISTRATION_START_AT = "2026-10-01T00:00:00.000Z";
const REGISTRATION_END_AT = "2026-11-01T15:59:59.000Z";
export const APPROVED_GROUP_NAMES = ["小学低段", "小学高段", "中学组", "职高/高中组"];
export const REGISTRATION_MODES = ["automatic", "force_open", "force_closed"];

export const DEFAULT_SITE_SETTINGS = {
  id: "default",
  platformName: "温州市青少年航空航天创新比赛",
  featuredEventId: null,
  platformIntro: "",
  organizers: [],
  contact: "",
  icp: "",
  seoTitle: "温州市青少年航空航天创新比赛",
  seoDescription: "",
  defaultHeroMediaId: null,
  shareMediaId: null,
  version: 1
};

Object.assign(EVENT, {
  dateLabel: EVENT.date,
  registrationStartAt: REGISTRATION_START_AT,
  registrationEndAt: REGISTRATION_END_AT,
  registrationMode: "automatic",
  status: "published",
  isCurrent: true,
  archivedAt: null,
  createdAt: "2026-06-27T06:00:00.000Z",
  updatedAt: "2026-06-27T06:00:00.000Z"
});

for (const [displayOrder, project] of PROJECTS.entries()) {
  Object.assign(project, {
    eventId: EVENT.id,
    enabled: true,
    instructorRequired: false,
    displayOrder,
    allowedGroups: [...APPROVED_GROUP_NAMES]
  });
}

export const PROJECT_GROUPS = PROJECTS.flatMap((project) =>
  APPROVED_GROUP_NAMES.map((groupName) => ({ projectId: project.id, groupName }))
);

export const GRADES = ["小学低组（1-3年级）", "小学中高组（4-6年级）", "中学组（初中、高中、职高）"];

export const seedDb = {
  users: [
    { id: "U1001", name: "陈宇航家长", phone: "13800000001", password: "123456", type: "ordinary", status: "active", sessionVersion: 0, mustChangePassword: false, createdAt: "2026-06-27T06:30:00.000Z" },
    { id: "U2001", name: "林老师", phone: "13800000011", password: "123456", type: "organization", status: "active", sessionVersion: 0, mustChangePassword: false, createdAt: "2026-06-27T06:31:00.000Z" },
    { id: "U9001", name: "赛事管理员", phone: "13900000000", password: "admin123", type: "admin", status: "active", sessionVersion: 0, mustChangePassword: false, createdAt: "2026-06-27T06:32:00.000Z" }
  ],
  organizations: [
    { id: "O1001", name: "温州市实验小学", code: "WZ-SYXX", ownerUserId: "U2001", contactName: "林老师", contactPhone: "13800000011", status: "active", createdAt: "2026-06-27T06:31:00.000Z" },
    { id: "O1002", name: "鹿城区青少年活动中心", code: "LC-QSNG", ownerUserId: "U2001", contactName: "王老师", contactPhone: "13800000012", status: "active", createdAt: "2026-06-27T06:31:30.000Z" }
  ],
  memberships: [
    { id: "M1001", userId: "U2001", organizationId: "O1001", role: "owner", status: "active", direction: "system", note: "组织创建人", createdAt: "2026-06-27T06:31:00.000Z", updatedAt: "2026-06-27T06:31:00.000Z" },
    { id: "M1002", userId: "U1001", organizationId: "O1001", role: "member", status: "active", direction: "user_request", note: "参加校队报名", createdAt: "2026-06-27T06:40:00.000Z", updatedAt: "2026-06-27T06:42:00.000Z" },
    { id: "M1003", userId: null, invitedPhone: "13700000003", invitedName: "王梓涵家长", organizationId: "O1002", role: "member", status: "invited", direction: "org_invite", note: "邀请加入无人机队伍", createdAt: "2026-06-27T06:45:00.000Z", updatedAt: "2026-06-27T06:45:00.000Z" }
  ],
  registrations: [
    {
      id: "R20260627001",
      source: "普通用户",
      userId: "U1001",
      organizationId: "O1001",
      organization: "温州市实验小学",
      athlete: { name: "陈宇航", school: "温州市实验小学", grade: "五年级", phone: "13800000001" },
      athleteKey: "陈宇航|温州市实验小学|五年级|13800000001",
      group: "小学高段",
      projectId: "paper-plane-gate",
      projectName: "遥控纸飞机穿龙门飞行比赛",
      projectType: "individual",
      instructor: "林老师",
      status: "pending",
      rejectReason: "",
      awardName: "",
      rank: "",
      score: "",
      resultRecordedAt: "",
      createdAt: "2026-06-27T06:30:00.000Z",
      updatedAt: "2026-06-27T06:30:00.000Z"
    },
    {
      id: "R20260627002",
      source: "组织用户",
      userId: "U2001",
      organizationId: "O1002",
      organization: "鹿城区青少年活动中心",
      athlete: { name: "周星言", school: "温州市第二实验中学", grade: "初二", phone: "13900000002" },
      athleteKey: "周星言|温州市第二实验中学|初二|13900000002",
      group: "中学组",
      projectId: "drone-relay",
      projectName: "无人机竞速接力比赛",
      projectType: "team",
      instructor: "王老师",
      status: "approved",
      rejectReason: "",
      awardName: "",
      rank: "",
      score: "",
      resultRecordedAt: "",
      createdAt: "2026-06-27T06:34:00.000Z",
      updatedAt: "2026-06-27T06:34:00.000Z"
    }
  ],
  certificates: [],
  certificateImportBatches: [],
  certificateImportErrors: [],
  auditLogs: []
};

Object.assign(seedDb, {
  events: [EVENT],
  projects: PROJECTS,
  projectGroups: PROJECT_GROUPS,
  organizationDocuments: [],
  fileCleanupJournal: [],
  siteSettings: structuredClone(DEFAULT_SITE_SETTINGS),
  eventPublicProfiles: [],
  contentPosts: [],
  mediaAssets: [],
  contentAttachments: []
});
for (const organization of seedDb.organizations) {
  Object.assign(organization, {
    creditCode: `LEGACY-${organization.id}`,
    reviewStatus: "approved",
    rejectReason: "",
    reviewedBy: null,
    reviewedAt: null,
    updatedAt: organization.createdAt,
    currentDocumentId: null
  });
}
for (const row of seedDb.registrations) row.eventId = EVENT.id;

export function ensureDbShape(db) {
  db.siteSettings ||= {};
  for (const [key, value] of Object.entries(DEFAULT_SITE_SETTINGS)) {
    if (!Object.hasOwn(db.siteSettings, key)) db.siteSettings[key] = structuredClone(value);
  }
  db.eventPublicProfiles ||= [];
  db.contentPosts ||= [];
  db.mediaAssets ||= [];
  db.contentAttachments ||= [];
  db.users ||= [];
  for (const user of db.users) {
    user.sessionVersion ??= 0;
    user.mustChangePassword ??= false;
  }
  db.organizations ||= [];
  const isLegacyOrganizationShape = !Array.isArray(db.organizationDocuments);
  db.organizationDocuments ||= [];
  db.fileCleanupJournal ||= [];
  for (const organization of db.organizations) {
    if (!organization.creditCode) {
      organization.creditCode = isLegacyOrganizationShape
        ? `LEGACY-${organization.id}`
        : `PENDING-${organization.id}`;
    }
    organization.reviewStatus ||= isLegacyOrganizationShape ? "approved" : "pending";
    organization.rejectReason ||= "";
    organization.reviewedBy ??= null;
    organization.reviewedAt ??= null;
    organization.updatedAt ||= organization.createdAt;
    if (!Object.hasOwn(organization, "currentDocumentId")) {
      const currentDocument = db.organizationDocuments
        .filter((document) => document.organizationId === organization.id && !document.cleanedAt)
        .sort((left, right) => String(right.uploadedAt || "").localeCompare(String(left.uploadedAt || "")) || String(right.id || "").localeCompare(String(left.id || "")))[0];
      organization.currentDocumentId = currentDocument?.id || null;
    }
  }
  for (const marker of db.fileCleanupJournal) marker.lastAttemptAt ||= marker.createdAt;
  db.memberships ||= [];
  db.events ||= structuredClone([EVENT]);
  db.projects ||= structuredClone(PROJECTS);
  db.projectGroups ||= db.projects.flatMap((project) =>
    (project.allowedGroups || APPROVED_GROUP_NAMES).map((groupName) => ({ projectId: project.id, groupName }))
  );
  db.registrations ||= [];
  db.certificates ||= [];
  db.certificateImportBatches ||= [];
  db.certificateImportErrors ||= [];
  db.auditLogs ||= [];
  for (const event of db.events) {
    event.dateLabel ||= event.date;
    event.registrationStartAt ||= event.createdAt || REGISTRATION_START_AT;
    event.registrationEndAt ||= REGISTRATION_END_AT;
    event.registrationMode ||= "automatic";
    event.status ||= "published";
    event.isCurrent ??= event.id === EVENT.id;
    event.archivedAt ??= null;
    event.createdAt ||= REGISTRATION_START_AT;
    event.updatedAt ||= event.createdAt;
    if (!REGISTRATION_MODES.includes(event.registrationMode)) {
      throw new Error(`Invalid registration mode: ${event.registrationMode}`);
    }
  }
  for (const group of db.projectGroups) {
    if (!APPROVED_GROUP_NAMES.includes(group.groupName)) {
      throw new Error(`Invalid project group: ${group.groupName}`);
    }
  }
  for (const project of db.projects) {
    project.eventId ||= EVENT.id;
    project.enabled ??= true;
    project.instructorRequired ??= false;
    project.displayOrder ??= 0;
    project.allowedGroups ||= db.projectGroups
      .filter((group) => group.projectId === project.id)
      .map((group) => group.groupName);
    if (!project.allowedGroups.every((groupName) => APPROVED_GROUP_NAMES.includes(groupName))) {
      throw new Error(`Invalid project group for ${project.id}`);
    }
  }
  for (const row of db.registrations) {
    row.eventId ||= EVENT.id;
    row.group = groupForGrade(row.athlete?.grade) || row.group;
    row.awardName ||= "";
    row.rank ||= "";
    row.score ||= "";
    row.resultRecordedAt ||= "";
  }
  for (const certificate of db.certificates) {
    const legacyNumberKey = ["certificate", "No"].join("");
    certificate.slot = certificate.slot === 2 ? 2 : 1;
    certificate.title ||= certificate.awardName || "获奖证书";
    certificate.source ||= "manual";
    certificate.importBatchId ||= null;
    certificate.cleanedAt ||= "";
    delete certificate[legacyNumberKey];
  }
  return db;
}
