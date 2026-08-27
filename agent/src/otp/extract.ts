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
  // SaaS signup mails (Google-style / SpaceXAI / etc.) often say "use the code
  // below to validate your email" rather than "verification code".
  "validate your email",
  "verify your email",
  "confirm your email",
  "use the code",
  "enter the code",
  "code below",
  "following code",
];
const KEYWORDS = KEYWORD_SOURCES.map((s) => new RegExp(s, "i"));
const KEYWORD_ALT = KEYWORD_SOURCES.join("|");

// A much weaker signal than KEYWORD_SOURCES: it only says the mail talks about
// a code / verification *at all*, without implying a code sits nearby. Used
// solely to gate the low-confidence digit passes — never to score a candidate.
// Deliberately narrow on the Chinese side: "安全" alone is far too common in
// notification mails ("安全提醒", "安全技术"), so a 码/碼 must follow it.
const SOFT_CUE =
  /验证|驗證|校验|校驗|动态码|動態碼|口令|密[码碼]|安全[码碼]|代[码碼]|\bcodes?\b|\bpasscode\b|\bPIN\b|\bOTP\b|\bverif|\bauthenticat/i;
const CONNECTOR_WORDS = String.raw`(?:is|as|was|are|your|the|this|for)`;
const KEYWORD_CODE_GAP = String.raw`(?:[^A-Za-z0-9]{0,24}(?:\b${CONNECTOR_WORDS}\b[^A-Za-z0-9]{0,24}){0,4})`;
// Only "-" may join code groups, never a space. Reason: a space-joined pattern
// welds an ordinary word to an adjacent number — "email otp autofill" + "85% off"
// became the code "autofill85". Space-separated *digit* groups ("123 456") are
// still handled by the separated_digits pass.
const ALNUM_CODE_PATTERN = String.raw`([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){2,34}[A-Za-z0-9])`;

/*
 * Length ceilings for mixed letter+digit codes, per pass.
 *
 * Sites increasingly mail an opaque hex token rather than 6 digits — NodeSeek
 * sends a 24-char one ("...你的验证码是7a38ff0ab00ff1780989bfe0"). The old
 * ceiling of 10 dropped it outright, and with the real code gone the extractor
 * fell back to an unrelated 8-digit number elsewhere in the HTML: the user was
 * shown a confidently wrong code, which is worse than showing none.
 *
 * The ceiling is raised only where a keyword sits right next to the token. A
 * long hex run on its own is far more likely to be an id than a code, so the
 * keyword-free and standalone-line passes keep the strict limit.
 */
const ALNUM_MAX_NEAR_KEYWORD = 36;
const ALNUM_MAX_STANDALONE = 10;


function normalize(s: string): string {
  return s
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Drop URLs before scanning for codes. Reason: marketing/tracking links are
// dense with code-shaped tokens \u2014 SendGrid click URLs percent-encode "/" and
// "+" as "-2F"/"-2B", producing runs like "-2BvlfpaVWO", and query strings
// carry "code=REMIND15V5". A real OTP is never inside a URL, but these tokens
// sit close enough to a keyword to outscore everything else.
function stripUrls(s: string): string {
  return (
    s
      .replace(/\bhttps?:\/\/\S+/gi, " ")
      .replace(/\bwww\.[^\s<>"]+/gi, " ")
      // Tracking URLs frequently carry an unencoded space in a query value (a
      // brand name), so the patterns above stop at that space and leave a tail
      // like "autofill&code=REMIND15V5&utm_medium=email&utm_content=...-20260706-...".
      // Sweep up any run that still shows "&key=value" query syntax.
      .replace(/\S*(?:&[A-Za-z_][\w.-]*=[^\s&]*)+/g, " ")
  );
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

// Reject a digit run that is really a fragment of a longer token — a longer
// number (slicing 8 digits out of a 10-digit QQ account), the local part of an
// email address (1832052104@qq.com), or a hex/app id embedded in a URL path
// (…/6efe458dfe2230acceea → "2230"). Neither is an OTP. Used by the
// low-confidence (keyword-free) passes; `matched` is the full matched substring,
// `start` its index in `text`.
function isNumericFragment(text: string, start: number, matched: string): boolean {
  const before = start > 0 ? text[start - 1]! : "";
  const after = text[start + matched.length] ?? "";
  // Letter/digit/underscore on either side ⇒ part of a larger alphanumeric token
  // (hex ids, path segments, long numbers). Separated-digit OTPs are bounded by
  // spaces/punctuation, so they still pass.
  if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) return true;
  if (before === "@" || after === "@") return true; // an email address part
  return false;
}

/*
 * `alnumMax` is both the switch and the ceiling for mixed letter+digit codes:
 * 0 means digits only. Pure-digit codes keep their own 4–8 range regardless,
 * since a long digit run is an account or order number, never an OTP.
 */
function isCodeShape(code: string, alnumMax: number): boolean {
  if (!/^[A-Za-z0-9]+$/.test(code)) return false;
  if (/^\d+$/.test(code)) return code.length >= 4 && code.length <= 8;
  if (alnumMax <= 0) return false;
  return code.length >= 4 && code.length <= alnumMax && /[A-Za-z]/.test(code) && /\d/.test(code);
}

export function extractOtpCandidates(raw: string): OtpCandidate[] {
  const text = stripUrls(normalize(raw));
  const candidates: OtpCandidate[] = [];

  // Build a candidate, applying the year rule consistently. A year-shaped
  // number (e.g. "© 2026", "2026年") is never a confident OTP: drop it outright
  // when no keyword is near, and keep it only as a weak last resort when one is
  // — so "验证码：2026" still returns 2026 if it's the lone candidate, but a real
  // code always outranks a stray copyright/date year.
  const push = (rawCode: string, baseScore: number, reason: string, boost: number, alnumMax = 0) => {
    const code = normalizeCandidate(rawCode);
    if (!isCodeShape(code, alnumMax)) return;
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
    push(m[1]!, 13, "near_keyword_alnum", keywordBoost(m[0]!), ALNUM_MAX_NEAR_KEYWORD);
  }

  // Alphanumeric codes right before a keyword: "A1B2C3 is your verification code".
  const alnumBeforeKeyword = new RegExp(String.raw`\b([A-Za-z0-9][A-Za-z0-9-]{2,34}[A-Za-z0-9])\b${KEYWORD_CODE_GAP}(?:${KEYWORD_ALT})`, "gi");
  while ((m = alnumBeforeKeyword.exec(text))) {
    push(m[1]!, 12, "near_keyword_alnum", keywordBoost(m[0]!), ALNUM_MAX_NEAR_KEYWORD);
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
  const plain = /\b(\d{4,8})\b/g;

  // Gate the two keyword-free passes on the mail being about a code at all.
  // Reason: ordinary notification mails are full of code-shaped numbers — a ZIP
  // code ("Mountain View, CA 94043"), a street number ("1600 Amphitheatre
  // Parkway"), an order id. Without this gate a Google "you signed in to X with
  // your Google account" notice returns 94043 as the OTP. Any mail that really
  // carries a code mentions 验证码/code/OTP/… somewhere, so the gate costs us
  // nothing on true positives.
  const hasCodeContext = SOFT_CUE.test(text) || KEYWORDS.some((re) => re.test(text));
  if (hasCodeContext) {
    /*
     * Both passes additionally require a keyword *near the number itself*, not
     * merely somewhere in the mail.
     *
     * Reason: these two are the only passes that will match an arbitrary number,
     * so without this they turn "the mail mentions a code" into "any number in
     * the mail is the code". A NodeSeek mail whose real code was a 24-char hex
     * token — too long to match at the time — still contained an unrelated
     * 8-digit number in its HTML, and that number was surfaced as the code:
     * confidently wrong, which costs the user more than an empty result.
     *
     * A number with no keyword beside it is not evidence of anything. Returning
     * nothing is the correct answer.
     */
    while ((m = separatedDigits.exec(text))) {
      const joined = (m[1] || "").replace(/\D/g, "");
      if (joined.length < 4 || joined.length > 8) continue;
      if (isNumericFragment(text, m.index, m[0]!)) continue;
      const ctx = text.slice(Math.max(0, m.index - 24), Math.min(text.length, m.index + 48));
      const boost = keywordBoost(ctx);
      if (boost === 0) continue;
      push(joined, 4, "separated_digits", boost);
    }

    while ((m = plain.exec(text))) {
      if (isNumericFragment(text, m.index, m[0]!)) continue;
      const ctx = text.slice(Math.max(0, m.index - 24), Math.min(text.length, m.index + 48));
      const boost = keywordBoost(ctx);
      if (boost === 0) continue;
      push(m[1]!, 2, "plain_digits", boost);
    }
  }

  // Standalone-line mixed codes (e.g. "54R-RN5" alone under "use the code
  // below to validate your email address"). The near-keyword gap is too tight
  // for the intervening sentence, so only run this when the body already smells
  // like an OTP email. isCodeShape still requires both letters and digits, so
  // letter-only tokens like brand names on their own line are ignored.
  if (KEYWORDS.some((re) => re.test(text))) {
    const standaloneLine =
      /(?:^|\n)\s*([A-Za-z0-9][A-Za-z0-9-]{2,18}[A-Za-z0-9])\s*(?=\n|$)/g;
    while ((m = standaloneLine.exec(text))) {
      // Mixed letters+digits only. Reason: HTML-to-text turns footers into
      // standalone lines ("Copyright⏎2026⏎Design.com"), and a bare number on
      // its own line is not evidence of a code. Digit-only lines are still
      // covered by the plain/separated passes, which score them on context.
      const code = normalizeCandidate(m[1]!);
      if (!/[A-Za-z]/.test(code) || !/\d/.test(code)) continue;
      push(m[1]!, 11, "standalone_line_alnum", 3, ALNUM_MAX_STANDALONE);
    }
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

