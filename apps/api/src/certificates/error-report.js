import ExcelJS from "exceljs";

export async function buildCertificateErrorReport(batch, errors) {
  if (!batch || !Array.isArray(errors) || errors.length === 0) return null;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "青少年航空大奖赛管理平台";
  workbook.created = new Date(batch.createdAt || Date.now());
  const sheet = workbook.addWorksheet("导入错误");
  sheet.columns = [
    { header: "Excel 行号", key: "rowNumber", width: 14 },
    { header: "报名编号", key: "registrationId", width: 24 },
    { header: "错误原因", key: "message", width: 56 }
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
  for (const error of errors) {
    sheet.addRow({
      rowNumber: Number(error.rowNumber),
      registrationId: error.registrationId || "",
      message: error.message
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
