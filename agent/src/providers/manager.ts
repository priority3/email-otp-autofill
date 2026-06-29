import { ImapOtpWatcher } from "./imap.js";
import { OutlookOAuthProvider } from "./outlook-oauth.js";
import type { OtpStore } from "../otp/store.js";
import type { AppConfig } from "../storage/config.js";
import { loadConfig, saveConfig } from "../storage/config.js";
import { secretDelete, secretGet } from "../storage/secrets.js";
import { LOCAL_USER_ID, scopedKey } from "../http/auth.js";

type Watcher = { watcher: ImapOtpWatcher; task: Promise<void> };

export class ProviderManager {
  private store: OtpStore;
  private userId: string;
  config: AppConfig;

  // Multi-account: one IMAP watcher per mailbox, keyed by email.
  private qq = new Map<string, Watcher>();
  private outlookImap = new Map<string, Watcher>();
  private outlookOAuth: OutlookOAuthProvider; // single-account per user

  constructor(store: OtpStore, config: AppConfig, userId: string = LOCAL_USER_ID) {
    this.store = store;
    this.userId = userId;
    this.config = config;
    this.outlookOAuth = new OutlookOAuthProvider(store, userId);
  }

  private kcQq(email: string) {
    return scopedKey(this.userId, `qq:${email}`);
  }
  private kcOutlookImap(email: string) {
    return scopedKey(this.userId, `outlook_imap:${email}`);
  }

  static async create(store: OtpStore, userId: string = LOCAL_USER_ID): Promise<ProviderManager> {
    const cfg = await loadConfig(userId);
    return new ProviderManager(store, cfg, userId);
  }

  getOutlookOAuth() {
    return this.outlookOAuth;
  }

  async reloadConfig(): Promise<void> {
    this.config = await loadConfig(this.userId);
    await this.reconcile();
  }

  async updateConfig(mut: (cfg: AppConfig) => void): Promise<void> {
    const cfg = await loadConfig(this.userId);
    mut(cfg);
    await saveConfig(cfg, this.userId);
    await this.reloadConfig();
  }

  async reconcile(): Promise<void> {
    await this.reconcileQq();
    await this.reconcileOutlook();
    // OAuth poller is cheap; it exits early if not connected.
    if (this.config.outlook.mode === "oauth") {
      this.outlookOAuth.startPolling(this.config.pollIntervalMs);
    } else {
      this.outlookOAuth.stop();
    }
  }

  // Stop all watchers for this user (used when removing a user / shutting down).
  stopAll(): void {
    for (const [, w] of this.qq) w.watcher.stop();
    for (const [, w] of this.outlookImap) w.watcher.stop();
    this.qq.clear();
    this.outlookImap.clear();
    this.outlookOAuth.stop();
  }

  // Diff the configured QQ accounts against running watchers: stop removed ones,
  // start newly-added ones (only when their secret is present), keep the rest.
  private async reconcileQq(): Promise<void> {
    const wanted = new Set(this.config.qq.accounts.map((a) => a.email));

    for (const [email, w] of this.qq) {
      if (!wanted.has(email)) {
        w.watcher.stop();
        this.qq.delete(email);
      }
    }

    for (const { email } of this.config.qq.accounts) {
      if (this.qq.has(email)) continue;
      const pass = await secretGet(this.kcQq(email));
      if (!pass) continue; // configured but no secret yet — skip until set
      const watcher = new ImapOtpWatcher({
        providerId: "qq",
        userId: this.userId,
        host: "imap.qq.com",
        port: 993,
        secure: true,
        auth: { user: email, pass },
        store: this.store,
        pollIntervalMs: this.config.pollIntervalMs,
      });
      // Reason: a bad credential makes start() reject; swallow it so one broken
      // account never crashes the agent (critical in multi-tenant).
      const task = watcher.start().catch((e) => {
        console.error(`[otp-agent] qq watcher failed for ${email}: ${String((e as any)?.message || e)}`);
      });
      this.qq.set(email, { watcher, task });
    }
  }

  private async reconcileOutlook(): Promise<void> {
    // OAuth mode: no IMAP watchers should run.
    if (this.config.outlook.mode !== "imap") {
      for (const [email, w] of this.outlookImap) {
        w.watcher.stop();
        this.outlookImap.delete(email);
      }
      return;
    }

    // IMAP mode: keep the OAuth poller stopped, diff the IMAP accounts.
    this.outlookOAuth.stop();
    const wanted = new Set(this.config.outlook.imapAccounts.map((a) => a.email));

    for (const [email, w] of this.outlookImap) {
      if (!wanted.has(email)) {
        w.watcher.stop();
        this.outlookImap.delete(email);
      }
    }

    for (const { email } of this.config.outlook.imapAccounts) {
      if (this.outlookImap.has(email)) continue;
      const pass = await secretGet(this.kcOutlookImap(email));
      if (!pass) continue;
      const watcher = new ImapOtpWatcher({
        providerId: "outlook",
        userId: this.userId,
        host: "imap-mail.outlook.com",
        port: 993,
        secure: true,
        auth: { user: email, pass },
        store: this.store,
        pollIntervalMs: this.config.pollIntervalMs,
      });
      const task = watcher.start().catch((e) => {
        console.error(`[otp-agent] outlook watcher failed for ${email}: ${String((e as any)?.message || e)}`);
      });
      this.outlookImap.set(email, { watcher, task });
    }
  }

  // --- account add/remove -------------------------------------------------

  async addQqAccount(email: string): Promise<void> {
    await this.updateConfig((c) => {
      if (!c.qq.accounts.some((a) => a.email === email)) c.qq.accounts.push({ email });
    });
  }

  async removeQqAccount(email: string): Promise<void> {
    await secretDelete(this.kcQq(email));
    await this.updateConfig((c) => {
      c.qq.accounts = c.qq.accounts.filter((a) => a.email !== email);
    });
  }

  async addOutlookImapAccount(email: string): Promise<void> {
    await this.updateConfig((c) => {
      c.outlook.mode = "imap";
      if (!c.outlook.imapAccounts.some((a) => a.email === email)) {
        c.outlook.imapAccounts.push({ email });
      }
    });
  }

  async removeOutlookImapAccount(email: string): Promise<void> {
    await secretDelete(this.kcOutlookImap(email));
    await this.updateConfig((c) => {
      c.outlook.imapAccounts = c.outlook.imapAccounts.filter((a) => a.email !== email);
    });
  }

  async clearQq(): Promise<void> {
    for (const { email } of this.config.qq.accounts) await secretDelete(this.kcQq(email));
    await this.updateConfig((c) => {
      c.qq.accounts = [];
    });
  }

  async clearOutlookImap(): Promise<void> {
    for (const { email } of this.config.outlook.imapAccounts) await secretDelete(this.kcOutlookImap(email));
    await this.updateConfig((c) => {
      c.outlook.imapAccounts = [];
    });
  }

  // Expose the scoped secret key for a kind+email so the HTTP layer can read it.
  secretKeyFor(kind: "qq" | "outlook_imap", email: string): string {
    return kind === "qq" ? this.kcQq(email) : this.kcOutlookImap(email);
  }
}

// Registry of per-user ProviderManagers over a shared OtpStore (items are
// tagged by userId). Single-tenant mode uses just the "local" manager.
export class ProviderRegistry {
  private store: OtpStore;
  private managers = new Map<string, ProviderManager>();

  constructor(store: OtpStore) {
    this.store = store;
  }

  async getOrCreate(userId: string): Promise<ProviderManager> {
    const existing = this.managers.get(userId);
    if (existing) return existing;
    const mgr = await ProviderManager.create(this.store, userId);
    this.managers.set(userId, mgr);
    await mgr.reconcile();
    return mgr;
  }

  get(userId: string): ProviderManager | undefined {
    return this.managers.get(userId);
  }

  // Boot watchers for a set of users (e.g. all registered users on startup).
  async bootstrap(userIds: string[]): Promise<void> {
    for (const userId of userIds) {
      await this.getOrCreate(userId);
    }
  }

  async removeUser(userId: string): Promise<void> {
    const mgr = this.managers.get(userId);
    if (mgr) {
      mgr.stopAll();
      this.managers.delete(userId);
    }
  }
}
