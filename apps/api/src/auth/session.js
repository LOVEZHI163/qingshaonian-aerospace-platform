import connectPgSimple from "connect-pg-simple";
import session from "express-session";

export function createSessionMiddleware({ env, dataStore }) {
  const secret = env.SESSION_SECRET || (env.NODE_ENV === "test" ? "test-session-secret-32-characters" : "");
  if (!secret) throw new Error("SESSION_SECRET is required");

  const PgStore = connectPgSimple(session);
  const store = dataStore.kind === "postgres"
    ? new PgStore({ pool: dataStore.pool, createTableIfMissing: true })
    : new session.MemoryStore();

  return session({
    name: "aerogp.sid",
    secret,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 8 * 60 * 60 * 1000
    }
  });
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "请先登录" });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "请先登录" });
  if (req.user.type !== "admin") return res.status(403).json({ error: "只有管理员可以执行此操作" });
  next();
}
