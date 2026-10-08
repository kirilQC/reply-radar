// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Re-reading an Email Bison or lemlist thread must not undo what QC has done to it since.
 *
 * Both ingests rebuild each message's raw_data from the platform and upsert it, which used to replace the
 * whole `reply_radar` object: the sentiment, the cached AI draft, the follow-up read and the Slack alert
 * record were wiped on every webhook, sync and inbox refresh, so drafts were paid for again and Slack lost
 * who had sent what. The platform's fields still win (campaign, sender, channel, ids); everything else that
 * was stored is kept. Pure, so tests/ingest-merge.test.mjs drives it.
 */

const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

/** `fresh` messages with the stored reply_radar state of the same message carried over. */
export function keepStoredState(fresh, stored) {
  const byKey = new Map((stored || []).map((row) => [String(row.heyreach_message_id ?? ""), object(row.raw_data)]));
  return (fresh || []).map((message) => {
    const old = byKey.get(String(message.heyreach_message_id ?? ""));
    if (!old) return message;
    const raw = object(message.raw_data);
    return { ...message, raw_data: { ...old, ...raw, reply_radar: { ...object(old.reply_radar), ...object(raw.reply_radar) } } };
  });
}

/**
 * The ids of our own "sent from QC" rows (`<prefix>manual:…`) that the platform's own copy of the same send
 * has now arrived for: an outbound platform message within `windowMs` after it. Those rows are removed so
 * the reply does not show twice in the thread.
 */
export function supersededManualRows(stored, fresh, prefix, windowMs = 30 * 60 * 1000) {
  const platformSends = (fresh || [])
    .filter((message) => message.direction === "outbound" && !String(message.heyreach_message_id ?? "").startsWith(`${prefix}manual:`))
    .map((message) => Date.parse(String(message.sent_at ?? "")))
    .filter((time) => Number.isFinite(time));
  return (stored || [])
    .filter((row) => String(row.heyreach_message_id ?? "").startsWith(`${prefix}manual:`) && row.direction === "outbound")
    .filter((row) => {
      const at = Date.parse(String(row.sent_at ?? ""));
      return Number.isFinite(at) && platformSends.some((time) => time >= at - 60_000 && time - at <= windowMs);
    })
    .map((row) => String(row.id));
}
