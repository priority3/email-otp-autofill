export type OtpCandidate = {
  code: string;
  score: number;
  reason: string;
  ttlSec?: number; // validity window parsed from the email body, if stated
};

// Keyword fragments (regex source), shared by the keyword-boost test and the
// "digits right after a keyword" matcher so the two can never drift apart.
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

export function extractOtpCandidates(raw: string): OtpCandidate[] {
  const text = normalize(raw);
  const candidates: OtpCandidate[] = [];

  // Build a candidate, applying the year rule consistently. A year-shaped
  // number (e.g. "© 2026", "2026年") is never a confident OTP: drop it outright
  // when no keyword is near, and keep it only as a weak last resort when one is
  // — so "验证码：2026" still returns 2026 if it's the lone candidate, but a real
  // code always outranks a stray copyright/date year.
  const push = (code: string, baseScore: number, reason: string, boost: number) => {
    if (looksLikeYear(code)) {
      if (boost === 0) return;
      candidates.push({ code, score: 2, reason });
      return;
    }
    candidates.push({ code, score: baseScore + boost, reason });
  };

  let m: RegExpExecArray | null;

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
    // Avoid promoting generic numbers too much.
    const ctx = text.slice(Math.max(0, m.index - 24), Math.min(text.length, m.index + 48));
    push(joined, 4, "separated_digits", keywordBoost(ctx));
  }

  const plain = /\b(\d{4,8})\b/g;
  while ((m = plain.exec(text))) {
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


