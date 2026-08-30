export function createApiErrorHandler({ logger = console } = {}) {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status === 500) {
      logger.error("Unhandled API request error", {
        method: req.method,
        path: req.originalUrl,
        message: error?.message || "Unknown error",
        stack: error?.stack || ""
      });
    }
    const contentRange = error?.headers?.["Content-Range"];
    if (typeof contentRange === "string" && /^bytes \*\/\d+$/.test(contentRange)) {
      res.setHeader("Content-Range", contentRange);
    }
    res.status(status).json({
      error: status === 500 ? "服务器内部错误" : error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.relation ? { relation: error.relation } : {}),
      ...(error.details ? { details: error.details } : {})
    });
  };
}
