import ExcelJS from "exceljs";

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

const CERTIFICATE_COLUMNS = ["证书1名称", "证书1图片", "证书2名称", "证书2图片"];
const TEXT_COLUMNS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

function columnWidth(header) {
  if (header.includes("图片")) return 24;
  return Math.max(12, Math.min(28, header.length * 2 + 4));
}

export function buildRegistrationWorkbook(rows, { mode = "registration" } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "青少年航空赛事报名系统";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("报名名单", {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  const headers = [...BASE_COLUMNS.map(([header]) => header), ...(mode === "certificate-template" ? CERTIFICATE_COLUMNS : [])];
  const headerRow = sheet.addRow(headers);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });

  for (const row of rows) {
    const data = BASE_COLUMNS.map(([, value]) => value(row) ?? "");
    if (mode === "certificate-template") data.push("", "", "", "");
    const excelRow = sheet.addRow(data);
    excelRow.alignment = { vertical: "middle", wrapText: true };
    if (mode === "certificate-template") {
      excelRow.height = 90;
      for (let index = BASE_COLUMNS.length + 1; index <= headers.length; index += 1) {
        const cell = excelRow.getCell(index);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
      }
    }
  }

  for (let index = 1; index <= headers.length; index += 1) {
    const column = sheet.getColumn(index);
    column.width = columnWidth(headers[index - 1]);
    if (TEXT_COLUMNS.has(index)) column.numFmt = "@";
  }
  sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(headers.length).letter}${Math.max(1, sheet.rowCount)}` };
  return workbook;
}
