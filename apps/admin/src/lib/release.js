export async function checkReleaseCompatibility(request, webRelease) {
  const normalizedWeb = String(webRelease || "development").trim() || "development";
  const payload = await request("/api/system/version");
  const apiRelease = String(payload?.releaseSha || "").trim();
  const development = normalizedWeb === "development" || apiRelease === "development";

  return {
    compatible: development || normalizedWeb === apiRelease,
    webRelease: normalizedWeb,
    apiRelease
  };
}
