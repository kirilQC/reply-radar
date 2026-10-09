// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/** Pure helpers for pushing replies into a CRM or sheet (app/lib/crm-push.ts). tests/crm-push.test.mjs drives them. */

const text = (value) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

/** "https://www.linkedin.com/in/Jane-Doe-12/?x=1" → "jane-doe-12". Sales Navigator and other URLs keep a normalized form. */
export function linkedinKey(url) {
  const raw = text(url);
  if (!raw) return "";
  const slug = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(raw)?.[1];
  if (slug) {
    try { return decodeURIComponent(slug).toLowerCase(); } catch { return slug.toLowerCase(); }
  }
  return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
}


/** The conversation as readable text, newest messages kept when it is too long for the destination. */
/**
 * @param {{ channel: string; campaign: string; sender: string; messages: Array<{ author: string; body: string; sentAt: string }> }} record
 * @param {number} maxChars
 * @param {"html" | "markdown" | "plain"} format
 * @returns {string}
 */
export function conversationText(record, maxChars, format) {
  const when = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  };
  const escape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const line = (message) => {
    if (format === "html") return `<p><strong>${escape(message.author)}</strong> <em>${escape(when(message.sentAt))}</em><br>${escape(message.body).replace(/\n/g, "<br>")}</p>`;
    if (format === "markdown") return `**${message.author}** · ${when(message.sentAt)}\n\n${message.body}`;
    return `${message.author} (${when(message.sentAt)}): ${message.body}`;
  };
  const channel = record.channel === "email" ? "Email" : "LinkedIn";
  const header = format === "html"
    ? `<p><strong>${channel} conversation · QC Growth</strong><br>Campaign: ${escape(record.campaign)}${record.sender ? ` · Sender: ${escape(record.sender)}` : ""}</p>`
    : format === "markdown"
      ? `**${channel} conversation · QC Growth**\nCampaign: ${record.campaign}${record.sender ? ` · Sender: ${record.sender}` : ""}`
      : `${channel} conversation · QC Growth · Campaign: ${record.campaign}${record.sender ? ` · Sender: ${record.sender}` : ""}`;
  const separator = format === "html" ? "" : "\n\n";
  let shown = record.messages;
  let body = [header, ...shown.map(line)].join(separator);
  while (body.length > maxChars && shown.length > 1) {
    shown = shown.slice(1);
    body = [header, format === "html" ? "<p><em>Earlier messages not shown.</em></p>" : "(earlier messages not shown)", ...shown.map(line)].join(separator);
  }
  return body.slice(0, maxChars);
}

