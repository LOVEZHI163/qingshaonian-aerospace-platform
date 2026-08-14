export function recoverReleaseMismatch(apiRelease, location = window.location) {
  const normalizedRelease = String(apiRelease || "").trim();
  if (!normalizedRelease) return false;

  const url = new URL(location.href);
  if (url.searchParams.get("releaseRefresh") === normalizedRelease) return false;

  url.searchParams.set("releaseRefresh", normalizedRelease);
  location.replace(`${url.pathname}${url.search}${url.hash}`);
  return true;
}
