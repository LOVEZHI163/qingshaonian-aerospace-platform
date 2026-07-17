const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createMutationAsyncRoute(store) {
  return (handler) => (req, res, next) => {
    const execute = () => Promise.resolve(handler(req, res, next));
    if (!MUTATING_METHODS.has(req.method)) return execute().catch(next);

    let onClose;
    const closed = new Promise((resolve) => {
      onClose = () => resolve({ closed: true });
      res.once("close", onClose);
    });

    return store.withMutationLock(async () => {
      if (res.destroyed || req.aborted) return;
      const handled = execute().then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      const outcome = await Promise.race([handled, closed]);
      res.off("close", onClose);
      if (outcome.error) throw outcome.error;
      return outcome.value;
    }).catch((error) => {
      res.off("close", onClose);
      next(error);
    });
  };
}
