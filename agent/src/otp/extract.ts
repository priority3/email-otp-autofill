export type OtpCandidate = {
  code: string;
  score: number;
  reason: string;
  ttlSec?: number; // validity window parsed from the email body, if stated
};

// Keyword fragments (regex source), shared by the keyword-boost test and the
// "code right after a keyword" matchers so the two can never drift apart.
// Includes the Chinese phrasings Microsoft / Outlook use ("安全代码", "单次代码"),
// which earlier versions missed — leaving those codes with no keyword boost.
const KEYWORD_SOURCES = [
  "验证码",
  "驗證碼",
  "校验码",
  "校驗碼",
  "动态码",
  "動態碼",
  "安全代码",
  "安全代碼",
  "安全碼",
  "验证代码",
  "驗證代碼",
  "单次代码",
  "單次代碼",
  "\\bOTP\\b",
  "one[\\s-]?time",
  "verification code",
  "\\bsecurity code\\b",
  "\\blogin code\\b",
  "single[\\s-]?use code",
];
const KEYWORDS = KEYWORD_SOURCES.map((s) => new RegExp(s, "i"));
const KEYWORD_ALT = KEYWORD_SOURCES.join("|");
const CONNECTOR_WORDS = String.raw`(?:is|as|was|are|your|the|this|for)`;
const KEYWORD_CODE_GAP = String.raw`(?:[^A-Za-z0-9]{0,24}(?:\b${CONNECTOR_WORDS}\b[^A-Za-z0-9]{0,24}){0,4})`;
const ALNUM_CODE_PATTERN = String.raw`([A-Za-z0-9](?:[A-Za-z0-9]|[\s-](?=[A-Za-z0-9])){2,18}[A-Za-z0-9])`;

function normalize(s: string): string {
  return s
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function keywordBoost(context: string): number {
  const ctx = context.slice(0, 120);
  let boost = 0;
  for (const re of KEYWORDS) {
    if (re.test(ctx)) boost += 3;
  }
  return boost;
}

// A bare 4-digit number in 1900–2099 is almost always a calendar year (a date
// or a "© 2026" footer), not an OTP. Reason: we only drop it when NO keyword
// sits nearby — a genuine code that happens to look like a year still gets
// matched by the near-keyword pass and keeps its high score.
function looksLikeYear(code: string): boolean {
  if (code.length !== 4) return false;
  const n = Number(code);
  return n >= 1900 && n <= 2099;
}

function normalizeCandidate(code: string): string {
  return code.replace(/[\s-]+/g, "");
}

// Reject a digit run that is really a fragment of a longer number (e.g. slicing
// 8 digits out of a 10-digit QQ account number) or the local part of an email
// address (1832052104@qq.com). Neither is an OTP. Used by the low-confidence
// (keyword-free) passes; `matched` is the full matched substring, `start` its
// index in `text`. Reason: a Google security-alert email that merely mentions a
// secondary mailbox address was surfacing "18320521" as a code.
function isNumericFragment(text: string, start: number, matched: string): boolean {
  const before = start > 0 ? text[start - 1]! : "";
  const after = text[start + matched.length] ?? "";
  if (/[0-9]/.test(before) || /[0-9]/.test(after)) return true; // part of a longer number
  if (before === "@" || after === "@") return true; // an email address part
  return false;
}

function isCodeShape(code: string, allowAlnum: boolean): boolean {
  if (!/^[A-Za-z0-9]+$/.test(code)) return false;
  if (/^\d+$/.test(code)) return code.length >= 4 && code.length <= 8;
  if (!allowAlnum) return false;
  return code.length >= 4 && code.length <= 10 && /[A-Za-z]/.test(code) && /\d/.test(code);
}

export function extractOtpCandidates(raw: string): OtpCandidate[] {
  const text = normalize(raw);
  const candidates: OtpCandidate[] = [];

  // Build a candidate, applying the year rule consistently. A year-shaped
  // number (e.g. "© 2026", "2026年") is never a confident OTP: drop it outright
  // when no keyword is near, and keep it only as a weak last resort when one is
  // — so "验证码：2026" still returns 2026 if it's the lone candidate, but a real
  // code always outranks a stray copyright/date year.
  const push = (rawCode: string, baseScore: number, reason: string, boost: number, allowAlnum = false) => {
    const code = normalizeCandidate(rawCode);
    if (!isCodeShape(code, allowAlnum)) return;
    if (looksLikeYear(code)) {
      if (boost === 0) return;
      candidates.push({ code, score: 2, reason });
      return;
    }
    candidates.push({ code, score: baseScore + boost, reason });
  };

  let m: RegExpExecArray | null;

  // Alphanumeric codes right after a keyword: "验证码为: d6ad3e",
  // "your verification code is A1B2C3". Restrict mixed codes to keyword
  // contexts; global alphanumeric scanning would pick up URL tokens too often.
  const alnumAfterKeyword = new RegExp(String.raw`(?:${KEYWORD_ALT})${KEYWORD_CODE_GAP}${ALNUM_CODE_PATTERN}`, "gi");
  while ((m = alnumAfterKeyword.exec(text))) {
    push(m[1]!, 13, "near_keyword_alnum", keywordBoost(m[0]!), true);
  }

  // Alphanumeric codes right before a keyword: "A1B2C3 is your verification code".
  const alnumBeforeKeyword = new RegExp(String.raw`\b([A-Za-z0-9][A-Za-z0-9-]{2,18}[A-Za-z0-9])\b${KEYWORD_CODE_GAP}(?:${KEYWORD_ALT})`, "gi");
  while ((m = alnumBeforeKeyword.exec(text))) {
    push(m[1]!, 12, "near_keyword_alnum", keywordBoost(m[0]!), true);
  }

  // Digits right after a keyword: "验证码：123456".
  const afterKeyword = new RegExp(String.raw`(?:${KEYWORD_ALT})[^0-9]{0,24}(\d{4,8})`, "gi");
  while ((m = afterKeyword.exec(text))) {
    push(m[1]!, 10, "near_keyword", keywordBoost(m[0]!));
  }

  // Digits right before a keyword: "752740 is your verification code". Without
  // this, a copyright year that follows the keyword would outrank the real code
  // that precedes it.
  const beforeKeyword = new RegExp(String.raw`(\d{4,8})[^0-9]{0,24}(?:${KEYWORD_ALT})`, "gi");
  while ((m = beforeKeyword.exec(text))) {
    push(m[1]!, 10, "near_keyword", keywordBoost(m[0]!));
  }

  const separatedDigits = /((?:\d[\s-]?){4,8})/g;
  while ((m = separatedDigits.exec(text))) {
    const joined = (m[1] || "").replace(/\D/g, "");
    if (joined.length < 4 || joined.length > 8) continue;
    if (isNumericFragment(text, m.index, m[0]!)) continue;
    // Avoid promoting generic numbers too much.
    const ctx = text.slice(Math.max(0, m.index - 24), Math.min(text.length, m.index + 48));
    push(joined, 4, "separated_digits", keywordBoost(ctx));
  }

  const plain = /\b(\d{4,8})\b/g;
  while ((m = plain.exec(text))) {
    if (isNumericFragment(text, m.index, m[0]!)) continue;
    const ctx = text.slice(Math.max(0, m.index - 24), Math.min(text.length, m.index + 48));
    push(m[1]!, 2, "plain_digits", keywordBoost(ctx));
  }

  // De-dupe: keep best score per code.
  const best = new Map<string, OtpCandidate>();
  for (const c of candidates) {
    const prev = best.get(c.code);
    if (!prev || c.score > prev.score) best.set(c.code, c);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

export function extractBestOtp(raw: string): OtpCandidate | null {
  const candidates = extractOtpCandidates(raw);
  if (!candidates.length) return null;
  const best = candidates[0]!;
  const ttlSec = extractTtlSec(raw);
  return ttlSec != null ? { ...best, ttlSec } : best;
}

// Unit → seconds multiplier. Covers Chinese (秒/分/小时) and English variants.
const UNIT_SEC: Array<{ re: RegExp; mult: number }> = [
  { re: /^(?:小时|小時|hours?|hrs?|h)$/i, mult: 3600 },
  { re: /^(?:分钟|分鐘|分|minutes?|mins?|m)$/i, mult: 60 },
  { re: /^(?:秒钟|秒鐘|秒|seconds?|secs?|s)$/i, mult: 1 },
];

// Parse a stated validity window like "请在 5 分钟内", "valid for 10 minutes",
// "expires in 30 seconds", "有效期 2 小时". Returns seconds, or null if none
// found / out of a sane range. The caller falls back to the configured maxAge.
export function extractTtlSec(raw: string): number | null {
  const text = normalize(raw);

  // A number immediately followed by a time unit. We then check the surrounding
  // context contains a validity cue so we don't grab unrelated durations.
  // Note: no \b after the unit — \b is ASCII-only and fails after CJK chars
  // like 分钟/秒, so a trailing word boundary would break Chinese matching.
  const re =
    /(\d{1,4})\s*(小时|小時|hours?|hrs?|分钟|分鐘|分|minutes?|mins?|秒钟|秒鐘|秒|seconds?|secs?)/gi;
  const CUE =
    /(有效|内|內|within|valid|expires?|expir|过期|過期|失效|内有效|分钟内|内完成)/i;

  let m: RegExpExecArray | null;
  let best: number | null = null;
  while ((m = re.exec(text))) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unitRaw = m[2]!;
    const unit = UNIT_SEC.find((u) => u.re.test(unitRaw));
    if (!unit) continue;

    // Require a validity cue within a small window around the match, otherwise
    // a stray "5 minutes" elsewhere in the body could mislead us.
    const ctx = text.slice(Math.max(0, m.index - 16), Math.min(text.length, m.index + unitRaw.length + 16));
    if (!CUE.test(ctx)) continue;

    const sec = n * unit.mult;
    // Sane bounds: between 10s and 24h.
    if (sec < 10 || sec > 86_400) continue;
    // Prefer the first plausible match (usually the primary instruction line).
    best = sec;
    break;
  }
  return best;
}

