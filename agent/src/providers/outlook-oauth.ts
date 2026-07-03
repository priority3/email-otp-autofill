import { extractBestOtp } from "../otp/extract.js";
import type { OtpStore } from "../otp/store.js";
import { scopedKey } from "../http/auth.js";
import { proxyFetch } from "../http/proxy-fetch.js";
import { secretDelete, secretGet, secretSet } from "../storage/secrets.js";
import { getOutlookClientId } from "../storage/settings.js";

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
  ext_expires_in?: number;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
};

type OAuthErrorResponse = {
  error?: string;
  error_description?: string;
};

type GraphMessageBody = {
  contentType?: string;
  content?: string;
};

const DEVICE_CODE_SCOPE = "offline_access Mail.Read User.Read openid profile email";
const REFRESH_SCOPE = "offline_access Mail.Read";

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

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  const payload = String(token || "").split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function claimString(claims: Record<string, unknown> | null, key: string): string {
  const value = claims?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function graphBodyText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as GraphMessageBody;
  const content = String(b.content || "").trim();
  if (!content) return "";
  return String(b.contentType || "").toLowerCase() === "html" ? stripHtml(content) : content;
}

export class OutlookOAuthProvider {
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
    // Per-user refresh-token key so multi-tenant users don't share OAuth state.
    this.refreshKey = scopedKey(userId, "outlook_oauth:refresh");
    this.accountEmailKey = scopedKey(userId, "outlook_oauth:email");
  }

  // Instance-wide client ID set by the admin; shared by every user's sign-in.
  private get clientId(): string | null {
    return getOutlookClientId() || null;
  }

  status() {
    return {
      mode: "oauth" as const,
      configured: Boolean(this.clientId),
      connected: Boolean(this.clientId) && Boolean(this.getRefreshTokenSyncHint),
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

  // For status payload only; don't block on Keychain. (macOS security calls can be slow)
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
    if (!this.clientId) throw new Error("OUTLOOK_CLIENT_ID_NOT_SET");
    const url = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
    const body = formEncode({
      client_id: this.clientId,
      scope: DEVICE_CODE_SCOPE,
    });
    const res = await proxyFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
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
    if (!this.clientId) throw new Error("OUTLOOK_CLIENT_ID_NOT_SET");
    if (!this.deviceCode) throw new Error("DEVICE_CODE_NOT_STARTED");
    if (Date.now() > this.deviceCode.expiresAt) return { status: "expired" };

    const url = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
    const body = formEncode({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: this.clientId,
      device_code: this.deviceCode.value,
    });
    const res = await proxyFetch(url, {
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
    const email = await this.resolveAccountEmail(tok);
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
    if (!this.clientId) throw new Error("OUTLOOK_CLIENT_ID_NOT_SET");
    if (this.accessToken && Date.now() < this.accessToken.expiresAt - 30_000) return this.accessToken.value;

    const refresh = await secretGet(this.refreshKey);
    if (!refresh) throw new Error("OUTLOOK_NOT_CONNECTED");

    const url = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
    const body = formEncode({
      client_id: this.clientId,
      grant_type: "refresh_token",
      refresh_token: refresh,
      scope: REFRESH_SCOPE,
    });
    const res = await proxyFetch(url, {
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

  private async resolveAccountEmail(tok: TokenResponse): Promise<string | null> {
    const idClaims = decodeJwtPayload(tok.id_token);
    const accessClaims = decodeJwtPayload(tok.access_token);
    const fromClaims =
      claimString(idClaims, "email") ||
      claimString(idClaims, "preferred_username") ||
      claimString(idClaims, "upn") ||
      claimString(accessClaims, "email") ||
      claimString(accessClaims, "preferred_username") ||
      claimString(accessClaims, "upn");
    if (fromClaims) return fromClaims;

    try {
      const res = await proxyFetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
        headers: { authorization: `Bearer ${tok.access_token}` },
      });
      const json = (await res.json().catch(() => ({}))) as { mail?: string; userPrincipalName?: string };
      if (!res.ok) return null;
      return (json.mail || json.userPrincipalName || "").trim() || null;
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
      const url =
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=10&$orderby=receivedDateTime%20desc&$select=id,subject,from,receivedDateTime,bodyPreview,body";
      const res = await proxyFetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`graph_list_failed:${res.status}`);
      const json = (await res.json()) as { value?: any[] };
      const msgs = Array.isArray(json.value) ? json.value : [];
      const now = Date.now();
      for (const msg of msgs) {
        const id = String(msg.id || "");
        if (!id || this.seenIds.has(id)) continue;

        const receivedAt = msg.receivedDateTime ? Date.parse(String(msg.receivedDateTime)) : now;
        if (!Number.isFinite(receivedAt)) continue;
        if (now - receivedAt > 10 * 60 * 1000) continue; // only recent

        const subject = String(msg.subject || "");
        const from =
          msg.from?.emailAddress?.address || msg.from?.emailAddress?.name || (msg.from ? String(msg.from) : "");
        const preview = String(msg.bodyPreview || "");
        const bodyText = graphBodyText(msg.body);
        const best = extractBestOtp(`${subject}\n${preview}\n${bodyText}`);
        this.seenIds.add(id);
        if (this.seenIds.size > 200) this.seenIds = new Set([...this.seenIds].slice(-150));
        if (!best) continue;

        this.store.add({
          provider: "outlook",
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
