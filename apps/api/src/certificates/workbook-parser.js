import ExcelJS from "exceljs";

export const MAX_CERTIFICATE_ROWS = 5_000;
export const MAX_CERTIFICATE_IMAGES = 10_000;
export const MAX_CERTIFICATE_WORKBOOK_BYTES = 25 * 1024 * 1024;

const IMAGE_COLUMN_TO_SLOT = new Map([[13, 1], [15, 2]]);
const MIME_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"]
]);

export class CertificateWorkbookLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "CertificateWorkbookLimitError";
    this.status = 413;
  }
}

function limitError(message) {
  return new CertificateWorkbookLimitError(message);
}

function valueToString(value, fallback = "") {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value).trim();
  if ("result" in value) return valueToString(value.result, fallback);
  if ("text" in value) return valueToString(value.text, fallback);
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("").trim();
  return String(fallback || "").trim();
}

function cellText(cell) {
  return valueToString(cell.value, cell.text);
}

function normalizeExtension(asset) {
  const extension = String(asset?.extension || "").toLowerCase().replace(/^\./, "");
  if (extension) return extension;
  const match = String(asset?.filename || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

function hasExistingSlot(registration, slot) {
  return Array.isArray(registration.certificates)
    && registration.certificates.some((certificate) => Number(certificate.slot) === slot);
}

function workbookBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return Buffer.from(input || []);
}

export async function parseCertificateWorkbook(input, registrations) {
  const buffer = workbookBuffer(input);
  if (buffer.length > MAX_CERTIFICATE_WORKBOOK_BYTES) {
    throw limitError("证书工作簿不能超过 25 MB");
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("证书导入");
  if (!sheet) {
    const error = new Error("工作簿缺少“证书导入”工作表");
    error.status = 422;
    throw error;
  }

  const placedImages = sheet.getImages();
  if (placedImages.length > MAX_CERTIFICATE_IMAGES) {
    throw limitError("证书工作簿最多支持 10,000 张图片");
  }

  const imageRows = placedImages.map((placed) => Math.floor(placed.range.tl.nativeRow) + 1);
  const lastRow = Math.max(sheet.rowCount, ...imageRows, 1);
  if (lastRow - 1 > MAX_CERTIFICATE_ROWS) {
    throw limitError("证书工作簿最多支持 5,000 行报名数据");
  }

  const registrationsById = new Map((registrations || []).map((registration) => [String(registration.id), registration]));
  const imagesByCell = new Map();
  const errors = [];
  const invalidRows = new Set();
  const pushError = ({ rowNumber, registrationId = "", message }) => {
    errors.push({ rowNumber, registrationId, message });
    invalidRows.add(rowNumber);
  };

  for (const placed of placedImages) {
    const rowNumber = Math.floor(placed.range.tl.nativeRow) + 1;
    const columnNumber = Math.floor(placed.range.tl.nativeCol) + 1;
    const registrationId = cellText(sheet.getCell(rowNumber, 1));
    const slot = IMAGE_COLUMN_TO_SLOT.get(columnNumber);
    if (!slot) {
      pushError({ rowNumber, registrationId, message: "图片必须放在证书1图片或证书2图片列" });
      continue;
    }

    const key = `${rowNumber}:${slot}`;
    if (imagesByCell.has(key)) {
      pushError({ rowNumber, registrationId, message: `证书${slot}图片单元格只能放一张图片` });
      continue;
    }
    imagesByCell.set(key, workbook.getImage(placed.imageId));
  }

  const candidates = [];
  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber += 1) {
    const registrationId = cellText(sheet.getCell(rowNumber, 1));
    const result = {
      awardName: cellText(sheet.getCell(rowNumber, 9)),
      rank: cellText(sheet.getCell(rowNumber, 10)),
      score: cellText(sheet.getCell(rowNumber, 11))
    };
    const titles = new Map([
      [1, cellText(sheet.getCell(rowNumber, 12))],
      [2, cellText(sheet.getCell(rowNumber, 14))]
    ]);
    const hasEditableContent = Object.values(result).some(Boolean)
      || [...titles.values()].some(Boolean)
      || [1, 2].some((slot) => imagesByCell.has(`${rowNumber}:${slot}`));

    if (!hasEditableContent) continue;
    if (!registrationId) {
      pushError({ rowNumber, message: "报名编号不能为空" });
      continue;
    }

    const registration = registrationsById.get(registrationId);
    if (!registration) {
      pushError({ rowNumber, registrationId, message: "报名编号不存在" });
      continue;
    }
    if (registration.status !== "approved") {
      pushError({ rowNumber, registrationId, message: "报名记录未通过审核" });
      continue;
    }

    const certificates = [];
    for (const slot of [1, 2]) {
      const title = titles.get(slot);
      const asset = imagesByCell.get(`${rowNumber}:${slot}`);
      if (Boolean(title) !== Boolean(asset)) {
        pushError({ rowNumber, registrationId, message: `证书${slot}名称和图片必须同时提供` });
        continue;
      }
      if (!asset) continue;

      const extension = normalizeExtension(asset);
      certificates.push({
        slot,
        title,
        extension,
        mimeType: MIME_TYPES.get(extension) || "application/octet-stream",
        buffer: Buffer.from(asset.buffer),
        replacing: hasExistingSlot(registration, slot)
      });
    }

    if (invalidRows.has(rowNumber)) continue;
    candidates.push({ rowNumber, registrationId, result, certificates });
  }

  return { candidates, errors };
}
