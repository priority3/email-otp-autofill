import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { ADMIN_TOKEN } from "../constants.js";
import { db } from "../storage/db.js";

/*
 * Minimal session auth for multi-tenant mode. Opaque bearer tokens are kept in
 * memory (re-login after a restart) — no JWT secret to manage. Tokens are sent
 * as `Authorization: Bearer <token>`.
 *
 * Single-tenant (self-hosted) mode does NOT use any of this; requests run as
 * the implicit "local" user.
 */

export const LOCAL_USER_ID = "local";

// Namespace a storage key by user. The "local" user keeps un-prefixed keys so
// existing single-tenant secrets (e.g. "qq:foo@qq.com") stay valid; other users
// get a "<userId>:" prefix for isolation.
export function scopedKey(userId: string, base: string): string {
  return userId === LOCAL_USER_ID ? base : `${userId}:${base}`;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type Session = { userId: string; expiresAt: number };
const sessions = new Map<string, Session>();

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function resolveSession(token: string): string | null {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return s.userId;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

function bearerToken(req: Request): string | null {
  const h = req.headers.authorization || req.headers.Authorization;
  const value = Array.isArray(h) ? h[0] : h;
  if (!value) return null;
  const m = /^Bearer\s+(.+)$/i.exec(String(value));
  return m ? m[1]!.trim() : null;
}

// Express augmentation: handlers read req.userId after requireAuth.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

// Require a valid session; attaches req.userId. Used only in multi-tenant mode.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const userId = resolveSession(token);
  if (!userId) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  req.userId = userId;
  touchLastSeen(userId);
  next();
}

// Update users.last_seen, throttled to avoid a write on every request.
const lastSeenCache = new Map<string, number>();
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;
function touchLastSeen(userId: string): void {
  const now = Date.now();
  const prev = lastSeenCache.get(userId) || 0;
  if (now - prev < LAST_SEEN_THROTTLE_MS) return;
  lastSeenCache.set(userId, now);
  try {
    db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(now, userId);
  } catch {
    // best-effort; never block the request on stats
  }
}

// Require the admin token (env OTP_ADMIN_TOKEN) for the /v1/admin/* surface.
// Disabled entirely (401) when no token is configured.
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: "admin_disabled" });
    return;
  }
  const token = bearerToken(req) || "";
  const a = Buffer.from(token);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  next();
}
