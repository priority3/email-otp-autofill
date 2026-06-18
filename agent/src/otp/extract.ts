export type OtpCandidate = {
  code: string;
  score: number;
  reason: string;
  ttlSec?: number; // validity window parsed from the email body, if stated
};

const KEYWORDS = [
  /验证码/i,
  /驗證碼/i,
  /校验码/i,
  /动态码/i,
  /\bOTP\b/i,
  /one[\s-]?time/i,
  /verification code/i,
  /\bsecurity code\b/i,
  /\blogin code\b/i,
];

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

export function extractOtpCandidates(raw: string): OtpCandidate[] {
  const text = normalize(raw);
  const candidates: OtpCandidate[] = [];

  const nearKeyword = new RegExp(
    String.raw`(?:验证码|驗證碼|校验码|动态码|OTP|one[\s-]?time|verification code|security code|login code)[^0-9]{0,24}(\d{4,8})`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = nearKeyword.exec(text))) {
    const code = m[1]!;
    candidates.push({ code, score: 10 + keywordBoost(m[0]!), reason: "near_keyword" });
  }

  const separatedDigits = /((?:\d[\s-]?){4,8})/g;
  while ((m = separatedDigits.exec(text))) {
    const joined = (m[1] || "").replace(/\D/g, "");
    if (joined.length < 4 || joined.length > 8) continue;
    // Avoid promoting generic numbers too much.
    const ctx = text.slice(Math.max(0, m.index - 24), Math.min(text.length, m.index + 48));
    candidates.push({ code: joined, score: 4 + keywordBoost(ctx), reason: "separated_digits" });
  }

  const plain = /\b(\d{4,8})\b/g;
  while ((m = plain.exec(text))) {
    const code = m[1]!;
    const ctx = text.slice(Math.max(0, m.index - 24), Math.min(text.length, m.index + 48));
    candidates.push({ code, score: 2 + keywordBoost(ctx), reason: "plain_digits" });
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


