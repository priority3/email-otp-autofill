import { extractBestOtp } from "../otp/extract.js";
import type { OtpStore } from "../otp/store.js";
import { scopedKey } from "../http/auth.js";
import { secretDelete, secretGet, secretSet } from "../storage/secrets.js";
import { getGoogleClientId, getGoogleClientSecret } from "../storage/settings.js";

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
  message?: string;
};

type TokenResponse = {
  token_type: string;
  scope: string;
  expires_in: number;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
};

type OAuthErrorResponse = {
  error?: string;
  error_description?: string;
};

type GmailMessagePart = {
  mimeType?: string;
  headers?: GmailMessageHeader[];
  body?: { data?: string };
  parts?: GmailMessagePart[];
};

type GmailMessage = {
  id?: string;
  payload?: GmailMessagePart;
  internalDate?: string;
};

type GmailMessageHeader = {
  name?: string;
  value?: string;
};

const DEVICE_CODE_SCOPE = "https://www.googleapis.com/auth/gmail.readonly openid email profile";
const REFRESH_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function formEncode(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function oauthError(label: string, status: number, json: unknown): string {
  const err = typeof (json as OAuthErrorResponse)?.error === "string" ? (json as OAuthErrorResponse).error : "";
  const desc =
    typeof (json as OAuthErrorResponse)?.error_description === "string"
      ? (json as OAuthErrorResponse).error_description
      : "";
  const detail = [err, desc].filter(Boolean).join(": ");
  return detail ? `${label}: ${status}: ${detail}` : `${label}: ${status}`;
}

function base64UrlDecode(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

function extractPlainText(payload: GmailMessagePart | undefined): string {
  if (!payload) return "";
  const parts: GmailMessagePart[] = [];
  const queue = [payload];
  while (queue.length) {
    const cur = queue.shift()!;
    parts.push(cur);
    if (cur.parts) queue.push(...cur.parts);
  }
  const texts: string[] = [];
  for (const p of parts) {
    const mime = (p.mimeType || "").toLowerCase();
    if (mime !== "text/plain" && mime !== "text/html") continue;
    const raw = p.body?.data ? base64UrlDecode(p.body.data) : "";
    if (!raw) continue;
    if (mime === "text/html") {
      texts.push(
        raw
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<[^>]+>/g, " ")
      );
    } else {
      texts.push(raw);
    }
  }
  return texts.join("\n");
}

function getHeader(headers: GmailMessageHeader[] | undefined, name: string): string {
  if (!headers) return "";
  const h = headers.find((h) => (h.name || "").toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

export class GmailOAuthProvider {
  private store: OtpStore;
  private userId: string;
  private refreshKey: string;
  private accountEmailKey: string;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;

  private accessToken: { value: string; expiresAt: number } | null = null;

  private lastError: string | null = null;
  private lastPollAt: number | null = null;
  private seenIds = new Set<string>();

  private deviceCode: { value: string; intervalSec: number; expiresAt: number } | null = null;

  constructor(store: OtpStore, userId: string = "local") {
    this.store = store;
    this.userId = userId;
    this.refreshKey = scopedKey(userId, "gmail_oauth:refresh");
    this.accountEmailKey = scopedKey(userId, "gmail_oauth:email");
  }

  // Instance-wide client ID/secret set by the admin.
  private get clientId(): string | null {
    return getGoogleClientId() || null;
  }

  private get clientSecret(): string | null {
    return getGoogleClientSecret() || null;
  }

  status() {
    return {
      mode: "oauth" as const,
      configured: Boolean(this.clientId) && Boolean(this.clientSecret),
      connected: Boolean(this.clientId) && Boolean(this.clientSecret) && Boolean(this.getRefreshTokenSyncHint),
      running: this.running,
      lastError: this.lastError,
      lastPollAt: this.lastPollAt,
    };
  }

  async hasRefreshToken(): Promise<boolean> {
    const rt = await secretGet(this.refreshKey);
    return Boolean(rt);
  }

  async getAccountEmail(): Promise<string | null> {
    return await secretGet(this.accountEmailKey);
  }

  private get getRefreshTokenSyncHint(): boolean {
    return true;
  }

  async clearAuth(): Promise<void> {
    await secretDelete(this.refreshKey);
    await secretDelete(this.accountEmailKey);
    this.accessToken = null;
    this.deviceCode = null;
  }

  async startDeviceCode(): Promise<DeviceCodeResponse> {
    if (!this.clientId) throw new Error("GOOGLE_CLIENT_ID_NOT_SET");
    if (!this.clientSecret) throw new Error("GOOGLE_CLIENT_SECRET_NOT_SET");
    const url = "https://oauth2.googleapis.com/device/code";
    const body = formEncode({
      client_id: this.clientId,
      scope: DEVICE_CODE_SCOPE,
    });
    const authHeader = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${authHeader}`,
      },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(oauthError("devicecode_failed", res.status, json));
    const dc = json as DeviceCodeResponse;
    this.deviceCode = {
      value: dc.device_code,
      intervalSec: Math.max(1, dc.interval || 5),
      expiresAt: Date.now() + dc.expires_in * 1000,
    };
    return dc;
  }

  async pollDeviceCodeOnce(): Promise<
    | { status: "pending"; error?: string }
    | { status: "success"; token: { expiresIn: number } }
    | { status: "expired" }
  > {
    if (!this.clientId) throw new Error("GOOGLE_CLIENT_ID_NOT_SET");
    if (!this.clientSecret) throw new Error("GOOGLE_CLIENT_SECRET_NOT_SET");
    if (!this.deviceCode) throw new Error("DEVICE_CODE_NOT_STARTED");
    if (Date.now() > this.deviceCode.expiresAt) return { status: "expired" };

    const url = "https://oauth2.googleapis.com/token";
    const body = formEncode({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      device_code: this.deviceCode.value,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = String((json as any).error || "authorization_pending");
      if (err === "authorization_pending" || err === "slow_down") return { status: "pending", error: err };
      if (err === "expired_token") return { status: "expired" };
      return { status: "pending", error: oauthError("devicecode_poll_failed", res.status, json) };
    }

    const tok = json as TokenResponse;
    if (tok.refresh_token) await secretSet(this.refreshKey, tok.refresh_token);
    this.accessToken = { value: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 };
    const email = await this.resolveAccountEmail(tok.access_token);
    if (email) await secretSet(this.accountEmailKey, email);
    this.deviceCode = null;
    return { status: "success", token: { expiresIn: tok.expires_in } };
  }

  startPolling(pollIntervalMs: number) {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => void this.pollOnce().catch(() => {}), pollIntervalMs);
    void this.pollOnce().catch(() => {});
  }

  stop() {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async ensureAccessToken(): Promise<string> {
    if (!this.clientId) throw new Error("GOOGLE_CLIENT_ID_NOT_SET");
    if (!this.clientSecret) throw new Error("GOOGLE_CLIENT_SECRET_NOT_SET");
    if (this.accessToken && Date.now() < this.accessToken.expiresAt - 30_000) return this.accessToken.value;

    const refresh = await secretGet(this.refreshKey);
    if (!refresh) throw new Error("GMAIL_NOT_CONNECTED");

    const url = "https://oauth2.googleapis.com/token";
    const body = formEncode({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refresh,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(oauthError("refresh_failed", res.status, json));
    }
    const tok = json as TokenResponse;
    if (tok.refresh_token) await secretSet(this.refreshKey, tok.refresh_token);
    this.accessToken = { value: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 };
    return tok.access_token;
  }

  private async resolveAccountEmail(accessToken: string): Promise<string | null> {
    try {
      const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const json = (await res.json().catch(() => ({}))) as { email?: string };
      if (!res.ok) return null;
      return (json.email || "").trim() || null;
    } catch {
      return null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.clientId) return;
    const has = await this.hasRefreshToken();
    if (!has) return;
    try {
      const token = await this.ensureAccessToken();

      // List recent messages (last 10 minutes)
      const listUrl =
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=10";
      const listRes = await fetch(listUrl, { headers: { authorization: `Bearer ${token}` } });
      if (!listRes.ok) throw new Error(`gmail_list_failed:${listRes.status}`);
      const listJson = (await listRes.json()) as { messages?: Array<{ id?: string }> };
      const messages = Array.isArray(listJson.messages) ? listJson.messages : [];
      const now = Date.now();

      for (const msgRef of messages) {
        const id = String(msgRef.id || "");
        if (!id || this.seenIds.has(id)) continue;

        // Fetch full message
        const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
        const msgRes = await fetch(msgUrl, { headers: { authorization: `Bearer ${token}` } });
        if (!msgRes.ok) continue;
        const msg = (await msgRes.json()) as GmailMessage;

        const internalDate = Number(msg.internalDate || 0);
        const receivedAt = Number.isFinite(internalDate) && internalDate > 0 ? internalDate : now;
        if (now - receivedAt > 10 * 60 * 1000) continue; // only recent

        const headers = msg.payload?.headers;
        const subject = getHeader(headers, "Subject");
        const from = getHeader(headers, "From");
        const bodyText = extractPlainText(msg.payload);
        const best = extractBestOtp(`${subject}\n${bodyText}`);
        this.seenIds.add(id);
        if (this.seenIds.size > 200) this.seenIds = new Set([...this.seenIds].slice(-150));
        if (!best) continue;

        this.store.add({
          provider: "gmail",
          userId: this.userId,
          code: best.code,
          receivedAt,
          ttlSec: best.ttlSec,
          from: from || undefined,
          subject: subject || undefined,
          messageId: id,
        });
      }
      this.lastError = null;
      this.lastPollAt = Date.now();
    } catch (e) {
      this.lastError = String((e as any)?.message || e);
    }
  }
}
