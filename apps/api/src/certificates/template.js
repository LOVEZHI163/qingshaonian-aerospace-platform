import {
  createExportWorkbook,
  styleWorkbookHeaderCell,
  workbookColumnWidth
} from "../exports/registration-workbook.js";

export const CERTIFICATE_COLUMNS = [
  ["报名编号", "id"], ["证书对象编号", "participantId"], ["姓名", "participantName"], ["学校", "participantSchool"], ["实际年级", "participantGrade"],
  ["组别", "group"], ["赛项", "projectName"], ["指导老师", "instructor"], ["状态", "status"],
  ["奖项/等级", "awardName"], ["名次", "rank"], ["成绩/分数", "score"],
  ["证书1名称", "certificate1Title"], ["证书1图片", "certificate1Image"],
  ["证书2名称", "certificate2Title"], ["证书2图片", "certificate2Image"]
];

const READ_ONLY_FILL = "FFE7E6E6";
const EDITABLE_FILL = "FFFFF2CC";

export function certificateTargets(registrations) {
  return (registrations || []).flatMap((registration) => {
    if (registration.projectType !== "team") {
      return [{
        ...registration,
        participantId: null,
        participantName: registration.athlete?.name || "",
        participantSchool: registration.athlete?.school || "",
        participantGrade: registration.athlete?.grade || ""
      }];
    }
    return (registration.participants || []).map((participant) => ({
      ...registration,
      participantId: participant.id,
      participantName: participant.name,
      participantSchool: participant.school,
      participantGrade: participant.grade
    }));
  });
}

function readPath(row, path) {
  if (path.startsWith("certificate")) return "";
  if (path === "participantName") return row.participantName ?? row.athlete?.name ?? "";
  if (path === "participantSchool") return row.participantSchool ?? row.athlete?.school ?? "";
  if (path === "participantGrade") return row.participantGrade ?? row.athlete?.grade ?? "";
  return path.split(".").reduce((value, part) => value?.[part], row) ?? "";
}

function fillForColumn(columnNumber) {
  return columnNumber <= 9 ? READ_ONLY_FILL : EDITABLE_FILL;
}

export async function buildCertificateTemplate(rows) {
  const workbook = createExportWorkbook();
  const sheet = workbook.addWorksheet("证书导入", {
    views: [{ state: "frozen", ySplit: 1 }]
  });

  const headers = CERTIFICATE_COLUMNS.map(([header]) => header);
  const headerRow = sheet.addRow(headers);
  headerRow.height = 24;
  headerRow.eachCell((cell, columnNumber) => {
    styleWorkbookHeaderCell(cell, { fill: fillForColumn(columnNumber), fontColor: "FF1F1F1F" });
  });

  for (const row of rows) {
    const values = CERTIFICATE_COLUMNS.map(([, path]) => readPath(row, path));
    const excelRow = sheet.addRow(values);
    excelRow.height = 90;
    excelRow.alignment = { vertical: "middle", wrapText: true };
    excelRow.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillForColumn(columnNumber) } };
      cell.numFmt = "@";
    });
  }

  for (let columnNumber = 1; columnNumber <= headers.length; columnNumber += 1) {
    const column = sheet.getColumn(columnNumber);
    column.width = [14, 16].includes(columnNumber) ? 24 : workbookColumnWidth(headers[columnNumber - 1]);
    column.numFmt = "@";
  }

  sheet.autoFilter = { from: "A1", to: `P${Math.max(1, sheet.rowCount)}` };
  return workbook;
}
