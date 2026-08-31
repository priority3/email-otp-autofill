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

  it("does not treat a ZIP / street number in a Google sign-in notice as a code", () => {
    // Regression: this mail carries no OTP at all, yet "Mountain View, CA 94043"
    // yielded 94043 (separated_digits) and "1600 Amphitheatre" yielded 1600.
    // "安全提醒" / "安全技术" must not count as a code cue either.
    const body = [
      "掌控您的 Google 账号数据",
      "you@example.com",
      "",
      "我们向您发送这封邮件，是因为您于 7月28日20:41 使用 Google 账号登录了“proxy001.com”。",
      "这封邮件总结了您共享的信息。目前，您无需采取任何措施。",
      "",
      "“proxy001.com”收到了以下个人资料信息",
      "Example User",
      "姓名和个人资料照片",
      "you@example.com",
      "邮箱",
      "",
      "这封邮件涵盖您在 7月28日20:41 共享的信息",
      "如果想停止使用 Google 账号登录“proxy001.com”，请前往您的 Google 账号。",
      "查看“proxy001.com”的《隐私权政策》和《服务条款》，了解“proxy001.com”会如何处理及保护您的数据。",
      "",
      "使用 Google，安全加倍",
      "为了确保您的数据安全，Google 账号采用了先进的安全技术来保护您的隐私",
      "即使退订此类邮件，您仍会继续收到安全提醒。",
      "",
      "© 2026 Google LLC 1600 Amphitheatre Parkway, Mountain View, CA 94043",
    ].join("\n");
    assert.equal(extractBestOtp(body), null);
    assert.deepEqual(extractOtpCandidates(body), []);
  });

  it("does not mine codes out of marketing tracking URLs", () => {
    // Regression: 15 of 24 real Design.com mails yielded a bogus code. Their
    // subject carries the project's own name ("email otp autofill"), so \bOTP\b
    // matches and every keyword-adjacent pass starts hunting. SendGrid click
    // URLs percent-encode "/" and "+" as "-2F"/"-2B", so the query string is
    // full of code-shaped runs.
    const body = [
      "Lettermark logos for email otp autofill",
      "Grab 85% off your logo today.",
      "View it here ( https://ablink.hello.design.com/ls/click?upn=zdkPX-2B-2FABXKZn-2FujNF3oWANujOB6uO5-2BvlfpaVWO )",
      "Copyright",
      "2026",
      "Design.com.",
    ].join("\n");
    assert.equal(extractBestOtp(body), null);
    const codes = extractOtpCandidates(body).map((c) => c.code);
    assert.ok(!codes.includes("2BvlfpaVWO"), `leaked tracking token: ${codes.join()}`);
    assert.ok(!codes.includes("2026"), `leaked footer year: ${codes.join()}`);
  });

  it("does not mine codes out of a query-string tail left by an unencoded space", () => {
    // Regression: the brand name sits unencoded inside a query value, so URL
    // matching stops at that space and leaves "autofill&code=...&utm_content=
    // ...-20260706-..." in the text. "5666" (from &ckey=5666eced-…) scored 13
    // via near_keyword, outranking everything.
    const body = [
      "Create a website for email otp autofill",
      "Browse beautiful websites here",
      "( https://ablink.hello.design.com/ls/click?upn=PQPZVfg-2BLjdk otp autofill&ckey=5666eced-aaec-433c-abc8-a600030a7206&code=WEBMA&utm_medium=email&utm_content=related-1-20260621-variation )",
    ].join("\n");
    assert.equal(extractBestOtp(body), null);
  });

  it("does not weld an ordinary word to an adjacent number", () => {
    // Regression: "email otp autofill" + "85% off" produced the code
    // "autofill85" (score 16) because the alnum pattern joined groups across a
    // space. Only "-" may join groups now.
    const body = "Minimalist logos for email otp autofill\n85% off your logo + our Minimalist logos.";
    assert.equal(extractBestOtp(body), null);
  });

  it("still finds a real code in a mail that also has tracking links", () => {
    // Guard for the fix above: stripping URLs must not swallow the real code.
    const best = extractBestOtp(
      "验证码：662218，10分钟内有效。\n退订 ( https://u1.ct.sendgrid.net/ls/click?upn=abc-2FnSh-2BvlfpaVWO )"
    );
    assert.equal(best?.code, "662218");
  });

  it("still finds a digits-only code alone on its own line", () => {
    // Guard: the standalone-line pass now requires letters+digits, so a bare
    // numeric code on its own line must still come through the plain pass.
    assert.equal(extractBestOtp("您的验证码如下：\n\n889912\n\n5分钟内有效")?.code, "889912");
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

  it("extracts hyphenated alnum codes on their own line (Google/SaaS style)", () => {
    // Regression: "use the code below to validate your email" + standalone
    // "54R-RN5" was not recognized — no "verification code" keyword, and the
    // near-keyword gap cannot bridge the intervening sentence.
    const body = [
      "Validate your email",
      "Hi,",
      "",
      "Thank you for creating a SpaceXAI account. Please use the code below to validate your email address.",
      "",
      "54R-RN5",
      "If you did not create a new account, please ignore this email.",
      "",
      "SpaceXAI Team",
      "© 2026 X.AI LLC",
      "For questions contact support@x.ai",
    ].join("\n");
    const best = extractBestOtp(body);
    assert.equal(best?.code, "54RRN5");
    assert.ok((best?.score ?? 0) > 2); // must beat a weak © 2026 year candidate
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

describe("opaque hex codes / no confidently-wrong fallback", () => {
  // Regression: NodeSeek mails a 24-char hex token as the code. The old 10-char
  // ceiling on mixed codes dropped it, and the extractor then surfaced an
  // unrelated 8-digit number from elsewhere in the HTML as the code.
  const HEX = "4c91be07d1aa3f620517cdb8";

  it("extracts a long hex code that sits next to a keyword", () => {
    const best = extractBestOtp(`nodeseek邮箱动态验证登录，你的验证码是${HEX}，不要告诉他人`);
    assert.equal(best?.code, HEX);
  });

  it("still rejects a long hex token with no keyword beside it", () => {
    // The gate is the keyword, not the length: an id in a code-flavoured mail
    // must not become the answer.
    assert.equal(extractBestOtp(`Your verification code could not be sent. Request id ${HEX}.`)?.code, undefined);
  });

  it("returns nothing rather than an unrelated number when the real code is unreadable", () => {
    // The decisive case: a code-flavoured mail carrying a stray number far from
    // any keyword. Showing that number would be confidently wrong — worse for
    // the user than showing nothing, because they'd paste it and fail.
    const body = [
      "NodeSeek 邮箱动态验证登录",
      "",
      "Message reference 51352443",
      "",
      "如非本人操作请忽略本邮件。",
    ].join("\n");
    assert.equal(extractBestOtp(body), null);
  });

  it("a bare number stays extractable when a keyword is actually beside it", () => {
    // Guards the opposite failure: the tightened gate must not silence real codes.
    assert.equal(extractBestOtp("NodeSeek 登录\n\n验证码 51352443\n\n请勿泄露")?.code, "51352443");
  });
});

describe("username-shaped tokens are not codes", () => {
  it("does not hand back a username sitting next to the keyword", () => {
    // Reported from production: the popup showed "priority1" as the user's OTP.
    // A keyword followed by a word-with-a-trailing-digit is an account name, a
    // label or a filename — never a verification code.
    assert.equal(extractBestOtp("验证码已发送至 priority1 的邮箱"), null);
  });

  it("rejects the word+number shape that burned us before", () => {
    // "email otp autofill" welded to "85% off" once produced "autofill85".
    assert.equal(extractBestOtp("your verification code autofill85"), null);
  });

  it("one stray digit can never carry a candidate", () => {
    for (const token of ["verification1", "securitycode7", "passcodeX9".replace("X", "")]) {
      assert.equal(extractBestOtp(`验证码 ${token}`), null, `${token} must not be a code`);
    }
  });

  it("still accepts real mixed codes across the density range", () => {
    // Everything the extractor is known to handle must survive the new floor.
    const cases: Array<[string, string]> = [
      ["验证码为: d6ad3e", "d6ad3e"],
      ["your verification code is A1B2C3", "A1B2C3"],
      ["verification code: ABC123", "ABC123"],
      ["您好，你的验证码是7a38ff0ab00ff1780989bfe0，请在10分钟内使用。", "7a38ff0ab00ff1780989bfe0"],
    ];
    for (const [text, want] of cases) {
      assert.equal(extractBestOtp(text)?.code, want, `failed on ${JSON.stringify(text)}`);
    }
  });

  it("pure-digit codes are unaffected by the digit-ratio rule", () => {
    assert.equal(extractBestOtp("验证码 481920")?.code, "481920");
    assert.equal(extractBestOtp("Your verification code is 314159")?.code, "314159");
  });
});

describe("code-word phrasings beyond \"verification code\"", () => {
  it("reads the real Backblaze mail that returned nothing in production", () => {
    // Captured from the user's mailbox after the poller logged otp=no for it.
    // The body says "Backblaze Authorization Code: 473718" — no phrase in the
    // keyword list matched, so the extractor produced zero candidates and the
    // popup stayed empty.
    const body = [
      "Backblaze Authentication",
      "This Backblaze Authorization code is required for security purposes.",
      "Backblaze Authorization Code: 473718",
      "Code expires in 20 minutes.",
      "This is a Backblaze service email | www.backblaze.com",
    ].join("\n");
    assert.equal(extractBestOtp(body)?.code, "473718");
    assert.equal(extractTtlSec(body), 20 * 60);
  });

  it("covers the other <word> code phrasings senders actually use", () => {
    const cases: Array<[string, string]> = [
      ["Here is your GitHub launch code: 771208", "771208"],
      ["Your authentication code is 654321", "654321"],
      ["Your confirmation code: 112233", "112233"],
      ["Enter this access code: 998877", "998877"],
      ["Your auth code is 445566", "445566"],
      ["Your passcode is 334455", "334455"],
      ["动态密码：667788", "667788"],
    ];
    for (const [text, want] of cases) {
      assert.equal(extractBestOtp(text)?.code, want, `failed on ${JSON.stringify(text)}`);
    }
  });

  it("does not fire on an OAuth explainer that merely says \"authorization code\"", () => {
    // The phrase also belongs to OAuth prose. Such mails carry no short code
    // beside it, which is what keeps the addition safe.
    assert.equal(
      extractBestOtp("We use the OAuth 2.0 authorization code flow for our API. See docs section 12345678."),
      null
    );
  });
});
