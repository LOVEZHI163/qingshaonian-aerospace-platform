import { revalidateMutationAuthorization } from "../auth/session.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createLockedAsyncRoute(store, { revalidateAuthorization = revalidateMutationAuthorization } = {}) {
  return (handler) => (req, res, next) => {
    return store.withMutationLock(async () => {
      if (res.destroyed || req.aborted) return;
      await revalidateAuthorization(store, req);
      return Promise.resolve(handler(req, res, next));
    }).catch((error) => {
      next(error);
    });
  };
}

export function createMutationAsyncRoute(store, options = {}) {
  const lockedAsyncRoute = createLockedAsyncRoute(store, options);
  return (handler) => {
    const lockedHandler = lockedAsyncRoute(handler);
    return (req, res, next) => {
      if (MUTATING_METHODS.has(req.method)) return lockedHandler(req, res, next);
      return Promise.resolve(handler(req, res, next)).catch(next);
    };
  };
}
