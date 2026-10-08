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

/** Lines and markers that start an email signature or a phone/app footer. */
const SIGNATURE_START = [
  /(^|\s)-{3,}(\s|$)/, // "---" (Gmail's signature rule, often flattened onto the last line)
  /^--\s*$/m, // RFC "-- " on its own line
  /^(sent from my (iphone|ipad|android|phone|samsung|mobile)|get outlook for (ios|android)|sent via )/im,
];

/**
 * A reply with the signature junk cut out: Gmail's inline signature images ("[https://lh6.googleusercontent…]"),
 * linked social icons ("<http://www.facebook.com/…>"), and everything from the signature marker on, so the
 * inbox and Slack show what the person wrote. Their name and title are lost with the signature, which is fine:
 * the card already says who they are.
 */
/**
 * A closing line on its own ("Best,", "Thank you,", "Cheers") ends the message: what follows is the sender's
 * name and then their signature block (title, address, phone, links). The name is kept, the block is not.
 */
const SIGN_OFF = /^(?:thanks(?: again| so much)?|thank you(?: so much)?|many thanks|best(?: regards| wishes)?|all the best|kind regards|warm regards|warmly|regards|cheers|sincerely|talk soon|speak soon)[\s,.!]*$/i;

function cutAtSignOff(body) {
  const lines = body.split("\n");
  for (let i = 1; i < lines.length; i += 1) {
    if (!SIGN_OFF.test(lines[i].trim())) continue;
    // Only after something was said: a reply that is just "Thanks!" keeps it.
    if (!lines.slice(0, i).join(" ").trim()) return body;
    let end = i + 1;
    // The name under it, when it looks like one (short, no digits, no address), stays with the sign-off.
    while (end < lines.length && !lines[end].trim()) end += 1;
    const name = (lines[end] ?? "").trim();
    const keepName = name && name.length <= 40 && !/[\d@:/|]/.test(name) && name.split(/\s+/).length <= 4;
    return lines.slice(0, keepName ? end + 1 : i + 1).join("\n");
  }
  return body;
}

export function cleanEmailBody(text) {
  let body = String(text ?? "")
    .replace(/\r\n/g, "\n");
  // Gmail's text version writes each signature image as "[image: understood.logo]". The first one after any
  // words starts the signature, so everything from it on goes; any stray ones left are removed.
  const image = /\[image:[^\]]*\]/i.exec(body);
  if (image && image.index > 0 && body.slice(0, image.index).trim()) body = body.slice(0, image.index);
  body = body
    .replace(/\[image:[^\]]*\]/gi, " ")
    .replace(/\[(?:cid:|https?:\/\/)[^\]]*\]/gi, " ") // [https://lh6.googleusercontent.com/…] and [cid:image001.png]
    .replace(/<(?:https?:\/\/|mailto:)[^>]*>/gi, " "); // <http://www.facebook.com/kurufootwear/>
  body = cutAtSignOff(body);
  for (const marker of SIGNATURE_START) {
    const match = marker.exec(body);
    // Only a marker after some words counts: a reply that opens with "---" keeps its text.
    if (match && match.index > 0 && body.slice(0, match.index).trim()) body = body.slice(0, match.index);
  }
  return body
    .split("\n")
    .filter((line) => !/^\s*(https?:\/\/\S+|www\.\S+)\s*$/i.test(line)) // a line that is only a link
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The person-written part of a reply body, from whichever of text and HTML Email Bison gave us. */
export function replyText(reply) {
  const plain = String(reply?.text_body ?? "").trim();
  const words = cleanEmailBody(stripQuoted(plain || htmlToText(reply?.html_body)));
  return words || stripQuoted(plain || htmlToText(reply?.html_body));
}

/** The conversation key for an email thread: one per Email Bison lead. Never a HeyReach id. */
export const emailConversationKey = (bisonLeadId) => `bison:${bisonLeadId}`;
export const isEmailConversationKey = (key) => String(key ?? "").startsWith("bison:");

/**
 * Whether a reply is an out-of-office or other automatic answer, which never belongs in the inbox. Email
 * Bison's own flag first; then the subject a mail client puts on one; then, for a short message only, the
 * wording of one ("I am traveling until 9 October", "out of the office until"). A long reply that happens to
 * mention travel is a real reply and is kept.
 */
const AUTO_SUBJECT = /^\s*(automatic reply|auto(matic)?[\s-]?reply|autoreply|out of (the )?office|ooo\b|abwesenheit|r[ée]ponse automatique|respuesta autom[aá]tica|delivery status notification|undeliverable)/i;
const AUTO_BODY = [
  /\b(out of (the )?office|ooo)\b/i,
  /\b(i am|i'm|i will be|i'll be)\s+(currently\s+)?(traveling|travelling|away|on (annual |parental |maternity |paternity )?leave|on vacation|on holiday|out)\b[^.]{0,80}\b(until|through|returning|back on|back in|from)\b/i,
  /\blimited (access to|ability to check) (my )?e-?mail\b/i,
  /\b(will|shall) (respond|reply|get back to you)[^.]{0,40}\b(upon|when|after) (my|i) return/i,
  /\bthis (is an )?(automatic|automated|auto-generated) (reply|response|message)\b/i,
  /\bno longer (with|at|working (at|for))\b/i,
];
export function isAutoReply(reply) {
  if (reply?.automated_reply === true || reply?.automated === true) return true;
  if (AUTO_SUBJECT.test(String(reply?.subject ?? reply?.email_subject ?? ""))) return true;
  const body = replyText(reply);
  return body.length <= 700 && AUTO_BODY.some((pattern) => pattern.test(body));
}

/** A message in a lead's Bison history that we sent (a reply from the master inbox), not one they sent us. */
export const isOurEmail = (reply) => String(reply?.folder ?? "").toLowerCase() === "sent" || /outgoing/i.test(String(reply?.type ?? ""));
