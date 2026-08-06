import ExcelJS from "exceljs";

export const MAX_REGISTRATION_EXPORT_ROWS = 10_000;
export const WORKBOOK_CREATOR = "青少年航空赛事报名系统";

export class RegistrationExportLimitError extends Error {
  constructor() {
    super(`导出最多支持 ${MAX_REGISTRATION_EXPORT_ROWS} 条报名，请缩小筛选范围后重试`);
    this.status = 413;
  }
}

const BASE_COLUMNS = [
  ["报名编号", (row) => row.id],
  ["报名来源", (row) => row.source],
  ["组织", (row) => row.organization],
  ["姓名", (row) => row.athlete?.name],
  ["学校", (row) => row.athlete?.school],
  ["实际年级", (row) => row.athlete?.grade],
  ["组别", (row) => row.group],
  ["手机号", (row) => row.athlete?.phone],
  ["赛项", (row) => row.projectName],
  ["项目类型", (row) => row.projectType === "team" ? "团体赛" : "个人赛"],
  ["指导老师", (row) => row.instructor],
  ["审核状态", (row) => row.status],
  ["奖项/等级", (row) => row.awardName],
  ["名次", (row) => row.rank],
  ["成绩/分数", (row) => row.score]
];

const TEXT_COLUMNS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

export function workbookColumnWidth(header) {
  if (header.includes("图片")) return 24;
  return Math.max(12, Math.min(28, header.length * 2 + 4));
}

export function createExportWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = WORKBOOK_CREATOR;
  workbook.created = new Date();
  return workbook;
}

export function styleWorkbookHeaderCell(cell, { fill = "FF1F4E78", fontColor = "FFFFFFFF" } = {}) {
  cell.font = { bold: true, color: { argb: fontColor } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  cell.alignment = { vertical: "middle", horizontal: "center" };
}

export function buildRegistrationWorkbook(rows) {
  const workbook = createExportWorkbook();

  const sheet = workbook.addWorksheet("报名名单", {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  const headers = BASE_COLUMNS.map(([header]) => header);
  const headerRow = sheet.addRow(headers);
  headerRow.height = 24;
  headerRow.eachCell((cell) => styleWorkbookHeaderCell(cell));

  for (const row of rows) {
    const data = BASE_COLUMNS.map(([, value]) => value(row) ?? "");
    const excelRow = sheet.addRow(data);
    excelRow.alignment = { vertical: "middle", wrapText: true };
  }

  for (let index = 1; index <= headers.length; index += 1) {
    const column = sheet.getColumn(index);
    column.width = workbookColumnWidth(headers[index - 1]);
    if (TEXT_COLUMNS.has(index)) column.numFmt = "@";
  }
  sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(headers.length).letter}${Math.max(1, sheet.rowCount)}` };
  return workbook;
}

export function buildBoundRegistrationWorkbook(rows, options = {}, build = buildRegistrationWorkbook) {
  if (rows.length > MAX_REGISTRATION_EXPORT_ROWS) throw new RegistrationExportLimitError();
  return build(rows, options);
}

function rfc5987Encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function contentDisposition(fileName) {
  const extension = String(fileName).toLowerCase().endsWith(".xlsx") ? ".xlsx" : "";
  const fallback = `download${extension || ".xlsx"}`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987Encode(fileName)}`;
}
