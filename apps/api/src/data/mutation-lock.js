const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createMutationLockMiddleware(store) {
  return async (req, res, next) => {
    if (!MUTATING_METHODS.has(req.method)) return next();
    let release;
    let released = false;
    const finish = async () => {
      if (released || !release) return;
      released = true;
      await release();
    };
    res.once("finish", () => { void finish(); });
    res.once("close", () => { void finish(); });
    try {
      release = await store.acquireMutationLock();
      if (res.destroyed || req.aborted) return finish();
      next();
    } catch (error) {
      await finish();
      next(error);
    }
  };
}
