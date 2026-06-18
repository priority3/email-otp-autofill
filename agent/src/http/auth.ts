import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

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
  next();
}
