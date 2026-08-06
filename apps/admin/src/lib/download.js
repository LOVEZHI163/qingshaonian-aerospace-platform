const RELEASE_DELAY_MS = 1_000;
const PREVIEW_RELEASE_DELAY_MS = 60_000;

export function createBlobDownloadManager() {
  const pending = new Map();

  function release(url) {
    const entry = pending.get(url);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.link.remove();
    URL.revokeObjectURL(url);
    pending.delete(url);
  }

  return {
    save(blob, fileName) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = blob?.fileName || fileName || "download";
      link.style.display = "none";
      document.body.append(link);
      link.click();
      const timer = setTimeout(() => release(url), RELEASE_DELAY_MS);
      pending.set(url, { link, timer });
    },
    dispose() {
      for (const url of [...pending.keys()]) release(url);
    }
  };
}

export function createBlobPreviewManager() {
  const pending = new Map();

  function release(url) {
    const timer = pending.get(url);
    if (timer === undefined) return;
    clearTimeout(timer);
    URL.revokeObjectURL(url);
    pending.delete(url);
  }

  return {
    reserve() {
      const popup = window.open("", "_blank", "noopener,noreferrer");
      if (!popup) return null;
      try { popup.opener = null; } catch { /* noopener is already requested */ }
      return { popup, url: "" };
    },
    navigate(reservation, blob) {
      const url = URL.createObjectURL(blob);
      reservation.url = url;
      pending.set(url, setTimeout(() => release(url), PREVIEW_RELEASE_DELAY_MS));
      reservation.popup.location.href = url;
    },
    close(reservation) {
      if (!reservation) return;
      if (reservation.url) release(reservation.url);
      try { reservation.popup.close(); } catch { /* the popup may already be closed */ }
    },
    dispose() {
      for (const url of [...pending.keys()]) release(url);
    }
  };
}
