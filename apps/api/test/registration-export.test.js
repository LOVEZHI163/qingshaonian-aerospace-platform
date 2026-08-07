import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import ExcelJS from "exceljs";

import { MAX_REGISTRATION_EXPORT_ROWS, buildBoundRegistrationWorkbook, contentDisposition } from "../src/exports/registration-workbook.js";
import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

const validId = "11010519491231002X";
const eventId = "wz-aerospace-2026";

async function withServer(fn) {
  await withTestServer(({ baseUrl }) => fn(baseUrl), { prefix: "wz-registration-export-" });
}

async function loadWorkbook(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /spreadsheetml\.sheet/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  return workbook;
}

function rowNumberForRegistration(sheet, registrationId) {
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    if (sheet.getCell(`A${rowNumber}`).value === registrationId) return rowNumber;
  }
  return null;
}

test("registration workbook exports filtered rows with the required headers and instructor", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const response = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/registrations/export.xlsx?group=%E4%B8%AD%E5%AD%A6%E7%BB%84&scope=filtered`, withSession(admin.cookie));
    const workbook = await loadWorkbook(response);
    const sheet = workbook.getWorksheet("报名名单");
    assert.ok(sheet);
    assert.deepEqual(sheet.getRow(1).values.slice(1), [
      "报名编号", "报名来源", "组织", "姓名", "学校", "实际年级", "组别", "手机号", "学生身份证号", "赛项", "项目类型", "指导老师", "审核状态", "奖项/等级", "名次", "成绩/分数"
    ]);
    assert.equal(sheet.getRow(2).getCell(12).value, "王老师");
    assert.equal(sheet.autoFilter, "A1:P2");
    assert.equal(sheet.views[0].state, "frozen");
  });
});

test("administrator and organization exports include authorized identity text without accepting a client organization scope", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const personal = await loginAs(baseUrl, "13800000001", "123456");
    const organization = await loginAs(baseUrl, "13800000011", "123456");
    const otherOrganization = await loginAs(baseUrl, "13800000012", "123456");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const opened = await fetch(`${baseUrl}/api/admin/events/${eventId}`, withSession(admin.cookie, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationMode: "force_open" })
    }));
    assert.equal(opened.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/${eventId}/join`, withSession(organization.cookie, { method: "POST" }))).status, 201);
    assert.equal((await fetch(`${baseUrl}/api/organization/events/${eventId}/join`, withSession(otherOrganization.cookie, { method: "POST" }))).status, 201);

    const createdResponse = await fetch(`${baseUrl}/api/me/events/${eventId}/registrations`, withSession(personal.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "rotor-race",
        athlete: { name: "Export Identity", school: "Export School", grade: "五年级", phone: "13600008101" },
        studentIdNumber: validId
      })
    }));
    assert.equal(createdResponse.status, 201);
    const createdRegistrationId = (await createdResponse.json()).row.id;

    const adminWorkbook = await loadWorkbook(await fetch(
      `${baseUrl}/api/admin/events/${eventId}/registrations/export.xlsx?scope=all`,
      withSession(admin.cookie)
    ));
    const adminSheet = adminWorkbook.getWorksheet("报名名单");
    const adminCreatedRow = rowNumberForRegistration(adminSheet, createdRegistrationId);
    const adminLegacyRow = rowNumberForRegistration(adminSheet, "R20260627001");

    const organizationResponse = await fetch(
      `${baseUrl}/api/organization/events/${eventId}/export.xlsx?organizationId=O1002`,
      withSession(organization.cookie)
    );
    assert.equal(organizationResponse.status, 200);
    assert.notEqual(adminCreatedRow, null);
    assert.notEqual(adminLegacyRow, null);
    assert.equal(adminSheet.getCell("I1").value, "学生身份证号");
    assert.equal(adminSheet.getCell(`I${adminCreatedRow}`).text, validId);
    assert.equal(adminSheet.getCell(`I${adminLegacyRow}`).text, "");
    assert.equal(adminSheet.getColumn(9).numFmt, "@");
    const organizationWorkbook = await loadWorkbook(organizationResponse);
    const organizationSheet = organizationWorkbook.getWorksheet("报名名单");
    const organizationCreatedRow = rowNumberForRegistration(organizationSheet, createdRegistrationId);
    const organizationLegacyRow = rowNumberForRegistration(organizationSheet, "R20260627001");
    assert.notEqual(organizationCreatedRow, null);
    assert.notEqual(organizationLegacyRow, null);
    assert.equal(organizationSheet.getCell("I1").value, "学生身份证号");
    assert.equal(organizationSheet.getCell(`I${organizationCreatedRow}`).text, validId);
    assert.equal(organizationSheet.getCell(`I${organizationLegacyRow}`).text, "");
    assert.equal(rowNumberForRegistration(organizationSheet, "R20260627002"), null);
  });
});

test("registration workbook certificate template includes only approved registrations in the dedicated import sheet", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const response = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/certificate-template.xlsx`, withSession(admin.cookie));
    assert.match(response.headers.get("content-disposition") || "", /%E8%AF%81%E4%B9%A6%E5%AF%BC%E5%85%A5%E6%A8%A1%E6%9D%BF\.xlsx/);
    const workbook = await loadWorkbook(response);
    const sheet = workbook.getWorksheet("证书导入");
    assert.equal(sheet.rowCount, 2);
    assert.deepEqual(sheet.getRow(1).values.slice(-4), ["证书1名称", "证书1图片", "证书2名称", "证书2图片"]);
    assert.equal(sheet.getColumn(13).width, 24);
    assert.equal(sheet.getColumn(15).width, 24);
    assert.equal(sheet.getRow(2).height, 90);
    assert.equal(sheet.getCell("I2").fill.fgColor.argb, "FFFFF2CC");
  });
});

test("event-scoped exports reject an unavailable URL event", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const unknown = await fetch(`${baseUrl}/api/admin/events/missing/registrations/export.xlsx?scope=all`, withSession(admin.cookie));
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, "EVENT_NOT_AVAILABLE");
  });
});

test("export row limit rejects 10001 rows before creating a workbook", () => {
  let created = false;
  assert.throws(() => buildBoundRegistrationWorkbook(Array.from({ length: MAX_REGISTRATION_EXPORT_ROWS + 1 }), {}, () => {
    created = true;
    return new ExcelJS.Workbook();
  }), { status: 413 });
  assert.equal(created, false);
});

test("registration workbook exports stable Chinese labels for both organization registration channels", () => {
  const workbook = buildBoundRegistrationWorkbook([
    { id: "R1", source: "member_registration", athlete: {} },
    { id: "R2", source: "organization_proxy", athlete: {} },
    { id: "R3", source: "personal", athlete: {} },
    { id: "R4", source: "organization", athlete: {} }
  ]);
  const sheet = workbook.worksheets[0];
  assert.deepEqual([2, 3, 4, 5].map((row) => sheet.getRow(row).getCell(2).value), [
    "成员报名", "组织代报名", "成员本人报名", "历史组织报名"
  ]);
});

test("attachment filenames include an RFC5987 value and safe ASCII fallback", () => {
  const value = contentDisposition("赛事(总决赛)'*.xlsx");
  assert.match(value, /filename="download\.xlsx"/);
  assert.match(value, /filename\*=UTF-8''/);
  assert.match(value, /%28.*%29.*%27.*%2A/);
});

test("certificate template rejects more than 5000 approved rows before workbook generation", async () => {
  await withTestServer(async ({ baseUrl, dbPath }) => {
    const db = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const source = db.registrations.find((row) => row.status === "approved");
    db.registrations = Array.from({ length: 5_001 }, (_, index) => ({
      ...structuredClone(source),
      id: `R-TEMPLATE-${index + 1}`,
      athlete: { ...source.athlete, name: `Template athlete ${index + 1}` },
      athleteKey: `template-${index + 1}`
    }));
    await fs.writeFile(dbPath, JSON.stringify(db), "utf8");
    const admin = await loginAs(baseUrl, "13900000000", "admin123");

    const response = await fetch(
      `${baseUrl}/api/admin/events/wz-aerospace-2026/certificate-template.xlsx`,
      withSession(admin.cookie)
    );
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /5,000|5000/);
  }, { prefix: "certificate-template-limit-" });
});
