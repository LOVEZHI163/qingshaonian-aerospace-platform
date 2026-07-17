import { api } from "./api.js";

function requestPath(filters, page) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters || {})) {
    if (value !== undefined && value !== null && value !== "" && key !== "page" && key !== "pageSize") {
      params.set(key, String(value));
    }
  }
  if (page > 1) params.set("page", String(page));
  params.set("pageSize", "100");
  return `/api/admin/registrations?${params}`;
}

export async function loadAdminRegistrations(filters = {}, request = api) {
  const rows = [];
  const seen = new Set();
  let page = 1;
  let previousPage = 0;

  while (true) {
    const payload = await request(requestPath(filters, page));
    const pageRows = Array.isArray(payload?.rows) ? payload.rows : [];
    let added = 0;
    for (const row of pageRows) {
      const key = row?.id || JSON.stringify(row);
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(row);
        added += 1;
      }
    }

    const total = Number(payload?.total);
    const responsePage = Number(payload?.page);
    const pageSize = Number(payload?.pageSize);
    if (!Number.isFinite(total) || total <= rows.length || pageRows.length === 0 || added === 0) return rows;
    if (!Number.isInteger(responsePage) || responsePage < page || responsePage <= previousPage) return rows;
    if (!Number.isInteger(pageSize) || pageSize < 1) return rows;
    previousPage = responsePage;
    page = responsePage + 1;
  }
}
