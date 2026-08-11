import { describe, expect, it } from "vitest";

import { contentImportError } from "../content-import-errors.js";

describe("contentImportError", () => {
  it("maps stable API codes to useful Chinese guidance", () => {
    expect(contentImportError({ code: "IMPORT_URL_BLOCKED" })).toContain("公网");
    expect(contentImportError({ code: "IMPORT_FETCH_TIMEOUT" })).toContain("超时");
    expect(contentImportError({ code: "IMPORT_BATCH_EXPIRED" })).toContain("重新检查");
    expect(contentImportError({ code: "IMPORT_STORAGE_CRITICAL" })).toContain("空间");
  });

  it("falls back to the API message for unknown errors", () => {
    expect(contentImportError({ code: "UNKNOWN", message: "服务端具体错误" })).toBe("服务端具体错误");
  });
});
