import { describe, expect, it, vi } from "vitest";

import { AdminRegistrationPaginationError, loadAdminRegistrations } from "../admin-registrations.js";

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

  it("fails closed when the initial response omits total", async () => {
    const request = vi.fn(async () => ({ rows: [{ id: "R1" }], page: 1, pageSize: 100 }));

    await expect(loadAdminRegistrations({}, request)).rejects.toBeInstanceOf(AdminRegistrationPaginationError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a later page is empty after the reported total changes", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `R${index + 1}` }));
    const request = vi.fn()
      .mockResolvedValueOnce({ rows: firstPage, total: 101, page: 1, pageSize: 100 })
      .mockResolvedValueOnce({ rows: [], total: 150, page: 2, pageSize: 100 });

    await expect(loadAdminRegistrations({}, request)).rejects.toThrow("报名数据在加载期间发生变化，请刷新重试");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the total grows on a later page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `R${index + 1}` }));
    const request = vi.fn()
      .mockResolvedValueOnce({ rows: firstPage, total: 101, page: 1, pageSize: 100 })
      .mockResolvedValueOnce({ rows: [{ id: "R101" }], total: 102, page: 2, pageSize: 100 });

    await expect(loadAdminRegistrations({}, request)).rejects.toBeInstanceOf(AdminRegistrationPaginationError);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails closed when duplicate rows leave the initial total incomplete", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `R${index + 1}` }));
    const request = vi.fn()
      .mockResolvedValueOnce({ rows: firstPage, total: 101, page: 1, pageSize: 100 })
      .mockResolvedValueOnce({ rows: [{ id: "R1" }], total: 101, page: 2, pageSize: 100 });

    await expect(loadAdminRegistrations({}, request)).rejects.toBeInstanceOf(AdminRegistrationPaginationError);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects maliciously large initial page counts without requesting more pages", async () => {
    const request = vi.fn(async () => ({ rows: [], total: 100001, page: 1, pageSize: 100 }));

    await expect(loadAdminRegistrations({}, request)).rejects.toBeInstanceOf(AdminRegistrationPaginationError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns complete zero and single-page results", async () => {
    await expect(loadAdminRegistrations({}, vi.fn(async () => ({ rows: [], total: 0, page: 1, pageSize: 100 })))).resolves.toEqual([]);
    await expect(loadAdminRegistrations({}, vi.fn(async () => ({ rows: [{ id: "R1" }], total: 1, page: 1, pageSize: 100 })))).resolves.toEqual([{ id: "R1" }]);
  });
});
