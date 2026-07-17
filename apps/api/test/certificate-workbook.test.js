import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ExcelJS from "exceljs";

import { buildCertificateTemplate, CERTIFICATE_COLUMNS } from "../src/certificates/template.js";
import {
  MAX_CERTIFICATE_IMAGES,
  MAX_CERTIFICATE_ROWS,
  MAX_CERTIFICATE_WORKBOOK_BYTES,
  parseCertificateWorkbook
} from "../src/certificates/workbook-parser.js";

const approvedRegistration = {
  id: "R-APPROVED-001",
  athlete: { name: "林小飞", school: "温州实验学校", grade: "六年级" },
  group: "小学高段",
  projectName: "纸飞机留空赛",
  instructor: "陈老师",
  status: "approved",
  awardName: "",
  rank: "",
  score: "",
  certificates: [{ slot: 2 }]
};

const pendingRegistration = {
  ...approvedRegistration,
  id: "R-PENDING-001",
  status: "pending",
  certificates: []
};

const heroPngUrl = new URL("../../web/public/images/hero-aerospace.png", import.meta.url);
const jpegUrl = new URL("../../../qa-web.png", import.meta.url);
const heroPngPromise = readFile(heroPngUrl);
const jpegPromise = readFile(jpegUrl);
const onePixelGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

async function addImage(workbook, sheet, buffer, { col, row = 1.1, extension = "png" } = {}) {
  const imageId = workbook.addImage({ buffer, extension });
  sheet.addImage(imageId, { tl: { col, row }, ext: { width: 80, height: 80 } });
}

async function parseWorkbook(workbook, registrations = [approvedRegistration]) {
  return parseCertificateWorkbook(await workbook.xlsx.writeBuffer(), registrations);
}

test("certificate workbook parses two real embedded PNG images from M2 and O2", async () => {
  const heroPng = await heroPngPromise;
  assert.ok(heroPng.length > 1_700_000);
  assert.equal(heroPng.subarray(0, 8).toString("hex").toUpperCase(), "89504E470D0A1A0A");

  const workbook = await buildCertificateTemplate([approvedRegistration]);
  const sheet = workbook.getWorksheet("证书导入");
  sheet.getCell("I2").value = "一等奖";
  sheet.getCell("J2").value = 1;
  sheet.getCell("K2").value = 0;
  sheet.getCell("L2").value = "一等奖证书";
  sheet.getCell("N2").value = "优秀选手证书";
  await addImage(workbook, sheet, heroPng, { col: 12.1 });
  await addImage(workbook, sheet, heroPng, { col: 14.1 });

  const parsed = await parseWorkbook(workbook);

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.candidates.length, 1);
  assert.deepEqual(parsed.candidates[0].result, { awardName: "一等奖", rank: "1", score: "0" });
  assert.deepEqual(parsed.candidates[0].certificates.map(({ slot, title, extension, mimeType, replacing }) => ({
    slot, title, extension, mimeType, replacing
  })), [
    { slot: 1, title: "一等奖证书", extension: "png", mimeType: "image/png", replacing: false },
    { slot: 2, title: "优秀选手证书", extension: "png", mimeType: "image/png", replacing: true }
  ]);
  assert.equal(parsed.candidates[0].certificates.every((certificate) => Buffer.compare(certificate.buffer, heroPng) === 0), true);
  assert.equal("certificateNo" in parsed.candidates[0], false);
});

test("certificate workbook accepts real JPEG content declared as JPG or JPEG and returns canonical metadata", async () => {
  const jpeg = await jpegPromise;
  assert.equal(jpeg.subarray(0, 3).toString("hex").toUpperCase(), "FFD8FF");

  const workbook = await buildCertificateTemplate([approvedRegistration]);
  const sheet = workbook.getWorksheet("证书导入");
  sheet.getCell("L2").value = "JPG 证书";
  sheet.getCell("N2").value = "JPEG 证书";
  await addImage(workbook, sheet, jpeg, { col: 12.1, extension: "jpg" });
  await addImage(workbook, sheet, jpeg, { col: 14.1, extension: "jpeg" });

  const parsed = await parseWorkbook(workbook);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.candidates[0].certificates.map(({ extension, mimeType }) => ({ extension, mimeType })), [
    { extension: "jpg", mimeType: "image/jpeg" },
    { extension: "jpg", mimeType: "image/jpeg" }
  ]);
});

test("certificate workbook detects a JPEG disguised with an ExcelJS PNG extension", async () => {
  const jpeg = await jpegPromise;
  const workbook = await buildCertificateTemplate([approvedRegistration]);
  const sheet = workbook.getWorksheet("证书导入");
  sheet.getCell("L2").value = "伪装扩展";
  await addImage(workbook, sheet, jpeg, { col: 12.1, extension: "png" });

  const parsed = await parseWorkbook(workbook);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.candidates[0].certificates.map(({ extension, mimeType }) => ({ extension, mimeType })), [
    { extension: "jpg", mimeType: "image/jpeg" }
  ]);
});

test("certificate workbook rejects real GIF content and excludes its row from candidates", async () => {
  const workbook = await buildCertificateTemplate([approvedRegistration]);
  const sheet = workbook.getWorksheet("证书导入");
  sheet.getCell("L2").value = "GIF 不允许";
  await addImage(workbook, sheet, onePixelGif, { col: 12.1, extension: "gif" });

  const parsed = await parseWorkbook(workbook);
  assert.equal(parsed.candidates.length, 0);
  assert.match(parsed.errors[0].message, /只支持 PNG、JPG 或 JPEG/);
});

test("certificate workbook rejects unknown bytes disguised with a PNG extension", async () => {
  const workbook = await buildCertificateTemplate([approvedRegistration]);
  const sheet = workbook.getWorksheet("证书导入");
  sheet.getCell("L2").value = "未知格式";
  await addImage(workbook, sheet, Buffer.from("not an image"), { col: 12.1, extension: "png" });

  const parsed = await parseWorkbook(workbook);
  assert.equal(parsed.candidates.length, 0);
  assert.match(parsed.errors[0].message, /只支持 PNG、JPG 或 JPEG/);
});

test("certificate workbook template fixes columns, styles, filter, and editable image layout", async () => {
  const workbook = await buildCertificateTemplate([{
    ...approvedRegistration,
    awardName: "二等奖",
    rank: "2",
    score: "88.5"
  }]);
  const sheet = workbook.getWorksheet("证书导入");

  assert.deepEqual(CERTIFICATE_COLUMNS, [
    ["报名编号", "id"], ["姓名", "athlete.name"], ["学校", "athlete.school"], ["实际年级", "athlete.grade"],
    ["组别", "group"], ["赛项", "projectName"], ["指导老师", "instructor"], ["状态", "status"],
    ["奖项/等级", "awardName"], ["名次", "rank"], ["成绩/分数", "score"],
    ["证书1名称", "certificate1Title"], ["证书1图片", "certificate1Image"],
    ["证书2名称", "certificate2Title"], ["证书2图片", "certificate2Image"]
  ]);
  assert.deepEqual(sheet.getRow(1).values.slice(1), CERTIFICATE_COLUMNS.map(([header]) => header));
  assert.deepEqual(sheet.getRow(2).values.slice(1, 12), [
    "R-APPROVED-001", "林小飞", "温州实验学校", "六年级", "小学高段", "纸飞机留空赛", "陈老师", "approved", "二等奖", "2", "88.5"
  ]);
  assert.equal(sheet.getCell("A2").fill.fgColor.argb, "FFE7E6E6");
  assert.equal(sheet.getCell("I2").fill.fgColor.argb, "FFFFF2CC");
  assert.equal(sheet.getColumn(13).width, 24);
  assert.equal(sheet.getColumn(15).width, 24);
  assert.equal(sheet.getRow(2).height, 90);
  assert.deepEqual(sheet.views, [{ state: "frozen", ySplit: 1 }]);
  assert.deepEqual(sheet.autoFilter, { from: "A1", to: "O2" });
  assert.equal(sheet.sheetProtection, null);
});

test("certificate workbook rejects a title without its image", async () => {
  const workbook = await buildCertificateTemplate([approvedRegistration]);
  workbook.getWorksheet("证书导入").getCell("L2").value = "缺少图片";

  const parsed = await parseWorkbook(workbook);
  assert.equal(parsed.candidates.length, 0);
  assert.match(parsed.errors[0].message, /证书1名称和图片必须同时提供/);
});

test("certificate workbook rejects an image without its title", async () => {
  const heroPng = await heroPngPromise;
  const workbook = await buildCertificateTemplate([approvedRegistration]);
  const sheet = workbook.getWorksheet("证书导入");
  await addImage(workbook, sheet, heroPng, { col: 12.1 });

  const parsed = await parseWorkbook(workbook);
  assert.equal(parsed.candidates.length, 0);
  assert.match(parsed.errors[0].message, /证书1名称和图片必须同时提供/);
});

test("certificate workbook rejects duplicate images anchored to one slot", async () => {
  const heroPng = await heroPngPromise;
  const workbook = await buildCertificateTemplate([approvedRegistration]);
  const sheet = workbook.getWorksheet("证书导入");
  sheet.getCell("L2").value = "重复锚点";
  await addImage(workbook, sheet, heroPng, { col: 12.1 });
  await addImage(workbook, sheet, heroPng, { col: 12.2 });

  const parsed = await parseWorkbook(workbook);
  assert.equal(parsed.candidates.length, 0);
  assert.match(parsed.errors[0].message, /证书1图片单元格只能放一张图片/);
});

test("certificate workbook matches registrations only from column A and rejects unknown identifiers", async () => {
  const heroPng = await heroPngPromise;
  const workbook = await buildCertificateTemplate([approvedRegistration]);
  const sheet = workbook.getWorksheet("证书导入");
  sheet.getCell("A2").value = "R-UNKNOWN";
  sheet.getCell("B2").value = approvedRegistration.athlete.name;
  sheet.getCell("L2").value = "未知报名";
  await addImage(workbook, sheet, heroPng, { col: 12.1 });

  const parsed = await parseWorkbook(workbook);
  assert.equal(parsed.candidates.length, 0);
  assert.equal(parsed.errors[0].registrationId, "R-UNKNOWN");
  assert.match(parsed.errors[0].message, /报名编号不存在/);
});

test("certificate workbook rejects registrations that are not approved", async () => {
  const heroPng = await heroPngPromise;
  const workbook = await buildCertificateTemplate([pendingRegistration]);
  const sheet = workbook.getWorksheet("证书导入");
  sheet.getCell("L2").value = "待审核报名";
  await addImage(workbook, sheet, heroPng, { col: 12.1 });

  const parsed = await parseWorkbook(workbook, [pendingRegistration]);
  assert.equal(parsed.candidates.length, 0);
  assert.match(parsed.errors[0].message, /报名记录未通过审核/);
});

test("certificate workbook rejects images placed outside M and O columns", async () => {
  const heroPng = await heroPngPromise;
  const workbook = await buildCertificateTemplate([approvedRegistration]);
  const sheet = workbook.getWorksheet("证书导入");
  await addImage(workbook, sheet, heroPng, { col: 11.1 });

  const parsed = await parseWorkbook(workbook);
  assert.equal(parsed.candidates.length, 0);
  assert.equal(parsed.errors[0].rowNumber, 2);
  assert.equal(parsed.errors[0].registrationId, approvedRegistration.id);
  assert.match(parsed.errors[0].message, /图片必须放在证书1图片或证书2图片列/);
});

test("certificate workbook enforces the 25 MB file boundary before loading Excel", async () => {
  await assert.rejects(parseCertificateWorkbook(Buffer.alloc(MAX_CERTIFICATE_WORKBOOK_BYTES + 1), []), (error) => {
    assert.equal(error.status, 413);
    assert.match(error.message, /25 MB/);
    return true;
  });
});

test("certificate workbook accepts 5000 data rows and rejects row 5001", async () => {
  const atLimit = new ExcelJS.Workbook();
  const atLimitSheet = atLimit.addWorksheet("证书导入");
  atLimitSheet.getCell(MAX_CERTIFICATE_ROWS + 1, 1).value = approvedRegistration.id;
  const parsed = await parseWorkbook(atLimit);
  assert.deepEqual(parsed, { candidates: [], errors: [] });

  const overLimit = new ExcelJS.Workbook();
  const overLimitSheet = overLimit.addWorksheet("证书导入");
  overLimitSheet.getCell(MAX_CERTIFICATE_ROWS + 2, 1).value = approvedRegistration.id;
  await assert.rejects(parseWorkbook(overLimit), (error) => {
    assert.equal(error.status, 413);
    assert.match(error.message, /5,000/);
    return true;
  });
});

test("certificate workbook rejects image 10001 before row parsing", async () => {
  const heroPng = await heroPngPromise;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("证书导入");
  sheet.getCell("A2").value = approvedRegistration.id;
  const imageId = workbook.addImage({ buffer: heroPng, extension: "png" });
  for (let index = 0; index < MAX_CERTIFICATE_IMAGES + 1; index += 1) {
    sheet.addImage(imageId, { tl: { col: 12.1, row: 1.1 }, ext: { width: 1, height: 1 } });
  }

  await assert.rejects(parseWorkbook(workbook), (error) => {
    assert.equal(error.status, 413);
    assert.match(error.message, /10,000/);
    return true;
  });
});
