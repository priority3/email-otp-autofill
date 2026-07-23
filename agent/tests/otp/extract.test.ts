import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractBestOtp, extractOtpCandidates, extractTtlSec } from "../../src/otp/extract.js";

describe("extractOtpCandidates / extractBestOtp", () => {
  it("extracts digits right after a Chinese keyword", () => {
    const best = extractBestOtp("您的验证码：123456，请勿泄露给他人。");
    assert.equal(best?.code, "123456");
    assert.match(best!.reason, /^near_keyword/);
  });

  it("extracts digits right after an English keyword", () => {
    const best = extractBestOtp("Your verification code is 752740.");
    assert.equal(best?.code, "752740");
  });

  it("extracts digits right before a keyword", () => {
    const best = extractBestOtp("752740 is your verification code.");
    assert.equal(best?.code, "752740");
  });

  it("extracts Outlook-style 安全代码 / 单次代码 phrasings", () => {
    assert.equal(extractBestOtp("Microsoft 帐户安全代码: 481923")?.code, "481923");
    assert.equal(extractBestOtp("单次代码：904471")?.code, "904471");
  });

  it("extracts alphanumeric codes only in keyword context", () => {
    const best = extractBestOtp("验证码为: d6ad3e，10分钟内有效");
    assert.equal(best?.code, "d6ad3e");
    // No keyword nearby → a random hex-ish token must NOT be treated as a code.
    assert.equal(extractBestOtp("session token a1b2c3 issued for your request"), null);
  });

  it("extracts alphanumeric codes before a keyword", () => {
    const best = extractBestOtp("A1B2C3 is your verification code");
    assert.equal(best?.code, "A1B2C3");
  });

  it("joins space/dash separated digit groups", () => {
    const best = extractBestOtp("验证码 123 456 请在页面输入");
    assert.equal(best?.code, "123456");
  });

  it("prefers the real code over a copyright year", () => {
    const body = "Your login code is 481923.\n© 2026 Example Corp. All rights reserved.";
    const best = extractBestOtp(body);
    assert.equal(best?.code, "481923");
    // The year may survive as a weak last-resort candidate (keyword within its
    // context window) but must stay at the floor score, far below the real code.
    const year = extractOtpCandidates(body).find((c) => c.code === "2026");
    if (year) assert.ok(year.score < best!.score);
  });

  it("drops a bare year with no keyword nearby", () => {
    assert.equal(extractBestOtp("The annual meeting is planned for 2026."), null);
  });

  it("keeps a year-shaped code as weak last resort when a keyword is near", () => {
    const best = extractBestOtp("验证码：2026");
    assert.equal(best?.code, "2026");
    assert.equal(best?.score, 2);
  });

  it("does not slice a code out of an email address or a longer number", () => {
    // Regression: "18320521" was extracted from a mentioned mailbox address.
    assert.equal(extractBestOtp("New sign-in alert for 1832052104@qq.com"), null);
    assert.equal(extractBestOtp("Your order number is 123456789012."), null);
  });

  it("does not slice digits out of a hex app id in a GitHub OAuth notice", () => {
    // Regression: "2230" was extracted from applications/6efe458dfe2230acceea
    // via the separated_digits pass (no word boundary inside hex tokens).
    const body = [
      "Hey priority3!",
      "",
      "A third-party OAuth application (LeetCode) with user:email scopes was recently authorized to access your account.",
      "Visit https://github.com/settings/connections/applications/6efe458dfe2230acceea for more information.",
      "",
      "To see this and other security events for your account, visit https://github.com/settings/security-log",
      "",
      "If you run into problems, please contact support by visiting https://github.com/contact",
      "",
      "Thanks,",
      "The GitHub Team",
    ].join("\n");
    assert.equal(extractBestOtp(body), null);
    assert.ok(!extractOtpCandidates(body).some((c) => c.code === "2230"));
  });

  it("returns null when nothing code-shaped exists", () => {
    assert.equal(extractBestOtp("Hello, thanks for reaching out!"), null);
  });

  it("de-dupes repeated codes keeping the best score", () => {
    const body = "验证码：556677。再次提醒，556677 十分钟内有效。";
    const candidates = extractOtpCandidates(body).filter((c) => c.code === "556677");
    assert.equal(candidates.length, 1);
  });

  it("ranks the keyword-adjacent code above stray plain digits", () => {
    const body = "工单编号 8842。您的验证码是 337201。";
    assert.equal(extractBestOtp(body)?.code, "337201");
  });
});

describe("extractTtlSec", () => {
  it("parses Chinese minute windows", () => {
    assert.equal(extractTtlSec("验证码 654321，请在 5 分钟内完成验证。"), 300);
  });

  it("parses English minute/second/hour windows", () => {
    assert.equal(extractTtlSec("This code is valid for 10 minutes."), 600);
    assert.equal(extractTtlSec("Your code expires in 30 seconds."), 30);
    assert.equal(extractTtlSec("有效期 2 小时，请尽快使用。"), 7200);
  });

  it("ignores durations without a validity cue", () => {
    assert.equal(extractTtlSec("I will call you back in 5 minutes."), null);
  });

  it("rejects windows outside the sane 10s–24h range", () => {
    assert.equal(extractTtlSec("The link is valid for 48 hours."), null);
    assert.equal(extractTtlSec("Code valid for 5 seconds."), null);
  });

  it("is attached to the best candidate by extractBestOtp", () => {
    const best = extractBestOtp("您的验证码：998877，5分钟内有效。");
    assert.equal(best?.code, "998877");
    assert.equal(best?.ttlSec, 300);
  });
});
