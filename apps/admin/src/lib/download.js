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
  const reservations = new Set();

  function release(reservation, { closePopup = false } = {}) {
    if (!reservations.has(reservation)) return false;
    reservation.active = false;
    if (reservation.timer !== null) clearTimeout(reservation.timer);
    reservation.timer = null;
    if (reservation.url) URL.revokeObjectURL(reservation.url);
    reservation.url = "";
    reservations.delete(reservation);
    if (closePopup) {
      try { reservation.popup.close(); } catch { /* the popup may already be closed */ }
    }
    return true;
  }

  function isActive(reservation) {
    return Boolean(reservation?.active && reservations.has(reservation));
  }

  return {
    reserve() {
      const popup = window.open("", "_blank");
      if (!popup) return null;
      try {
        popup.opener = null;
        if (popup.opener !== null) throw new Error("unsafe preview window");
        if (!popup.location?.href) popup.location.href = "about:blank";
      } catch {
        try { popup.close(); } catch { /* best effort */ }
        return null;
      }
      const reservation = { popup, url: "", timer: null, active: true, state: "pending" };
      reservations.add(reservation);
      return reservation;
    },
    isActive,
    navigate(reservation, blob) {
      // Returning false leaves the blob with the caller. Once URL creation starts,
      // this reservation owns the URL/timer and close() releases them on failure.
      if (!isActive(reservation) || reservation.state !== "pending") return false;
      if (reservation.popup.closed) {
        release(reservation);
        return false;
      }
      reservation.state = "navigating";
      const url = URL.createObjectURL(blob);
      reservation.url = url;
      reservation.timer = setTimeout(() => release(reservation), PREVIEW_RELEASE_DELAY_MS);
      reservation.popup.location.href = url;
      reservation.state = "navigated";
      return true;
    },
    close(reservation) {
      release(reservation, { closePopup: true });
    },
    dispose() {
      for (const reservation of [...reservations]) {
        release(reservation, { closePopup: reservation.state === "pending" });
      }
    }
  };
}
