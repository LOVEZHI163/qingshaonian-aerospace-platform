import connectPgSimple from "connect-pg-simple";
import session from "express-session";

const MUTATION_AUTHORIZATION = Symbol("mutationAuthorization");

function markMutationAuthorization(req, requirement) {
  const current = req[MUTATION_AUTHORIZATION] || {};
  req[MUTATION_AUTHORIZATION] = { ...current, [requirement]: true };
}

function authorizationError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

export async function revalidateMutationAuthorization(store, req) {
  const requirements = req[MUTATION_AUTHORIZATION];
  if (!requirements) return;

  const db = await store.readDb();
  const sessionUserId = req.session?.userId ?? req.user?.id;
  const sessionVersion = req.session?.sessionVersion ?? req.user?.sessionVersion;
  const user = db.users.find((row) => row.id === sessionUserId && row.status === "active");
  if (!user || sessionVersion === undefined || user.sessionVersion !== sessionVersion) {
    throw authorizationError(401, "登录状态已失效，请重新登录", "SESSION_INVALIDATED");
  }
  if (requirements.admin && user.type !== "admin") {
    throw authorizationError(403, "只有管理员可以执行此操作", "ADMIN_REQUIRED");
  }
  if (requirements.passwordReady && user.mustChangePassword) {
    throw authorizationError(428, "请先修改临时密码", "PASSWORD_CHANGE_REQUIRED");
  }
  req.user = user;
}

export function requireSessionSecret(env) {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required");
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("SESSION_SECRET must be at least 32 bytes");
  return secret;
}

export function createSessionMiddleware({ env, dataStore, secret = requireSessionSecret(env) }) {
  const PgStore = connectPgSimple(session);
  const store = dataStore.kind === "postgres"
    ? new PgStore({ pool: dataStore.pool, createTableIfMissing: true })
    : new session.MemoryStore();

  return session({
    name: "aerogp.sid",
    secret,
    store,
    proxy: true,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",
      maxAge: 8 * 60 * 60 * 1000
    }
  });
}

export const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "请先登录" });
  markMutationAuthorization(req, "user");
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "请先登录" });
  if (req.user.type !== "admin") return res.status(403).json({ error: "只有管理员可以执行此操作" });
  markMutationAuthorization(req, "user");
  markMutationAuthorization(req, "admin");
  next();
}

export function requirePasswordReady(req, res, next) {
  if (req.user?.mustChangePassword) {
    return res.status(428).json({
      error: "请先修改临时密码",
      code: "PASSWORD_CHANGE_REQUIRED"
    });
  }
  markMutationAuthorization(req, "passwordReady");
  next();
}
