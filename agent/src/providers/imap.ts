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
  pollIntervalMs?: number;
  includeSpam?: boolean;
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

const JUNK_NAME_HINTS = [
  "junk",
  "spam",
  "bulk",
  "垃圾",
  "垃圾邮件",
  "垃圾郵件",
  "垃圾箱",
  "junk e-mail",
  "junk email",
];
const JUNK_FALLBACK_FOLDERS = ["Junk", "Spam", "Bulk Mail", "Junk E-mail", "垃圾邮件"];

function flattenMailboxes(entries: any[]): any[] {
  const out: any[] = [];
  for (const entry of entries) {
    out.push(entry);
    if (Array.isArray(entry?.children)) out.push(...flattenMailboxes(entry.children));
  }
  return out;
}

function folderPath(entry: any): string {
  return String(entry?.path || entry?.name || "").trim();
}

function isLikelyJunkFolder(entry: any): boolean {
  const flags = Array.isArray(entry?.specialUse)
    ? entry.specialUse
    : entry?.specialUse
      ? [entry.specialUse]
      : Array.isArray(entry?.flags)
        ? entry.flags
        : [];
  if (flags.some((f: unknown) => String(f).toLowerCase() === "\\junk")) return true;

  const name = `${entry?.name || ""} ${entry?.path || ""}`.toLowerCase();
  return JUNK_NAME_HINTS.some((hint) => name.includes(hint.toLowerCase()));
}

export class ImapOtpWatcher {
  private client: ImapFlow;
  private opts: ImapProviderOptions;
  private running = false;
  private processing: Promise<void> = Promise.resolve();
  private lastError: string | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshBusy = false;
  private junkFolders: string[] | null = null;

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

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.processing = this.processing
      .then(async () => {
        if (!this.running) return;
        await task();
      })
      .catch((e) => {
        this.lastError = e instanceof Error ? e.message : String(e);
      });
    return this.processing;
  }

  private queueFetchLatest(): void {
    if (!this.running) return;
    this.enqueue(async () => {
      await this.fetchLatest();
    });
  }

  private queueHeartbeat(): void {
    if (!this.running || this.refreshBusy) return;
    this.refreshBusy = true;
    const task = this.enqueue(async () => {
      try {
        await this.client.noop();
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
      } finally {
        await this.fetchLatest();
      }
    });
    void task.finally(() => {
      this.refreshBusy = false;
    });
  }

  private startHeartbeat(): void {
    if (this.refreshTimer || !this.opts.pollIntervalMs) return;
    const intervalMs = Math.max(1000, this.opts.pollIntervalMs);
    this.refreshTimer = setInterval(() => {
      this.queueHeartbeat();
    }, intervalMs);
    this.refreshTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.refreshBusy = false;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

      this.client.on("error", (err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      });

      this.client.on("exists", () => {
        this.queueFetchLatest();
      });

    try {
      await this.client.connect();
      await this.fetchLatest(); // initial quick scan
      this.startHeartbeat();
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
    this.stopHeartbeat();
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

  private async resolveJunkFolders(): Promise<string[]> {
    if (!this.opts.includeSpam) return [];
    if (this.junkFolders) return this.junkFolders;

    const folders = new Set<string>();
    try {
      const listed = await (this.client as any).list();
      const entries = flattenMailboxes(Array.isArray(listed) ? listed : []);
      for (const entry of entries) {
        if (!isLikelyJunkFolder(entry)) continue;
        const path = folderPath(entry);
        if (path && path.toUpperCase() !== "INBOX") folders.add(path);
      }
    } catch {
      // Fall back to common names below; failed folder locks are ignored.
    }

    if (!folders.size) {
      for (const path of JUNK_FALLBACK_FOLDERS) folders.add(path);
    }
    this.junkFolders = [...folders];
    return this.junkFolders;
  }

  private async fetchLatest(): Promise<void> {
    // Keep INBOX last so the connection is selected back to INBOX before IDLE.
    // Spam/Junk still gets covered by the heartbeat poll.
    const folders = [...(await this.resolveJunkFolders()), "INBOX"];
    for (const folder of folders) {
      await this.fetchLatestFromFolder(folder);
    }
  }

  private async fetchLatestFromFolder(folder: string): Promise<void> {
    let lock: { release: () => void } | null = null;
    try {
      lock = await this.client.getMailboxLock(folder);
    } catch (e) {
      if (folder !== "INBOX" && this.junkFolders) {
        this.junkFolders = this.junkFolders.filter((f) => f !== folder);
      }
      if (folder !== "INBOX") return;
      throw e;
    }
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
        messageId: messageId ? `${folder}:${messageId}` : undefined,
        folder,
      });
    } finally {
      lock?.release();
    }
  }
}
