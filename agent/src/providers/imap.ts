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
  userId?: string; // owning user (multi-tenant); defaults to "local"
  host: string;
  port: number;
  secure: boolean;
  auth: ImapAuth;
  store: OtpStore;
};

export type VerifyImapInput = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  timeoutMs?: number;
};

export type VerifyImapResult = { ok: true } | { ok: false; error: string };

// Normalize an IMAP error into a stable, user-actionable code.
function classifyImapError(e: unknown): string {
  const err = e as any;
  // ImapFlow flags auth failures explicitly; trust that first.
  if (err?.authenticationFailed === true || err?.responseStatus === "NO") return "auth_failed";
  const msg = `${err?.message || ""} ${err?.responseText || ""} ${err?.response || ""} ${err || ""}`.toLowerCase();
  if (/(authenticationfailed|login fail|invalid credentials|auth|password incorrect|授权|密码)/.test(msg)) {
    return "auth_failed";
  }
  if (/(timeout|timed out)/.test(msg)) return "connect_timeout";
  if (/(econn|enotfound|getaddrinfo|network|socket|refused|reset)/.test(msg)) return "network_error";
  return "verify_failed";
}

// Short-lived connection that verifies credentials can log in and open INBOX,
// then logs out. Used to validate a mailbox before saving it. Never throws —
// returns a result with a normalized error code.
export async function verifyImap(input: VerifyImapInput): Promise<VerifyImapResult> {
  const timeoutMs = input.timeoutMs ?? 15000;
  const client = new ImapFlow({
    host: input.host,
    port: input.port,
    secure: input.secure,
    auth: { user: input.user, pass: input.pass },
    logger: false,
    // Bound the handshake so a hung server doesn't block the request.
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  } as any);

  // Hard overall deadline in case the library hangs past its own timeouts.
  let timer: NodeJS.Timeout | null = null;
  const deadline = new Promise<VerifyImapResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: "connect_timeout" }), timeoutMs + 2000);
  });

  const attempt = (async (): Promise<VerifyImapResult> => {
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      lock.release();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: classifyImapError(e) };
    } finally {
      try {
        await client.logout();
      } catch {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
    }
  })();

  const result = await Promise.race([attempt, deadline]);
  if (timer) clearTimeout(timer);
  return result;
}

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
        userId: this.opts.userId,
        account: this.opts.auth.user,
        code: best.code,
        receivedAt,
        ttlSec: best.ttlSec,
        from,
        subject,
        messageId,
      });
    } finally {
      lock.release();
    }
  }
}
