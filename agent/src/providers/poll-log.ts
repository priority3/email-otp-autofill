/*
 * Logging helper for high-frequency pollers.
 *
 * Two failure modes to avoid, and they pull in opposite directions:
 *
 *  - Silence. The Outlook poller used to swallow every error into a private
 *    `lastError` field, so a dead mailbox looked exactly like a healthy one in
 *    `docker logs`. Hours of "no codes arriving" with zero log lines.
 *  - Flooding. Pollers run every few seconds. Logging each failure turns one
 *    broken account into thousands of identical lines that bury everything else.
 *
 * So: log a fault the moment it appears, stay quiet while it is unchanged,
 * summarize periodically so it can't be mistaken for resolved, and say so
 * explicitly when it clears.
 */

export type LogSink = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

const consoleSink: LogSink = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

/*
 * Unwrap the cause chain into something actionable.
 *
 * `fetch()` reports nearly every network problem as the same opaque
 * "fetch failed"; the code that says whether it was DNS, a refused proxy or a
 * timeout lives on `err.cause`. Without this, proxy flaps and dead endpoints
 * are indistinguishable in the logs.
 */
export function describeError(err: unknown): string {
  const base = String((err as any)?.message || err || "unknown error");
  const cause = (err as any)?.cause;
  if (!cause) return base;
  const detail = String(cause.code || cause.message || "").trim();
  return detail && !base.includes(detail) ? `${base} (${detail})` : base;
}

export class PollLogger {
  private lastKey: string | null = null;
  private repeats = 0;

  /*
   * `summarizeEvery` counts consecutive identical failures between summary
   * lines. At a 5s poll interval the default emits roughly one line every
   * 5 minutes while a fault persists.
   */
  constructor(
    private readonly label: string,
    private readonly summarizeEvery = 60,
    private readonly sink: LogSink = consoleSink
  ) {}

  /* A state worth stating once, e.g. "not connected". Repeats stay quiet. */
  note(message: string): void {
    if (this.lastKey === message) return;
    this.lastKey = message;
    this.repeats = 0;
    this.sink.info(`${this.label} ${message}`);
  }

  fail(err: unknown): string {
    const message = describeError(err);
    if (message !== this.lastKey) {
      this.lastKey = message;
      this.repeats = 0;
      this.sink.error(`${this.label} error: ${message}`);
      return message;
    }
    this.repeats += 1;
    if (this.repeats % this.summarizeEvery === 0) {
      this.sink.error(`${this.label} error: ${message} (still failing, ${this.repeats + 1} consecutive)`);
    }
    return message;
  }

  /*
   * Reports recovery only when it follows something we logged. A healthy poller
   * stays silent; without this guard every poll would emit a line.
   */
  ok(): void {
    if (this.lastKey === null) return;
    this.lastKey = null;
    this.repeats = 0;
    this.sink.info(`${this.label} recovered`);
  }
}
