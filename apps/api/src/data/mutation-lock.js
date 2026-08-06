import { revalidateMutationAuthorization } from "../auth/session.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createMutationAsyncRoute(store, { revalidateAuthorization = revalidateMutationAuthorization } = {}) {
  return (handler) => (req, res, next) => {
    const execute = () => Promise.resolve(handler(req, res, next));
    if (!MUTATING_METHODS.has(req.method)) return execute().catch(next);

    return store.withMutationLock(async () => {
      if (res.destroyed || req.aborted) return;
      await revalidateAuthorization(store, req);
      return execute();
    }).catch((error) => {
      next(error);
    });
  };
}
