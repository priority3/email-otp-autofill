import crypto from "node:crypto";
import { proxyFetch } from "./proxy-fetch.js";

/*
 * Lightweight OIDC token verification for Google Pub/Sub Push notifications.
 *
 * Google pushes messages to our webhook with a Bearer JWT in the
 * Authorization header. This module verifies that JWT using Google's public
 * JWKS keys — no third-party JWT library required.
 */

// ── JWKS cache ──────────────────────────────────────────────────────────────

type Jwk = {
  kid: string;
  kty: string;
  alg: string;
  use?: string;
  n?: string;
  e?: string;
};

let cachedKeys: Jwk[] | null = null;
let cacheExpiresAt = 0;

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchJwks(): Promise<Jwk[]> {
  if (cachedKeys && Date.now() < cacheExpiresAt) return cachedKeys;
  const res = await proxyFetch(JWKS_URL);
  if (!res.ok) throw new Error(`jwks_fetch_failed:${res.status}`);
  const json = (await res.json()) as { keys: Jwk[] };
  cachedKeys = json.keys ?? [];
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedKeys;
}

// ── JWT helpers ─────────────────────────────────────────────────────────────

function base64UrlToBuffer(s: string): Buffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

function decodeJwtSegment(segment: string): Record<string, unknown> {
  const json = base64UrlToBuffer(segment).toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

type JwtHeader = { alg: string; kid: string; typ?: string };
type JwtPayload = {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  sub?: string;
  email?: string;
};

export type VerifiedToken = {
  header: JwtHeader;
  payload: JwtPayload;
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Verify a Google OIDC JWT token from Pub/Sub Push.
 *
 * @param token - The raw JWT string (without "Bearer " prefix)
 * @param expectedAudience - The expected `aud` claim (your agent's public URL)
 * @returns The verified header and payload
 * @throws If verification fails for any reason
 */
export async function verifyGoogleOidcToken(
  token: string,
  expectedAudience: string,
): Promise<VerifiedToken> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_jwt_format");

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeJwtSegment(headerB64!) as JwtHeader;
  const payload = decodeJwtSegment(payloadB64!) as JwtPayload;

  // ── basic claims validation ─────────────────────────────────────────────
  if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") {
    throw new Error(`invalid_issuer:${payload.iss}`);
  }

  if (payload.aud !== expectedAudience) {
    throw new Error(`invalid_audience:${payload.aud}`);
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now - 60) {
    throw new Error("token_expired");
  }

  // ── signature verification ──────────────────────────────────────────────
  if (header.alg !== "RS256") {
    throw new Error(`unsupported_alg:${header.alg}`);
  }

  const keys = await fetchJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error(`kid_not_found:${header.kid}`);

  const publicKey = crypto.createPublicKey({
    key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
    format: "jwk",
  });

  const verify = crypto.createVerify("RSA-SHA256");
  verify.update(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToBuffer(signatureB64!);

  if (!verify.verify(publicKey, signature)) {
    throw new Error("signature_invalid");
  }

  return { header, payload };
}

/**
 * Extract Bearer token from an Authorization header value.
 * Returns null if the header is missing or not a Bearer token.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1]!.trim() : null;
}
