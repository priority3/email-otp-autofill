import { extractBestOtp } from "../otp/extract.js";
import { otpSourceText } from "../otp/html.js";
import type { OtpStore } from "../otp/store.js";
import type { AppConfig } from "../storage/config.js";
import { clampReceivedAt, isTooOld, matchRecipient } from "./filter.js";
import type { InboundMessage } from "./parse.js";

/*
 * The inbound webhook channel: turns a pushed message into an OTP store entry.
 *
 * Deliberately holds counters only, never message content. A catch-all domain
 * receives mail from strangers, so buffering bodies for troubleshooting would
 * turn this into a privacy liability (and an unbounded memory cost).
 */

export type InboxStats = {
  lastInboundAt: number | null;
  accepted: number;
  skipped: number;
  lastSkipReason: string | null;
};

export type IngestResult = { ok: true; account: string } | { ok: false; skipped: string };

function emptyStats(): InboxStats {
  return { lastInboundAt: null, accepted: 0, skipped: 0, lastSkipReason: null };
}

export class InboxChannel {
  private store: OtpStore;
  private stats = new Map<string, InboxStats>();

  constructor(store: OtpStore) {
    this.store = store;
  }

  statsFor(userId: string): InboxStats {
    return { ...(this.stats.get(userId) ?? emptyStats()) };
  }

  private mut(userId: string): InboxStats {
    let s = this.stats.get(userId);
    if (!s) {
      s = emptyStats();
      this.stats.set(userId, s);
    }
    return s;
  }

  // For skips the HTTP layer detects before a message exists (channel disabled,
  // unparseable body) — keeps every skip visible in one place.
  recordSkip(userId: string, reason: string, now = Date.now()): void {
    const s = this.mut(userId);
    s.lastInboundAt = now;
    s.skipped += 1;
    s.lastSkipReason = reason;
  }

  ingest(
    msg: InboundMessage,
    userId: string,
    inbox: AppConfig["inbox"],
    now = Date.now()
  ): IngestResult {
    const account = matchRecipient(msg.to, inbox);
    if (!account) {
      this.recordSkip(userId, msg.to.length ? "recipient_not_allowed" : "no_recipient", now);
      return { ok: false, skipped: msg.to.length ? "recipient_not_allowed" : "no_recipient" };
    }

    const receivedAt = clampReceivedAt(msg.receivedAt, now);
    if (isTooOld(receivedAt, now)) {
      this.recordSkip(userId, "too_old", now);
      return { ok: false, skipped: "too_old" };
    }

    // Reason: same assembly as the IMAP path (otpSourceText) so one email yields
    // the same code no matter which channel delivered it.
    const best = extractBestOtp(
      otpSourceText({ subject: msg.subject, text: msg.text, html: msg.html })
    );
    if (!best) {
      this.recordSkip(userId, "no_otp", now);
      return { ok: false, skipped: "no_otp" };
    }

    this.store.add({
      provider: "inbox",
      userId,
      account,
      code: best.code,
      receivedAt,
      ttlSec: best.ttlSec,
      from: msg.from || undefined,
      subject: msg.subject || undefined,
      // Omitted when absent: OtpStore falls back to account+code+receivedAt for
      // its de-dupe key, so no synthetic id is needed here.
      messageId: msg.messageId || undefined,
    });

    const s = this.mut(userId);
    s.lastInboundAt = now;
    s.accepted += 1;
    return { ok: true, account };
  }
}
