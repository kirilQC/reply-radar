// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Email bodies as the inbox shows them: plain text, and for a reply only what the person wrote this time.
 *
 * A reply's text body carries the whole quoted thread under it ("On Tue, Oct 7, Amanda wrote: > …"), which in
 * an inbox card reads as the lead repeating our pitch back. The quoted part is cut at the first line that
 * starts it. The campaign email we sent is HTML; it is flattened to text with its paragraphs kept. Pure, so
 * tests/email-channel.test.mjs drives it with real Email Bison bodies.
 */

const ENTITIES = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&rsquo;": "’", "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”", "&hellip;": "…" };

/** HTML to readable text: block ends become line breaks, tags go, entities are decoded, spacing tidied. */
export function htmlToText(html) {
  const text = String(html ?? "")
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? (/^&#(\d+);$/.test(entity) ? String.fromCharCode(Number(entity.slice(2, -1))) : entity));
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Lines that open the quoted history under a reply, in the forms the common mail clients write. */
const QUOTE_START = [
  /^on .{3,200}wrote:\s*$/i, // Gmail / Apple Mail: "On Tue, Oct 7, 2026 at 9:00 AM Amanda <a@x.com> wrote:"
  /^-{2,}\s*original message\s*-{2,}/i, // Outlook
  /^from:\s.+$/i, // Outlook's header block
  /^_{5,}\s*$/, // Outlook's rule above it
  /^le .{3,200}a écrit\s*:\s*$/i,
  /^am .{3,200}schrieb .{0,80}:\s*$/i,
];

/** A reply with the quoted thread under it removed. Falls back to the whole text if nothing is left. */
export function stripQuoted(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    // Gmail sometimes wraps the "On … wrote:" line in two; join it with the next before testing.
    const joined = `${line} ${String(lines[i + 1] ?? "").trim()}`;
    if (QUOTE_START.some((pattern) => pattern.test(line)) || (/^on /i.test(line) && /wrote:\s*$/i.test(joined))) break;
    if (line.startsWith(">")) break;
    out.push(lines[i]);
  }
  const kept = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return kept || String(text ?? "").trim();
}

/** The person-written part of a reply body, from whichever of text and HTML Email Bison gave us. */
export function replyText(reply) {
  const plain = String(reply?.text_body ?? "").trim();
  return stripQuoted(plain || htmlToText(reply?.html_body));
}

/** The conversation key for an email thread: one per Email Bison lead. Never a HeyReach id. */
export const emailConversationKey = (bisonLeadId) => `bison:${bisonLeadId}`;
export const isEmailConversationKey = (key) => String(key ?? "").startsWith("bison:");
