import { ImapOtpWatcher } from "./imap.js";
import { OutlookOAuthProvider } from "./outlook-oauth.js";
import type { OtpStore } from "../otp/store.js";
import type { AppConfig } from "../storage/config.js";
import { loadConfig, saveConfig } from "../storage/config.js";
import { secretDelete, secretGet } from "../storage/secrets.js";

function kcQq(email: string) {
  return `qq:${email}`;
}
function kcOutlookImap(email: string) {
  return `outlook_imap:${email}`;
}

export class ProviderManager {
  private store: OtpStore;
  config: AppConfig;

  private qq: { email: string; watcher: ImapOtpWatcher; task: Promise<void> } | null = null;
  private outlookImap: { email: string; watcher: ImapOtpWatcher; task: Promise<void> } | null = null;
  private outlookOAuth: OutlookOAuthProvider;

  constructor(store: OtpStore, config: AppConfig) {
    this.store = store;
    this.config = config;
    this.outlookOAuth = new OutlookOAuthProvider(store);
    this.outlookOAuth.setClientId(this.config.outlook.clientId ?? null);
  }

  static async create(store: OtpStore): Promise<ProviderManager> {
    const cfg = await loadConfig();
    return new ProviderManager(store, cfg);
  }

  getOutlookOAuth() {
    return this.outlookOAuth;
  }

  async reloadConfig(): Promise<void> {
    this.config = await loadConfig();
    this.outlookOAuth.setClientId(this.config.outlook.clientId ?? null);
    await this.reconcile();
  }

  async updateConfig(mut: (cfg: AppConfig) => void): Promise<void> {
    const cfg = await loadConfig();
    mut(cfg);
    await saveConfig(cfg);
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

  private async reconcileQq(): Promise<void> {
    const email = this.config.qq.email;
    if (!email) {
      this.qq?.watcher.stop();
      this.qq = null;
      return;
    }
    if (this.qq && this.qq.email !== email) {
      this.qq.watcher.stop();
      this.qq = null;
    }
    const pass = await secretGet(kcQq(email));
    if (!pass) {
      this.qq?.watcher.stop();
      this.qq = null;
      return;
    }
    if (this.qq) return;

    const watcher = new ImapOtpWatcher({
      providerId: "qq",
      host: "imap.qq.com",
      port: 993,
      secure: true,
      auth: { user: email, pass },
      store: this.store,
    });
    const task = watcher.start();
    this.qq = { email, watcher, task };
  }

  private async reconcileOutlook(): Promise<void> {
    if (this.config.outlook.mode === "imap") {
      // Stop OAuth poller.
      this.outlookOAuth.stop();

      const email = this.config.outlook.imapEmail;
      if (!email) {
        this.outlookImap?.watcher.stop();
        this.outlookImap = null;
        return;
      }
      if (this.outlookImap && this.outlookImap.email !== email) {
        this.outlookImap.watcher.stop();
        this.outlookImap = null;
      }
      const pass = await secretGet(kcOutlookImap(email));
      if (!pass) {
        this.outlookImap?.watcher.stop();
        this.outlookImap = null;
        return;
      }
      if (this.outlookImap) return;

      const watcher = new ImapOtpWatcher({
        providerId: "outlook",
        host: "imap-mail.outlook.com",
        port: 993,
        secure: true,
        auth: { user: email, pass },
        store: this.store,
      });
      const task = watcher.start();
      this.outlookImap = { email, watcher, task };
      return;
    }

    // OAuth mode: ensure IMAP watcher is stopped.
    this.outlookImap?.watcher.stop();
    this.outlookImap = null;
  }

  async clearQq(): Promise<void> {
    const email = this.config.qq.email;
    if (email) await secretDelete(kcQq(email));
    await this.updateConfig((c) => {
      c.qq.email = undefined;
    });
  }

  async clearOutlookImap(): Promise<void> {
    const email = this.config.outlook.imapEmail;
    if (email) await secretDelete(kcOutlookImap(email));
    await this.updateConfig((c) => {
      c.outlook.imapEmail = undefined;
    });
  }
}
