import { SHARE_EMAILS_MAX } from "../api/markets";

/** One address: no spaces, one "@", a dotted domain. The service checks again; this only catches typing mistakes. */
const PLAUSIBLE = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;

export interface ParsedEmails {
  /** Lower case, without duplicates, in the order typed. */
  emails: string[];
  /** The entries that are not addresses. */
  invalid: string[];
}

/** Splits what a person typed or pasted (comma, semicolon, space or line separated) into addresses. */
export function parseEmails(text: string): ParsedEmails {
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const address = part.trim().toLowerCase();
    if (address === "" || seen.has(address)) continue;
    seen.add(address);
    if (address.length <= 254 && PLAUSIBLE.test(address)) emails.push(address);
    else invalid.push(part.trim());
  }
  return { emails, invalid };
}

/** The reason the list cannot be sent, or null. */
export function emailProblem(parsed: ParsedEmails): string | null {
  if (parsed.invalid.length > 0) return `These are not e-mail addresses: ${parsed.invalid.join(", ")}.`;
  if (parsed.emails.length === 0) return "Enter at least one e-mail address.";
  if (parsed.emails.length > SHARE_EMAILS_MAX) return `A link can list at most ${SHARE_EMAILS_MAX} addresses.`;
  return null;
}
