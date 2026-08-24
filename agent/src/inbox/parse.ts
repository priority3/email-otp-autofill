import { simpleParser } from "mailparser";
import { z } from "zod";

/*
 * Inbound webhook body → canonical message.
 *
 * Kept free of express so it can be unit-tested directly: this repo has no
 * HTTP-level test harness (see tests/), so the parsing rules only get covered
 * if they live in a plain function.
 */

export type InboundMessage = {
  to: string[]; // recipient addresses, display names stripped, lower-cased
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  receivedAt?: number; // from the message's own Date header — NOT yet clamped
  messageId?: string;
};

// Everything optional: a malformed push should be reported as "skipped", not
// rejected with a schema error the mail source cannot act on.
const InboundBody = z.object({
  to: z.union([z.string(), z.array(z.string())]).optional(),
  from: z.string().optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  receivedAt: z.union([z.number(), z.string()]).optional(),
  messageId: z.string().optional(),
});

/*
 * Pull a bare address out of the shapes a sender might use:
 *   "a@b.com"  |  "Name <a@b.com>"  |  "a@b.com, c@d.com"
 * Returns [] when nothing address-shaped is present.
 */
export function normalizeAddresses(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const parts = Array.isArray(raw) ? raw : raw.split(",");
  const out: string[] = [];
  for (const part of parts) {
    const s = String(part).trim();
    if (!s) continue;
    // Prefer the <...> form when present, otherwise take the whole token.
    const angle = /<([^>]+)>/.exec(s);
    const candidate = (angle ? angle[1]! : s).trim().toLowerCase();
    if (candidate.includes("@")) out.push(candidate);
  }
  return [...new Set(out)];
}

// Epoch ms, or a date string. Anything unparseable yields undefined so the
// caller falls back to "now" instead of inheriting NaN.
function toEpochMs(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const n = Number(value);
  if (Number.isFinite(n) && String(value).trim() !== "") return n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonBody(text: string): InboundMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const body = InboundBody.safeParse(raw);
  if (!body.success) return null;
  const d = body.data;
  return {
    to: normalizeAddresses(d.to),
    from: d.from,
    subject: d.subject,
    text: d.text,
    html: d.html,
    receivedAt: toEpochMs(d.receivedAt),
    messageId: d.messageId,
  };
}

// mailparser types `to` as AddressObject | AddressObject[]; both carry .value[].
function addressesFromParsed(field: unknown): string[] {
  const entries = Array.isArray(field) ? field : field ? [field] : [];
  const out: string[] = [];
  for (const entry of entries) {
    const value = (entry as any)?.value;
    if (!Array.isArray(value)) continue;
    for (const v of value) {
      const addr = String(v?.address || "").trim().toLowerCase();
      if (addr.includes("@")) out.push(addr);
    }
  }
  return out;
}

/*
 * Recipient fallbacks. A catch-all forwarder often leaves the original address
 * only in Delivered-To / X-Original-To, with the To: header pointing at the
 * forwarding mailbox — so those headers are checked when To: yields nothing.
 */
function recipientsFromHeaders(headers: unknown): string[] {
  const map = headers as Map<string, unknown> | undefined;
  if (!map || typeof map.get !== "function") return [];
  for (const name of ["delivered-to", "x-original-to", "x-forwarded-to", "envelope-to"]) {
    const value = map.get(name);
    if (!value) continue;
    const fromObjects = addressesFromParsed(value);
    if (fromObjects.length) return fromObjects;
    const flat = Array.isArray(value) ? value.map(String) : [String(value)];
    const normalized = normalizeAddresses(flat);
    if (normalized.length) return normalized;
  }
  return [];
}

async function parseRfc822(body: Buffer): Promise<InboundMessage | null> {
  let parsed: Awaited<ReturnType<typeof simpleParser>>;
  try {
    parsed = await simpleParser(body);
  } catch {
    return null;
  }
  const to = addressesFromParsed(parsed.to);
  const recipients = to.length ? to : recipientsFromHeaders(parsed.headers);
  const fromAddr = addressesFromParsed(parsed.from);

  return {
    to: [...new Set(recipients)],
    // Prefer the bare address; fall back to the raw text (may carry a display name).
    from: fromAddr[0] || parsed.from?.text?.trim() || undefined,
    subject: parsed.subject || undefined,
    text: parsed.text?.trim() || undefined,
    html: parsed.html ? String(parsed.html) : undefined,
    receivedAt: parsed.date ? parsed.date.getTime() : undefined,
    messageId: parsed.messageId || undefined,
  };
}

/*
 * Dispatch on content-type. `application/json` takes the JSON path; everything
 * else is attempted as RFC822, because a mail source forwarding raw messages
 * may send message/rfc822, text/plain, or no content-type at all.
 *
 * Returns null when the body cannot be parsed at all.
 */
export async function parseInbound(body: Buffer, contentType: string): Promise<InboundMessage | null> {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("application/json")) {
    return parseJsonBody(body.toString("utf8"));
  }
  return parseRfc822(body);
}
