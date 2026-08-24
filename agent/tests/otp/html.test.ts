import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { otpSourceText, stripHtml } from "../../src/otp/html.js";

describe("stripHtml", () => {
  it("drops style and script blocks entirely", () => {
    const out = stripHtml("<style>.a{color:red}</style>keep<script>var x=1</script>me");
    assert.equal(out.includes("color:red"), false);
    assert.equal(out.includes("var x"), false);
    assert.match(out, /keep/);
    assert.match(out, /me/);
  });

  it("replaces tags with a space so words do not run together", () => {
    assert.match(stripHtml("<p>code</p><p>481920</p>"), /code\s+481920/);
  });

  it("collapses runs of spaces and tabs", () => {
    assert.equal(stripHtml("a  \t  b"), "a b");
  });
});

describe("otpSourceText", () => {
  // Pins the exact assembly the IMAP path used before it moved into this module.
  // Both channels must produce byte-identical input to extractBestOtp, otherwise
  // the same email can yield different codes depending on how it arrived.
  it("joins subject, text and stripped html with newlines in that order", () => {
    assert.equal(
      otpSourceText({ subject: "S", text: "T", html: "<b>H</b>" }),
      "S\nT\n H "
    );
  });

  it("treats missing parts as empty strings, keeping the separators", () => {
    assert.equal(otpSourceText({}), "\n\n");
  });

  it("does not run stripHtml on an empty html value", () => {
    assert.equal(otpSourceText({ subject: "S", text: "T", html: "" }), "S\nT\n");
  });

  it("accepts null parts (mailparser yields false/null for absent fields)", () => {
    assert.equal(otpSourceText({ subject: null, text: null, html: null }), "\n\n");
  });
});
