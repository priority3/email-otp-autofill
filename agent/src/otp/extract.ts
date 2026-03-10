export type OtpCandidate = {
  code: string;
  score: number;
  reason: string;
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
  return candidates.length ? candidates[0]! : null;
}

