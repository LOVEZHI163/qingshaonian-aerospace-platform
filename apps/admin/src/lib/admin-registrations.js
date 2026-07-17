import { api } from "./api.js";

const PAGE_SIZE_LIMIT = 100;
const MAX_PAGES = 100;
const MAX_ROWS = 10000;
const ERROR_MESSAGE = "报名数据在加载期间发生变化，请刷新重试";
const LIMIT_ERROR_MESSAGE = "报名数据过多，请缩小赛事或筛选范围后重试";

export class AdminRegistrationPaginationError extends Error {
  constructor() {
    super(ERROR_MESSAGE);
    this.name = "AdminRegistrationPaginationError";
  }
}

export class AdminRegistrationLimitError extends Error {
  constructor() {
    super(LIMIT_ERROR_MESSAGE);
    this.name = "AdminRegistrationLimitError";
  }
}

function paginationError() {
  return new AdminRegistrationPaginationError();
}

function limitError() {
  return new AdminRegistrationLimitError();
}

function requestPath(filters, page) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters || {})) {
    if (value !== undefined && value !== null && value !== "" && key !== "page" && key !== "pageSize") {
      params.set(key, String(value));
    }
  }
  if (page > 1) params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE_LIMIT));
  return `/api/admin/registrations?${params}`;
}

function metadata(payload) {
  const total = Number(payload?.total);
  const page = Number(payload?.page);
  const pageSize = Number(payload?.pageSize);
  if (!Number.isSafeInteger(total) || total < 0
    || !Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_LIMIT) {
    throw paginationError();
  }
  return { total, page, pageSize };
}

function pageRows(payload, pageSize) {
  if (!Array.isArray(payload?.rows) || payload.rows.length > pageSize) throw paginationError();
  return payload.rows;
}

export async function loadAdminRegistrations(filters = {}, request = api) {
  const firstPayload = await request(requestPath(filters, 1));
  const { total: initialTotal, page: initialPage, pageSize: initialPageSize } = metadata(firstPayload);
  if (initialPage !== 1) throw paginationError();
  const expectedPages = Math.ceil(initialTotal / initialPageSize);
  if (initialTotal > MAX_ROWS || expectedPages > MAX_PAGES) throw limitError();

  const rows = [];
  const seen = new Set();
  for (let expectedPage = 1, payload = firstPayload; expectedPage <= Math.max(1, expectedPages); expectedPage += 1) {
    if (expectedPage > 1) payload = await request(requestPath(filters, expectedPage));
    const { total, page, pageSize } = metadata(payload);
    if (total !== initialTotal || page !== expectedPage || pageSize !== initialPageSize) throw paginationError();
    const currentRows = pageRows(payload, pageSize);
    for (const row of currentRows) {
      const key = row?.id || JSON.stringify(row);
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(row);
      }
    }
    if (rows.length > initialTotal) throw paginationError();
    if (expectedPage < expectedPages && currentRows.length === 0) throw paginationError();
  }

  if (rows.length !== initialTotal) throw paginationError();
  return rows;
}
