import { extractBestOtp } from "../otp/extract.js";
import type { OtpStore } from "../otp/store.js";
import { secretDelete, secretGet, secretSet } from "../storage/secrets.js";

const KC_OUTLOOK_REFRESH = "outlook_oauth:refresh";

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

function formEncode(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export class OutlookOAuthProvider {
  private store: OtpStore;
  private clientId: string | null = null;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;

  private accessToken: { value: string; expiresAt: number } | null = null;

  private lastError: string | null = null;
  private lastPollAt: number | null = null;
  private seenIds = new Set<string>();

  private deviceCode: { value: string; intervalSec: number; expiresAt: number } | null = null;

  constructor(store: OtpStore) {
    this.store = store;
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

  setClientId(clientId: string | null) {
    this.clientId = clientId;
  }

  async hasRefreshToken(): Promise<boolean> {
    const rt = await secretGet(KC_OUTLOOK_REFRESH);
    return Boolean(rt);
  }

  // For status payload only; don't block on Keychain. (macOS security calls can be slow)
  private get getRefreshTokenSyncHint(): boolean {
    return true;
  }

  async clearAuth(): Promise<void> {
    await secretDelete(KC_OUTLOOK_REFRESH);
    this.accessToken = null;
    this.deviceCode = null;
  }

  async startDeviceCode(): Promise<DeviceCodeResponse> {
    if (!this.clientId) throw new Error("OUTLOOK_CLIENT_ID_NOT_SET");
    const url = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
    const body = formEncode({
      client_id: this.clientId,
      scope: "offline_access Mail.Read",
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`devicecode_failed: ${res.status}`);
    const dc = (await res.json()) as DeviceCodeResponse;
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
      return { status: "pending", error: err };
    }

    const tok = json as TokenResponse;
    if (tok.refresh_token) await secretSet(KC_OUTLOOK_REFRESH, tok.refresh_token);
    this.accessToken = { value: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 };
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

    const refresh = await secretGet(KC_OUTLOOK_REFRESH);
    if (!refresh) throw new Error("OUTLOOK_NOT_CONNECTED");

    const url = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
    const body = formEncode({
      client_id: this.clientId,
      grant_type: "refresh_token",
      refresh_token: refresh,
      scope: "offline_access Mail.Read",
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`refresh_failed:${res.status}:${String((json as any).error || "")}`);
    }
    const tok = json as TokenResponse;
    if (tok.refresh_token) await secretSet(KC_OUTLOOK_REFRESH, tok.refresh_token);
    this.accessToken = { value: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 };
    return tok.access_token;
  }

  private async pollOnce(): Promise<void> {
    if (!this.clientId) return;
    const has = await this.hasRefreshToken();
    if (!has) return;
    try {
      const token = await this.ensureAccessToken();
      const url =
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=10&$orderby=receivedDateTime%20desc&$select=id,subject,from,receivedDateTime,bodyPreview";
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`graph_list_failed:${res.status}`);
      const json = (await res.json()) as { value?: any[] };
      const msgs = Array.isArray(json.value) ? json.value : [];
      const now = Date.now();
      for (const msg of msgs) {
        const id = String(msg.id || "");
        if (!id || this.seenIds.has(id)) continue;
        this.seenIds.add(id);
        if (this.seenIds.size > 200) this.seenIds = new Set([...this.seenIds].slice(-150));

        const receivedAt = msg.receivedDateTime ? Date.parse(String(msg.receivedDateTime)) : now;
        if (!Number.isFinite(receivedAt)) continue;
        if (now - receivedAt > 10 * 60 * 1000) continue; // only recent

        const subject = String(msg.subject || "");
        const from =
          msg.from?.emailAddress?.address || msg.from?.emailAddress?.name || (msg.from ? String(msg.from) : "");
        const preview = String(msg.bodyPreview || "");
        const best = extractBestOtp(`${subject}\n${preview}`);
        if (!best) continue;

        this.store.add({
          provider: "outlook",
          code: best.code,
          receivedAt,
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
