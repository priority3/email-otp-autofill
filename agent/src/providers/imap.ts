import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import { extractBestOtp } from "../otp/extract.js";
import type { OtpStore, ProviderId } from "../otp/store.js";

export type ImapAuth = {
  user: string;
  pass: string;
};

export type ImapProviderOptions = {
  providerId: ProviderId;
  host: string;
  port: number;
  secure: boolean;
  auth: ImapAuth;
  store: OtpStore;
};

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ");
}

export class ImapOtpWatcher {
  private client: ImapFlow;
  private opts: ImapProviderOptions;
  private running = false;
  private processing: Promise<void> = Promise.resolve();
  private lastError: string | null = null;

  constructor(opts: ImapProviderOptions) {
    this.opts = opts;
    this.client = new ImapFlow({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: { user: opts.auth.user, pass: opts.auth.pass },
      logger: false,
    });
  }

  status() {
    return { running: this.running, lastError: this.lastError };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.client.on("error", (err) => {
      this.lastError = err instanceof Error ? err.message : String(err);
    });

    this.client.on("exists", () => {
      this.processing = this.processing
        .then(async () => {
          await this.fetchLatest();
        })
        .catch((e) => {
          this.lastError = e instanceof Error ? e.message : String(e);
        });
    });

    try {
      await this.client.connect();
      await this.fetchLatest(); // initial quick scan
      // Keep the connection alive.
      while (this.running) {
        try {
          await this.client.idle();
        } catch (e) {
          this.lastError = e instanceof Error ? e.message : String(e);
          // Some servers close IDLE periodically; reconnect.
          await this.safeReconnect();
        }
      }
    } finally {
      await this.safeLogout();
    }
  }

  stop() {
    this.running = false;
    try {
      this.client.close();
    } catch {
      // ignore
    }
  }

  private async safeReconnect(): Promise<void> {
    try {
      await this.safeLogout();
    } catch {
      // ignore
    }
    if (!this.running) return;
    await this.client.connect();
  }

  private async safeLogout(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // ignore
    }
  }

  private async fetchLatest(): Promise<void> {
    const lock = await this.client.getMailboxLock("INBOX");
    try {
      const mailbox = this.client.mailbox;
      if (!mailbox) return;
      const exists = mailbox.exists || 0;
      if (!exists) return;

      const msg = await this.client.fetchOne(exists, {
        envelope: true,
        source: true,
        internalDate: true,
        uid: false,
      });
      if (!msg) return;
      const anyMsg = msg as any;
      if (!anyMsg.source) return;

      const parsed = await simpleParser(anyMsg.source as Buffer);
      const text = parsed.text?.trim() || "";
      const html = parsed.html ? stripHtml(String(parsed.html)) : "";
      const raw = `${parsed.subject ?? ""}\n${text}\n${html}`;
      const best = extractBestOtp(raw);
      if (!best) return;

      const envelope = anyMsg.envelope as any;
      const from = parsed.from?.text || envelope?.from?.[0]?.address || undefined;
      const subject = parsed.subject || envelope?.subject || undefined;
      const messageId = parsed.messageId || undefined;
      const internalDate = anyMsg.internalDate as any;
      const receivedAt = internalDate
        ? new Date(internalDate).getTime()
        : Date.now();

      this.opts.store.add({
        provider: this.opts.providerId,
        code: best.code,
        receivedAt,
        from,
        subject,
        messageId,
      });
    } finally {
      lock.release();
    }
  }
}
