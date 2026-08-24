/*
 * Shared HTML→text reduction for OTP extraction.
 *
 * Moved verbatim out of providers/imap.ts so the IMAP path and the inbound
 * webhook path feed byte-identical text into extractBestOtp. Two copies would
 * drift and make the same email yield different codes depending on which
 * channel it arrived through.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ");
}

/*
 * Assemble the text handed to extractBestOtp. Callers must not build this
 * string themselves — the field order affects keyword scoring in extract.ts,
 * so both channels have to use this function.
 */
export function otpSourceText(parts: {
  subject?: string | null;
  text?: string | null;
  html?: string | null;
}): string {
  const subject = parts.subject ?? "";
  const text = parts.text ?? "";
  const html = parts.html ? stripHtml(String(parts.html)) : "";
  return `${subject}\n${text}\n${html}`;
}
