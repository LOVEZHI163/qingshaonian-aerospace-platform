const RELEASE_DELAY_MS = 1_000;

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
      link.download = fileName;
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
