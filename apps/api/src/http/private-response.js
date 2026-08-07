export function setPrivateNoStore(res) {
  res.setHeader("Cache-Control", "private, no-store");
  return res;
}

export function sendPrivateJson(res, payload, { status = 200 } = {}) {
  setPrivateNoStore(res);
  return res.status(status).json(payload);
}
