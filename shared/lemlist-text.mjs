// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { cleanEmailBody, htmlToText, stripQuoted } from "./email-text.mjs";

/**
 * A lemlist message's words, as the inbox and Slack show them. Pure, so tests/lemlist.test.mjs drives it.
 *
 * Emails keep their body in `message` (HTML with the quoted thread inside, cut before flattening, then the
 * signature cleaned as for Email Bison). LinkedIn messages keep theirs in `text` (plain), and sometimes in
 * `message`: whichever is filled is used. Reading only `message` left every LinkedIn reply empty.
 */
export function lemlistBody(message, direction) {
  const raw = [message?.message, message?.text, message?.body].map((value) => (typeof value === "string" ? value : "")).find((value) => value.trim()) ?? "";
  const html = raw.replace(/<div[^>]*class="[^"]*gmail_quote[\s\S]*$/i, "").replace(/<blockquote[\s\S]*$/i, "");
  const plain = /<[a-z][\s\S]*>/i.test(html) ? htmlToText(html) : html.trim();
  const isEmail = String(message?.type ?? "").startsWith("emails");
  if (direction !== "inbound" || !isEmail) return plain;
  return cleanEmailBody(stripQuoted(plain)) || stripQuoted(plain);
}
