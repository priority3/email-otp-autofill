import { ImapOtpWatcher } from "./imap.js";
import { OutlookOAuthProvider } from "./outlook-oauth.js";
import { GmailOAuthProvider } from "./gmail-oauth.js";
import type { OtpStore } from "../otp/store.js";
import type { AppConfig } from "../storage/config.js";
import { loadConfig, saveConfig } from "../storage/config.js";
import { secretDelete, secretGet } from "../storage/secrets.js";
import { LOCAL_USER_ID, scopedKey } from "../http/auth.js";

type Watcher = {
  watcher: ImapOtpWatcher;
  includeSpam: boolean;
  pollIntervalMs: number;
  // False once start() settles. A dead entry stays in the map so reconcile can
  // tell "configured but down" from "not configured".
  alive: boolean;
  // Consecutive failed starts, drives the restart backoff.
  attempt: number;
  lastError: string | null;
  retryTimer: NodeJS.Timeout | null;
};

// Restart backoff for a watcher whose start() rejected: 5s, 10s, 20s, 40s, then
// capped at 60s. A watcher that stayed up longer than RESET_AFTER_MS is treated
// as healthy and starts the next failure from zero.
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const RESET_AFTER_MS = 60_000;

// Exported for tests — the curve is easy to get subtly wrong (off-by-one on the
// first attempt, or a cap that never bites).
export function retryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
}

export class ProviderManager {
  private store: OtpStore;
  private userId: string;
  config: AppConfig;

  // Multi-account: one IMAP watcher per mailbox, keyed by email.
  private qq = new Map<string, Watcher>();
  private outlookOAuth: OutlookOAuthProvider; // single-account per user
  private gmailOAuth: GmailOAuthProvider; // single-account per user

  constructor(store: OtpStore, config: AppConfig, userId: string = LOCAL_USER_ID) {
    this.store = store;
    this.userId = userId;
    this.config = config;
    this.outlookOAuth = new OutlookOAuthProvider(store, userId);
    this.gmailOAuth = new GmailOAuthProvider(store, userId);
  }

  private kcQq(email: string) {
    return scopedKey(this.userId, `qq:${email}`);
  }

  static async create(store: OtpStore, userId: string = LOCAL_USER_ID): Promise<ProviderManager> {
    const cfg = await loadConfig(userId);
    return new ProviderManager(store, cfg, userId);
  }

  getOutlookOAuth() {
    return this.outlookOAuth;
  }

  getGmailOAuth() {
    return this.gmailOAuth;
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
    // OAuth pollers are cheap; they exit early if not connected.
    this.outlookOAuth.startPolling(this.config.pollIntervalMs, this.config.includeSpam);

    // Gmail: prefer Pub/Sub push, fall back to polling.
    const gmailOAuth = this.gmailOAuth;
    // Must be set before loadPubSubState/renewWatchIfNeeded: in Pub/Sub mode
    // startPolling() never runs, but the watch registration needs the flag to
    // decide whether to subscribe to the SPAM label.
    gmailOAuth.setIncludeSpam(this.config.includeSpam);
    await gmailOAuth.loadPubSubState();

    if (this.config.gmail.pubsubEnabled && this.config.gmail.topicName) {
      // Pub/Sub mode: renew watch only if it was previously active.
      // First-time watch registration must be done via /v1/gmail/pubsub/start.
      const pubsubStatus = gmailOAuth.pubsubStatus();
      if (pubsubStatus.expiration > 0) {
        await gmailOAuth.renewWatchIfNeeded(this.config.gmail.topicName);
      }
      const updatedStatus = gmailOAuth.pubsubStatus();
      if (updatedStatus.active) {
        gmailOAuth.stop();
      } else {
        gmailOAuth.stop();
        console.warn("[otp-agent] gmail pubsub watch inactive, not polling to preserve quota");
      }
    } else {
      // Pub/Sub not configured — use polling.
      gmailOAuth.startPolling(this.config.pollIntervalMs);
    }
  }

  // Stop all watchers for this user (used when removing a user / shutting down).
  stopAll(): void {
    for (const [, w] of this.qq) this.teardown(w);
    this.qq.clear();
    this.outlookOAuth.stop();
    this.gmailOAuth.stop();
  }

  // Stop a watcher and cancel any pending restart, so a torn-down entry can
  // never resurrect itself after the account was removed or reconfigured.
  private teardown(w: Watcher): void {
    if (w.retryTimer) clearTimeout(w.retryTimer);
    w.retryTimer = null;
    w.alive = false;
    w.watcher.stop();
  }

  // Read-only view for /v1/status, so the UI can distinguish "credential saved"
  // from "actually connected".
  qqStatus(email: string): { online: boolean; lastError: string | null } | null {
    const w = this.qq.get(email);
    if (!w) return null;
    return { online: w.alive && w.watcher.status().running, lastError: w.lastError };
  }

  // Diff the configured QQ accounts against running watchers: stop removed ones,
  // start newly-added ones (only when their secret is present), keep the rest.
  private async reconcileQq(): Promise<void> {
    const wanted = new Set(this.config.qq.accounts.map((a) => a.email));

    for (const [email, w] of this.qq) {
      if (!wanted.has(email)) {
        this.teardown(w);
        this.qq.delete(email);
      }
    }

    for (const { email } of this.config.qq.accounts) {
      const existing = this.qq.get(email);
      if (existing) {
        const settingsUnchanged =
          existing.includeSpam === this.config.includeSpam &&
          existing.pollIntervalMs === this.config.pollIntervalMs;
        // Reason: `alive` used to be missing from this check, so a watcher that
        // had died was indistinguishable from a healthy one and reconcile just
        // skipped it. The only way back was a process restart.
        if (settingsUnchanged && (existing.alive || existing.retryTimer)) continue;
        this.teardown(existing);
        this.qq.delete(email);
      }
      await this.spawnQqWatcher(email, 0);
    }
  }

  /*
   * Start one IMAP watcher and supervise it.
   *
   * start() resolves only when the watcher is finished — normally never. If it
   * settles, the connection is gone, so we schedule a restart with backoff
   * instead of leaving a dead entry behind (which is what used to happen: the
   * rejection was logged and then nothing).
   */
  private async spawnQqWatcher(email: string, attempt: number): Promise<void> {
    const pass = await secretGet(this.kcQq(email));
    if (!pass) return; // configured but no secret yet — skip until set

    const watcher = new ImapOtpWatcher({
      providerId: "qq",
      userId: this.userId,
      host: "imap.qq.com",
      port: 993,
      secure: true,
      auth: { user: email, pass },
      store: this.store,
      pollIntervalMs: this.config.pollIntervalMs,
      includeSpam: this.config.includeSpam,
    });

    const entry: Watcher = {
      watcher,
      includeSpam: this.config.includeSpam,
      pollIntervalMs: this.config.pollIntervalMs,
      alive: true,
      attempt,
      lastError: null,
      retryTimer: null,
    };
    this.qq.set(email, entry);

    const startedAt = Date.now();
    // Reason: a bad credential makes start() reject; swallowing it keeps one
    // broken account from taking down the agent (critical in multi-tenant).
    void watcher
      .start()
      .catch((e) => {
        entry.lastError = String((e as any)?.message || e);
        console.error(`[otp-agent] qq watcher failed for ${email}: ${entry.lastError}`);
      })
      .finally(() => {
        entry.alive = false;
        if (!entry.lastError) entry.lastError = watcher.status().lastError;

        // Superseded by a newer entry, or torn down — do not resurrect.
        if (this.qq.get(email) !== entry) return;
        if (!this.config.qq.accounts.some((a) => a.email === email)) return;

        // A watcher that stayed up a while was healthy; don't punish it with
        // the accumulated backoff of long-past failures.
        const ranMs = Date.now() - startedAt;
        const nextAttempt = ranMs >= RESET_AFTER_MS ? 0 : entry.attempt + 1;
        const delay = retryDelay(nextAttempt);
        console.warn(`[otp-agent] qq watcher for ${email} stopped; retrying in ${Math.round(delay / 1000)}s`);

        entry.retryTimer = setTimeout(() => {
          entry.retryTimer = null;
          if (this.qq.get(email) !== entry) return;
          void this.spawnQqWatcher(email, nextAttempt);
        }, delay);
        entry.retryTimer.unref?.();
      });
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

  async clearQq(): Promise<void> {
    for (const { email } of this.config.qq.accounts) await secretDelete(this.kcQq(email));
    await this.updateConfig((c) => {
      c.qq.accounts = [];
    });
  }

  // Expose the scoped secret key for a kind+email so the HTTP layer can read it.
  secretKeyFor(kind: "qq", email: string): string {
    return this.kcQq(email);
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
