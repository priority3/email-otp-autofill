import { extractBestOtp } from "../otp/extract.js";
import type { OtpStore } from "../otp/store.js";
import { scopedKey } from "../http/auth.js";
import { proxyFetch } from "../http/proxy-fetch.js";
import { secretDelete, secretGet, secretSet } from "../storage/secrets.js";

// Cloudflare Temp Email provider — polls /api/parsed_mails with the user's
// Address JWT. No extra processes needed; the CF Worker parses server-side.
//
// Secrets per account (scoped to the user):
//   cfmail:${email}:jwt       — Address JWT (copied from the frontend UI)
//   cfmail:${email}:sitepwd   — optional site password (x-custom-auth header)
// The email + baseUrl pair lives in the user config (AppConfig.cfmail).

type ParsedMail = {
  id: number;
  message_id?: string;
  source?: string;
  to?: string;
  created_at?: string;
  sender?: string;
  subject?: string;
  text?: string;
  html?: string;
};

type ParsedMailsResponse = { results: ParsedMail[]; count: number };
type SettingsResponse = { address?: string };

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ");
}

export class CfMailProvider {
  private store: OtpStore;
  private userId: string;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private lastPollAt: number | null = null;
  private seenIds = new Set<string>();
  private pollIntervalMs = 5000;
  private accounts: { email: string; baseUrl: string }[] = [];

  constructor(store: OtpStore, userId: string = "local") {
    this.store = store;
    this.userId = userId;
  }

  private jwtKey(email: string) {
    return scopedKey(this.userId, `cfmail:${email}:jwt`);
  }

  private sitePwdKey(email: string) {
    return scopedKey(this.userId, `cfmail:${email}:sitepwd`);
  }

  secretKeyFor(email: string, kind: "jwt" | "sitepwd"): string {
    return kind === "jwt" ? this.jwtKey(email) : this.sitePwdKey(email);
  }

  async hasJwt(email: string): Promise<boolean> {
    return Boolean(await secretGet(this.jwtKey(email)));
  }

  async getAccountEmail(baseUrl: string, email: string): Promise<string | null> {
    const jwt = await secretGet(this.jwtKey(email));
    if (!jwt) return null;
    const sitePwd = await secretGet(this.sitePwdKey(email));
    try {
      const res = await this.apiCall(baseUrl, jwt, sitePwd, "/api/settings");
      if (!res.ok) return null;
      const json = (await res.json().catch(() => ({}))) as SettingsResponse;
      return json.address || email;
    } catch {
      return email;
    }
  }

  async clearAuth(email: string): Promise<void> {
    await secretDelete(this.jwtKey(email));
    await secretDelete(this.sitePwdKey(email));
  }

  async setJwt(email: string, jwt: string): Promise<void> {
    await secretSet(this.jwtKey(email), jwt);
  }

  async setSitePassword(email: string, password: string): Promise<void> {
    if (password) {
      await secretSet(this.sitePwdKey(email), password);
    } else {
      await secretDelete(this.sitePwdKey(email));
    }
  }

  async verifyJwt(
    baseUrl: string,
    jwt: string,
    sitePassword: string
  ): Promise<{ ok: true; address: string } | { ok: false; error: string }> {
    try {
      const res = await this.apiCallRaw(baseUrl, jwt, sitePassword, "/api/settings");
      if (res.status === 401) {
        const body = await res.text().catch(() => "");
        if (/customauth/i.test(body)) return { ok: false, error: "site_password_required" };
        return { ok: false, error: "auth_failed" };
      }
      if (!res.ok) return { ok: false, error: "verify_failed" };
      const json = (await res.json().catch(() => ({}))) as SettingsResponse;
      return { ok: true, address: json.address || "" };
    } catch (e) {
      const msg = String((e as any)?.message || e).toLowerCase();
      if (/(timeout|timed out)/.test(msg)) return { ok: false, error: "connect_timeout" };
      if (/(econn|enotfound|getaddrinfo|network|socket|refused|reset)/.test(msg))
        return { ok: false, error: "network_error" };
      return { ok: false, error: "verify_failed" };
    }
  }

  private async apiCall(
    baseUrl: string,
    jwt: string,
    sitePwd: string | null,
    path: string,
    init?: RequestInit
  ): Promise<Response> {
    return this.apiCallRaw(baseUrl, jwt, sitePwd, path, init);
  }

  private async apiCallRaw(
    baseUrl: string,
    jwt: string,
    sitePwd: string | null,
    path: string,
    init?: RequestInit
  ): Promise<Response> {
    const url = baseUrl.replace(/\/+$/, "") + path;
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${jwt}`);
    if (sitePwd) headers.set("x-custom-auth", sitePwd);
    headers.set("content-type", "application/json");
    return proxyFetch(url, { ...init, headers });
  }

  startPolling(pollIntervalMs: number) {
    this.pollIntervalMs = pollIntervalMs;
    if (this.running) {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = setInterval(
        () => void this.pollOnce().catch(() => {}),
        this.pollIntervalMs
      );
      return;
    }
    this.running = true;
    this.pollTimer = setInterval(
      () => void this.pollOnce().catch(() => {}),
      this.pollIntervalMs
    );
    void this.pollOnce().catch(() => {});
  }

  stop() {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  status() {
    return {
      running: this.running,
      lastError: this.lastError,
      lastPollAt: this.lastPollAt,
    };
  }

  setAccounts(accounts: { email: string; baseUrl: string }[]) {
    this.accounts = accounts;
  }

  private async pollOnce(): Promise<void> {
    if (!this.accounts || this.accounts.length === 0) return;

    for (const acct of this.accounts) {
      const jwt = await secretGet(this.jwtKey(acct.email));
      if (!jwt) continue;
      const sitePwd = await secretGet(this.sitePwdKey(acct.email));
      try {
        const res = await this.apiCall(
          acct.baseUrl,
          jwt,
          sitePwd,
          "/api/parsed_mails?limit=10&offset=0"
        );
        if (!res.ok) {
          if (res.status === 401) {
            this.lastError = `cfmail: jwt expired for ${acct.email}`;
          } else {
            this.lastError = `cfmail: list failed ${res.status} for ${acct.email}`;
          }
          continue;
        }
        const json = (await res.json().catch(() => ({}))) as ParsedMailsResponse;
        const msgs = Array.isArray(json.results) ? json.results : [];
        const now = Date.now();
        for (const msg of msgs) {
          const seenKey = `${acct.email}:${msg.id}`;
          if (this.seenIds.has(seenKey)) continue;
          this.seenIds.add(seenKey);
          if (this.seenIds.size > 500) this.seenIds = new Set([...this.seenIds].slice(-400));

          // created_at from D1 is "2026-04-21 10:00:00" (UTC). Normalize to ISO.
          const receivedAt = msg.created_at
            ? Date.parse(msg.created_at.replace(" ", "T") + "Z")
            : now;
          const received = Number.isFinite(receivedAt) ? receivedAt : now;
          if (now - received > 10 * 60 * 1000) continue;

          const subject = String(msg.subject || "");
          const text = String(msg.text || "");
          const html = msg.html ? stripHtml(String(msg.html)) : "";
          const raw = `${subject}\n${text}\n${html}`;
          const best = extractBestOtp(raw);
          if (!best) continue;

          this.store.add({
            provider: "cfmail",
            userId: this.userId,
            account: acct.email,
            code: best.code,
            receivedAt: received,
            ttlSec: best.ttlSec,
            from: msg.sender || msg.source || undefined,
            subject: subject || undefined,
            messageId: seenKey,
            folder: "INBOX",
          });
        }
        this.lastError = null;
        this.lastPollAt = Date.now();
      } catch (e) {
        this.lastError = `cfmail: ${String((e as any)?.message || e)}`;
      }
    }
  }
}
