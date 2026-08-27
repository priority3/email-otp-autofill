import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Guard against writing mail content into the logs.
 *
 * The Gmail provider used to log `message: ${subject} | OTP: ${best.code}` on
 * every processed message. On a shared instance those logs hold other people's
 * subject lines and live verification codes, readable by anyone who can run
 * `docker logs`. This scans the source so the pattern cannot come back
 * unnoticed — a runtime test would only catch it if the right mail arrived.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Interpolations that would put mail content or a credential into a log line.
const FORBIDDEN = [
  { name: "subject", re: /\$\{[^}]*\bsubject\b[^}]*\}/ },
  { name: "otp code", re: /\$\{[^}]*\b(?:best|otp|item)\??\.code\b[^}]*\}/ },
  { name: "message body", re: /\$\{[^}]*\b(?:bodyText|text|html|raw)\b[^}]*\}/ },
  { name: "password", re: /\$\{[^}]*\b(?:pass|password|authCode|secret)\b[^}]*\}/ },
];

describe("log hygiene", () => {
  it("no console call interpolates mail content or a credential", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/console\.(log|info|warn|error|debug)/.test(line)) return;
        for (const rule of FORBIDDEN) {
          if (rule.re.test(line)) {
            offenders.push(`${path.relative(SRC, file)}:${i + 1} logs ${rule.name} — ${line.trim()}`);
          }
        }
      });
    }

    assert.deepEqual(offenders, [], `mail content must not be logged:\n${offenders.join("\n")}`);
  });

  it("the scanner actually catches the pattern it is meant to catch", () => {
    // Without this, a broken regex would make the test above pass vacuously.
    const sample = 'console.log(`[gmail-poll] message: ${subject} | OTP: ${best.code}`);';
    assert.ok(
      FORBIDDEN.some((r) => r.re.test(sample)),
      "the historical offending line must still be detected"
    );
  });
});
