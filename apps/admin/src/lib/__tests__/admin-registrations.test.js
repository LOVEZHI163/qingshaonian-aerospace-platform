import { describe, expect, it, vi } from "vitest";

import { loadAdminRegistrations } from "../admin-registrations.js";

describe("loadAdminRegistrations", () => {
  it("loads every page, preserving filters and deduplicating rows", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `R${index + 1}` }));
    const request = vi.fn(async (path) => {
      if (path === "/api/admin/registrations?status=pending&pageSize=100") {
        return { rows: firstPage, total: 101, page: 1, pageSize: 100 };
      }
      if (path === "/api/admin/registrations?status=pending&page=2&pageSize=100") {
        return { rows: [{ id: "R101" }], total: 101, page: 2, pageSize: 100 };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const rows = await loadAdminRegistrations({ status: "pending" }, request);

    expect(rows).toHaveLength(101);
    expect(request).toHaveBeenNthCalledWith(1, "/api/admin/registrations?status=pending&pageSize=100");
    expect(request).toHaveBeenNthCalledWith(2, "/api/admin/registrations?status=pending&page=2&pageSize=100");
  });

  it("safely returns the first page when a legacy response omits total", async () => {
    const request = vi.fn(async () => ({ rows: [{ id: "R1" }], page: 1, pageSize: 100 }));

    await expect(loadAdminRegistrations({}, request)).resolves.toEqual([{ id: "R1" }]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stops safely when a later page is empty after the reported total changes", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `R${index + 1}` }));
    const request = vi.fn()
      .mockResolvedValueOnce({ rows: firstPage, total: 101, page: 1, pageSize: 100 })
      .mockResolvedValueOnce({ rows: [], total: 150, page: 2, pageSize: 100 });

    await expect(loadAdminRegistrations({}, request)).resolves.toEqual(firstPage);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
