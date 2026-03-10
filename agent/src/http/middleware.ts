import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { API_KEY, API_KEY_HEADER_NAME, CLIENT_HEADER_NAME, CLIENT_HEADER_VALUE } from "../constants.js";

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (origin.startsWith("chrome-extension://")) return true;
  // For local dev/testing only.
  if (origin.startsWith("http://localhost")) return true;
  if (origin.startsWith("http://127.0.0.1")) return true;
  return false;
}

export function cors(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (typeof origin === "string" && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "false");
    res.setHeader(
      "Access-Control-Allow-Headers",
      `Content-Type, ${CLIENT_HEADER_NAME}, ${API_KEY_HEADER_NAME}`,
    );
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export function noStore(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  next();
}

export function requireClientHeader(req: Request, res: Response, next: NextFunction) {
  // Allow health checks without the header.
  if (req.path === "/v1/status") return next();

  const v = req.headers[CLIENT_HEADER_NAME] ?? req.headers[CLIENT_HEADER_NAME.toLowerCase()];
  const value = Array.isArray(v) ? v[0] : v;
  if (String(value || "") !== CLIENT_HEADER_VALUE) {
    res.status(403).json({ ok: false, error: "forbidden" });
    return;
  }
  next();
}

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) return next();

  const v = req.headers[API_KEY_HEADER_NAME] ?? req.headers[API_KEY_HEADER_NAME.toLowerCase()];
  const value = Array.isArray(v) ? v[0] : v;

  const provided = String(value || "");
  if (!provided) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  // Constant-time compare.
  const a = Buffer.from(API_KEY);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  next();
}
