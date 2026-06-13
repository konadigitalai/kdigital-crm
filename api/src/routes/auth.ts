// /auth/login, /auth/logout, /auth/me — public endpoints (login/logout) plus
// the authenticated "who am I" lookup. Login is rate-limited by a small
// in-memory window (good enough for now; replace with redis later).

import { Router } from "express";
import { appPool } from "../db/app.js";
import { verifyPassword } from "../lib/passwords.js";
import { createSession, revokeSession } from "../lib/sessions.js";
import { SESSION_COOKIE_NAME } from "../middleware/auth.js";

export const authRouter = Router();

const isProd = process.env.NODE_ENV === "production";

// In prod the API and the web are on different origins (Vercel ↔ Render), so
// the session cookie has to be `SameSite=None; Secure` for the browser to
// send it on credentialed cross-site requests. Locally we keep `lax` so the
// cookie still works over plain http://localhost.
const cookieOptions = {
  httpOnly: true,
  sameSite: (isProd ? "none" : "lax") as "none" | "lax",
  secure: isProd,
  path: "/",
};

// crude per-IP login rate limiter: max 8 attempts per 5 minutes.
const attempts = new Map<string, { count: number; resetAt: number }>();
function checkRate(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 5 * 60_000 });
    return true;
  }
  rec.count += 1;
  return rec.count <= 8;
}

authRouter.post("/login", async (req, res, next) => {
  try {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip ?? "unknown";
    if (!checkRate(ip)) {
      return res.status(429).json({ error: "Too many login attempts. Try again in a few minutes." });
    }

    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const r = await appPool.query<{
      id: string;
      tenant_id: string;
      email: string;
      name: string | null;
      role: string;
      active: boolean;
      password_hash: string | null;
    }>(
      `SELECT id, tenant_id, email, name, role, active, password_hash
       FROM app_user
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [email],
    );
    const user = r.rows[0];

    // Constant-ish responses to avoid leaking which arm failed.
    if (!user || !user.active || !user.password_hash) {
      // Burn a hash compare to keep timing roughly constant.
      await verifyPassword(password, "$2a$12$0000000000000000000000.0000000000000000000000000000000");
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const { token, expiresAt } = await createSession(user.tenant_id, user.id);
    res.cookie(SESSION_COOKIE_NAME, token, {
      ...cookieOptions,
      expires: expiresAt,
    });
    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    const token = (req.cookies?.[SESSION_COOKIE_NAME] as string | undefined) ?? "";
    if (token) await revokeSession(token);
    res.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
