import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";

import { withTestServer } from "../test-support/server.js";
import { loginAs, withSession } from "./helpers/api-client.js";

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

test("registration workbook exports filtered rows with the required headers and instructor", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const response = await fetch(`${baseUrl}/api/admin/registrations/export.xlsx?eventId=wz-aerospace-2026&group=%E4%B8%AD%E5%AD%A6%E7%BB%84&scope=filtered`, withSession(admin.cookie));
    const workbook = await loadWorkbook(response);
    const sheet = workbook.getWorksheet("报名名单");
    assert.ok(sheet);
    assert.deepEqual(sheet.getRow(1).values.slice(1), [
      "报名编号", "报名来源", "组织", "姓名", "学校", "实际年级", "组别", "手机号", "赛项", "项目类型", "指导老师", "审核状态", "奖项/等级", "名次", "成绩/分数"
    ]);
    assert.equal(sheet.getRow(2).getCell(11).value, "王老师");
    assert.equal(sheet.autoFilter, "A1:O2");
    assert.equal(sheet.views[0].state, "frozen");
  });
});

test("certificate template includes only approved registrations and exactly two editable certificate pairs", async () => {
  await withServer(async (baseUrl) => {
    const admin = await loginAs(baseUrl, "13900000000", "admin123");
    const response = await fetch(`${baseUrl}/api/admin/events/wz-aerospace-2026/certificate-template.xlsx`, withSession(admin.cookie));
    const workbook = await loadWorkbook(response);
    const sheet = workbook.getWorksheet("报名名单");
    assert.equal(sheet.rowCount, 2);
    assert.deepEqual(sheet.getRow(1).values.slice(-4), ["证书1名称", "证书1图片", "证书2名称", "证书2图片"]);
    assert.equal(sheet.getColumn(17).width, 24);
    assert.equal(sheet.getRow(2).height, 90);
    assert.equal(sheet.getCell("P2").fill.fgColor.argb, "FFFFF2CC");
  });
});
