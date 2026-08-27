import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Guard against a poller failing in silence.
 *
 * The Outlook provider used to run `pollOnce().catch(() => {})` and store every
 * error in a private `lastError` field with no log call. A revoked token, a
 * dead proxy and a healthy-but-quiet mailbox all produced byte-identical logs:
 * nothing at all. Diagnosing "I'm not getting codes" meant guessing.
 *
 * A runtime test can't cover this — it needs the failure to actually happen —
 * so the shape is enforced at the source level instead.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

const POLLERS = ["providers/outlook-oauth.ts", "providers/gmail-oauth.ts"];

describe("poller error visibility", () => {
  it("no poller discards errors with an empty catch", () => {
    const offenders: string[] = [];

    for (const rel of POLLERS) {
      readFileSync(path.join(SRC, rel), "utf8")
        .split("\n")
        .forEach((line, i) => {
          // Comments may quote the banned pattern to explain why it's banned.
          if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return;
          // `.catch(() => {})` and friends — a caught error that goes nowhere.
          if (/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(line)) {
            offenders.push(`${rel}:${i + 1} — ${line.trim()}`);
          }
        });
    }

    assert.deepEqual(offenders, [], `errors must not be silently discarded:\n${offenders.join("\n")}`);
  });

  it("the scanner catches the pattern it is meant to catch", () => {
    // Without this, a broken regex would make the test above pass vacuously.
    const sample = "void this.pollOnce().catch(() => {});";
    assert.ok(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(sample));
  });

  it("the Outlook poller logs its failures", () => {
    const src = readFileSync(path.join(SRC, "providers/outlook-oauth.ts"), "utf8");
    assert.match(src, /this\.log\.fail\(/, "pollOnce must report failures through the logger");
    assert.match(src, /needs re-authorizing/, "a revoked credential must be called out explicitly");
  });
});
